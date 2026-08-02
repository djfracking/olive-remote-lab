import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import {
  deriveStableUpnpIdentity,
  parseUpnpDeviceDescription,
  type UpnpDeviceDescription,
  type UpnpServiceDescription,
} from "@olive-remote-lab/olive-client";
import { LocalHttpTransport } from "./transport.js";

const SEARCH_TARGETS = ["upnp:rootdevice", "urn:schemas-upnp-org:device:MediaServer:1"] as const;
const KNOWN_PATHS = ["/", "/maestro.php", "/index.php"] as const;
const LIKELY_PORTS = [80, 8163] as const;

export interface DiscoveryCandidate {
  address: string;
  port: number;
  name: string;
  deviceId?: string;
  udn?: string;
  usn?: string;
  model?: string;
  manufacturer?: string;
  /** @deprecated Use descriptionUrl. */
  description?: string;
  descriptionUrl?: string;
  descriptionUrls?: string[];
  source: "ssdp" | "subnet";
  confidence: "high" | "possible";
  evidence: string[];
  services?: readonly UpnpServiceDescription[];
  serviceTypes?: string[];
  approvedServiceDeviceIds?: string[];
}

interface SsdpReply { address: string; headers: Record<string, string> }

function parseSsdp(message: Buffer, address: string): SsdpReply {
  const lines = message.toString("utf8").split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { address, headers };
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

function oliveEvidence(...values: Array<string | undefined>): string[] {
  const labels = ["manufacturer", "model", "friendly name", "server", "web response"];
  return values.flatMap((value, index) =>
    value && /olive|maestro|4hd|3hd|5hd|6hd|opus|melody|symphony|musica/i.test(value)
      ? [`${labels[index]}: ${value.slice(0, 120)}`]
      : []);
}

async function ssdpSearch(timeoutMs = 1_800): Promise<SsdpReply[]> {
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const replies = new Map<string, SsdpReply>();
  socket.on("message", (message, remote) => {
    const parsed = parseSsdp(message, remote.address);
    const key = `${remote.address}|${parsed.headers.location ?? parsed.headers.usn ?? message.toString("hex").slice(0, 20)}`;
    replies.set(key, parsed);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, () => {
      for (const st of SEARCH_TARGETS) {
        const payload = Buffer.from([
          "M-SEARCH * HTTP/1.1", "HOST: 239.255.255.250:1900", 'MAN: "ssdp:discover"', "MX: 1", `ST: ${st}`, "", "",
        ].join("\r\n"));
        socket.send(payload, 1900, "239.255.255.250");
      }
      setTimeout(resolve, timeoutMs);
    });
  }).finally(() => socket.close());
  return [...replies.values()];
}

interface InspectedDescription {
  reply: SsdpReply;
  xml: string;
  parsed: UpnpDeviceDescription | null;
}

function canonicalDescription(descriptions: readonly InspectedDescription[]): InspectedDescription | undefined {
  return [...descriptions].sort((left, right) => {
    const score = (entry: InspectedDescription) => {
      const rootType = entry.parsed?.rootDevice.deviceType ?? "";
      const services = entry.parsed?.services ?? [];
      return (/device:MediaServer:/i.test(entry.reply.headers.st ?? "") ? 8 : 0)
        + (/device:MediaServer:/i.test(rootType) ? 4 : 0)
        + (services.some((service) => /:service:ContentDirectory:/i.test(service.serviceType)) ? 2 : 0)
        + (/rootdevice/i.test(entry.reply.headers.st ?? "") ? 1 : 0);
    };
    return score(right) - score(left);
  })[0];
}

function aggregateServices(descriptions: readonly InspectedDescription[]): UpnpServiceDescription[] {
  const services = descriptions.flatMap((entry) => [...(entry.parsed?.services ?? [])]);
  return [...new Map(services.map((service) => [
    `${service.serviceType}|${service.serviceId}|${service.controlUrl ?? service.rawControlUrl}|${service.deviceUdn ?? ""}`,
    service,
  ])).values()];
}

async function inspectSsdp(replies: SsdpReply[]): Promise<DiscoveryCandidate[]> {
  const transport = new LocalHttpTransport();
  const replyGroups = new Map<string, SsdpReply[]>();
  for (const reply of replies) {
    const group = replyGroups.get(reply.address) ?? [];
    group.push(reply);
    replyGroups.set(reply.address, group);
  }
  const candidates = await Promise.all([...replyGroups.values()].map(async (group): Promise<DiscoveryCandidate | null> => {
    const uniqueReplies = [...new Map(group
      .filter((reply) => Boolean(reply.headers.location))
      .map((reply) => [`${reply.headers.location}|${reply.headers.usn ?? ""}`, reply])).values()];
    const descriptions = await Promise.all(uniqueReplies.map(async (reply): Promise<InspectedDescription> => {
      const location = reply.headers.location ?? "";
      let xml = "";
      let parsed: UpnpDeviceDescription | null = null;
      try {
        xml = (await transport.request({ method: "GET", url: location, timeoutMs: 1_200 })).body;
        parsed = parseUpnpDeviceDescription(xml, {
          descriptionUrl: location,
          ...(reply.headers.usn ? { ssdpUsn: reply.headers.usn } : {}),
        });
      } catch { /* retain SSDP metadata */ }
      return { reply, xml, parsed };
    }));
    const fallbackReply = group[0];
    const canonical = canonicalDescription(descriptions)
      ?? (fallbackReply ? { reply: fallbackReply, xml: "", parsed: null } : undefined);
    if (!canonical) return null;
    const manufacturer = canonical.parsed?.rootDevice.manufacturer || xmlValue(canonical.xml, "manufacturer");
    const model = canonical.parsed?.rootDevice.modelName || xmlValue(canonical.xml, "modelName");
    const friendlyName = canonical.parsed?.rootDevice.friendlyName || xmlValue(canonical.xml, "friendlyName");
    const evidence = oliveEvidence(
      manufacturer,
      model,
      friendlyName,
      group.map((reply) => reply.headers.server).filter(Boolean).join(" · "),
    );
    if (!evidence.length) return null;
    // SSDP LOCATION commonly points at the UPnP media service (for example
    // port 49154), not the controller UI. Only expose a verified controller
    // port from the conservative 80/8163 allow-list.
    const webCandidate = await probeHost(canonical.reply.address);
    const trustedDescriptions = descriptions.filter((entry) => entry === canonical || oliveEvidence(
      entry.parsed?.rootDevice.manufacturer || xmlValue(entry.xml, "manufacturer"),
      entry.parsed?.rootDevice.modelName || xmlValue(entry.xml, "modelName"),
      entry.parsed?.rootDevice.friendlyName || xmlValue(entry.xml, "friendlyName"),
    ).length > 0);
    const orderedDescriptions = [
      canonical,
      ...trustedDescriptions.filter((entry) => entry !== canonical),
    ];
    const services = aggregateServices(orderedDescriptions);
    const approvedServiceDeviceIds = [...new Set(services
      .map((service) => service.deviceUdn?.trim())
      .filter((value): value is string => Boolean(value)))];
    const descriptionUrls = [...new Set(orderedDescriptions.map((entry) => entry.reply.headers.location).filter((value): value is string => Boolean(value)))];
    const usn = canonical.reply.headers.usn;
    const deviceId = canonical.parsed?.stableIdentity
      ?? deriveStableUpnpIdentity({ udn: canonical.parsed?.udn ?? null, usn: usn ?? null });
    const descriptionUrl = canonical.reply.headers.location;
    return {
      address: canonical.reply.address,
      port: webCandidate?.port ?? 80,
      name: friendlyName ?? model ?? `Possible device at ${canonical.reply.address}`,
      ...(deviceId ? { deviceId } : {}),
      ...(canonical.parsed?.udn ? { udn: canonical.parsed.udn } : {}),
      ...(usn ? { usn } : {}),
      ...(model ? { model } : {}),
      ...(manufacturer ? { manufacturer } : {}),
      ...(descriptionUrl ? { description: descriptionUrl, descriptionUrl } : {}),
      ...(descriptionUrls.length ? { descriptionUrls } : {}),
      source: "ssdp",
      confidence: evidence.length >= 2 ? "high" : "possible",
      evidence: [...evidence, ...(webCandidate?.evidence ?? [])],
      ...(services.length ? {
        services,
        serviceTypes: [...new Set(services.map((service) => service.serviceType))],
        approvedServiceDeviceIds,
      } : {}),
    };
  }));
  return candidates.filter((candidate): candidate is DiscoveryCandidate => candidate !== null);
}

function activePrivate24(): { address: string; prefix: string } | null {
  const choices = Object.entries(networkInterfaces()).flatMap(([name, records]) =>
    (records ?? []).filter((record) => record.family === "IPv4" && !record.internal && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(record.address))
      .map((record) => ({ name, address: record.address, prefix: record.address.split(".").slice(0, 3).join(".") })));
  const preferred = choices.find(({ name }) => /^(en0|en1|eth0|wlan0)$/i.test(name));
  return preferred ?? choices[0] ?? null;
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) output[index] = await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

async function probeHost(address: string): Promise<DiscoveryCandidate | null> {
  const transport = new LocalHttpTransport();
  for (const port of LIKELY_PORTS) {
    let serverHeader = "";
    for (const path of KNOWN_PATHS) {
      try {
        const response = await transport.request({ method: "GET", url: `http://${address}:${port}${path}`, timeoutMs: 450 });
        serverHeader ||= response.headers.server ?? "";
        const evidence = oliveEvidence(undefined, undefined, undefined, serverHeader, response.body);
        if (evidence.length) {
          return {
            address, port, name: `Possible music server at ${address}`, source: "subnet",
            confidence: evidence.some((item) => /olive|maestro/i.test(item)) ? "high" : "possible", evidence,
          };
        }
      } catch { /* offline host or closed port */ }
    }
  }
  return null;
}

export async function discoverOliveDevices(): Promise<{ candidates: DiscoveryCandidate[]; subnet?: string; ssdpResponses: number }> {
  const replies = await ssdpSearch();
  const ssdpCandidates = await inspectSsdp(replies);
  if (ssdpCandidates.length) return { candidates: ssdpCandidates, ssdpResponses: replies.length };
  const active = activePrivate24();
  if (!active) return { candidates: [], ssdpResponses: replies.length };
  const addresses = Array.from({ length: 254 }, (_, index) => `${active.prefix}.${index + 1}`).filter((ip) => ip !== active.address);
  const scanned = await mapLimit(addresses, 18, probeHost);
  return {
    candidates: scanned.filter((candidate): candidate is DiscoveryCandidate => candidate !== null),
    subnet: `${active.prefix}.0/24`,
    ssdpResponses: replies.length,
  };
}
