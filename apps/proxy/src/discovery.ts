import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { LocalHttpTransport } from "./transport.js";

const SEARCH_TARGETS = ["upnp:rootdevice", "urn:schemas-upnp-org:device:MediaServer:1"] as const;
const KNOWN_PATHS = ["/", "/maestro.php", "/index.php"] as const;
const LIKELY_PORTS = [80, 8163] as const;

export interface DiscoveryCandidate {
  address: string;
  port: number;
  name: string;
  model?: string;
  manufacturer?: string;
  description?: string;
  source: "ssdp" | "subnet";
  confidence: "high" | "possible";
  evidence: string[];
  services?: string[];
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

function serviceTypes(xml: string): string[] {
  return [...xml.matchAll(/<serviceType>([^<]+)<\/serviceType>/gi)].map((match) => match[1]?.trim()).filter((item): item is string => Boolean(item));
}

function oliveEvidence(...values: Array<string | undefined>): string[] {
  const labels = ["manufacturer", "model", "friendly name", "server", "web response"];
  return values.flatMap((value, index) => value && /olive|maestro|4hd|3hd|6hd|opust|melody/i.test(value) ? [`${labels[index]}: ${value.slice(0, 120)}`] : []);
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

async function inspectSsdp(replies: SsdpReply[]): Promise<DiscoveryCandidate[]> {
  const transport = new LocalHttpTransport();
  const uniqueReplies = [...new Map(replies.map((reply) => [reply.address, reply])).values()];
  const candidates = await Promise.all(uniqueReplies.map(async (reply): Promise<DiscoveryCandidate | null> => {
    const location = reply.headers.location;
    let xml = "";
    if (location) {
      try { xml = (await transport.request({ method: "GET", url: location, timeoutMs: 1_200 })).body; } catch { /* retain SSDP metadata */ }
    }
    const manufacturer = xmlValue(xml, "manufacturer");
    const model = xmlValue(xml, "modelName");
    const friendlyName = xmlValue(xml, "friendlyName");
    const evidence = oliveEvidence(manufacturer, model, friendlyName, reply.headers.server);
    if (!evidence.length) return null;
    // SSDP LOCATION commonly points at the UPnP media service (for example
    // port 49154), not the controller UI. Only expose a verified controller
    // port from the conservative 80/8163 allow-list.
    const webCandidate = await probeHost(reply.address);
    return {
      address: reply.address,
      port: webCandidate?.port ?? 80,
      name: friendlyName ?? model ?? `Possible device at ${reply.address}`,
      ...(model ? { model } : {}),
      ...(manufacturer ? { manufacturer } : {}),
      ...(location ? { description: location } : {}),
      source: "ssdp",
      confidence: evidence.length >= 2 ? "high" : "possible",
      evidence: [...evidence, ...(webCandidate?.evidence ?? [])],
      services: serviceTypes(xml),
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
