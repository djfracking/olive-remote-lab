import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import {
  OliveCompatibilityClient,
  OliveUpnpClient,
  buildOliveUpnpSearchCriteria,
  capabilitiesForModel,
  deriveStableUpnpIdentity,
  detectOliveModel,
  parseUpnpDeviceDescription,
  type ExplorerRequest,
  type LibrarySearchScope,
  type MaestroBrowseRequest,
  type OliveDeviceTarget,
  type OliveTransport,
  type PlaybackCommand,
  type TransportRequest,
  type TransportResponse,
  type UpnpDeviceDescription,
  type UpnpServiceDescription,
} from "@olive-remote-lab/olive-client";
import { handleDemoApi } from "./demoOlive";

interface SsdpReply {
  address: string;
  location: string;
  server: string;
  st: string;
  usn: string;
}

interface OpenHost { address: string; ports: number[] }

interface DiscoveryPlugin {
  discover(options: { timeoutMs: number }): Promise<{ localAddress: string; responses: SsdpReply[] }>;
  scanSubnet(options: { timeoutMs: number; concurrency: number }): Promise<{ subnet: string; hosts: OpenHost[] }>;
  networkStatus(): Promise<LocalNetworkStatus>;
  openNetworkSettings(): Promise<void>;
}

export interface LocalNetworkStatus {
  localAddress: string;
  wifi: boolean;
  vpnActive: boolean;
  settingsLabel: string;
}

interface NativeCandidate {
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

interface NativeLogEntry {
  id: string;
  timestamp: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  error?: string;
}

export const isNativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
export const isNativeApp = Capacitor.isNativePlatform() && ["android", "ios"].includes(Capacitor.getPlatform());
const OliveDiscovery = isNativeApp ? registerPlugin<DiscoveryPlugin>("OliveDiscovery") : null;
const nativeLogs: NativeLogEntry[] = [];

export async function getLocalNetworkStatus(): Promise<LocalNetworkStatus | null> {
  if (!OliveDiscovery) return null;
  try { return await OliveDiscovery.networkStatus(); }
  catch { return { localAddress: "", wifi: false, vpnActive: false, settingsLabel: "Open Settings" }; }
}

export async function openLocalNetworkSettings(): Promise<boolean> {
  if (!OliveDiscovery) return false;
  try { await OliveDiscovery.openNetworkSettings(); return true; }
  catch { return false; }
}

function assertPrivateHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  const privateIpv4 = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
  if (!privateIpv4.test(normalized) && !normalized.endsWith(".local")) {
    throw new Error("The native app permits requests only to private LAN addresses or .local names.");
  }
}

function assertPrivateUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password) throw new Error("Only credential-free local HTTP URLs are allowed.");
  assertPrivateHost(url.hostname);
  return url;
}

class NativeHttpTransport implements OliveTransport {
  public async request(request: TransportRequest): Promise<TransportResponse> {
    assertPrivateUrl(request.url);
    return this.perform(request);
  }

  private async perform(request: TransportRequest): Promise<TransportResponse> {
    const started = performance.now();
    const timeout = request.timeoutMs ?? 5_000;
    const response = await CapacitorHttp.request({
      url: request.url,
      method: request.method,
      ...(request.headers !== undefined ? { headers: request.headers } : {}),
      ...(request.body !== undefined ? { data: request.body } : {}),
      responseType: "text",
      connectTimeout: timeout,
      readTimeout: timeout,
      disableRedirects: true,
    });
    const headers = Object.fromEntries(Object.entries(response.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
    if (new TextEncoder().encode(body).byteLength > 8 * 1024 * 1024) {
      throw new Error("Olive response exceeded the 8 MiB safety limit.");
    }
    return {
      url: response.url || request.url,
      status: response.status,
      statusText: response.status >= 200 && response.status < 300 ? "OK" : `HTTP ${response.status}`,
      headers,
      body,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

const nativeTransport = new NativeHttpTransport();
const nativeClient = new OliveCompatibilityClient(nativeTransport);
const nativeUpnpClient = new OliveUpnpClient(nativeTransport);

interface NativeUpnpTarget extends OliveDeviceTarget {
  services?: readonly UpnpServiceDescription[];
  approvedServiceDeviceIds?: readonly string[];
}

function targetUpnpService(
  target: NativeUpnpTarget,
  family: "ContentDirectory" | "AVTransport" | "RenderingControl",
): UpnpServiceDescription | null {
  const service = target.services?.find((candidate) =>
    new RegExp(`:service:${family}:\\d+$`, "i").test(candidate.serviceType)
    && Boolean(candidate.controlUrl));
  if (!service?.controlUrl) return null;
  const approvedOwners = new Set((target.approvedServiceDeviceIds ?? [])
    .map((value) => value.trim().toLowerCase()));
  const owner = service.deviceUdn?.trim().toLowerCase() ?? "";
  if (!owner || !approvedOwners.has(owner)) {
    throw new Error(`${family} endpoint is not bound to an Olive-verified device descriptor.`);
  }
  const control = assertPrivateUrl(service.controlUrl);
  if (control.hostname.toLowerCase() !== target.host.trim().toLowerCase()) {
    throw new Error(`${family} endpoint does not belong to the selected Olive.`);
  }
  return service;
}

async function bestEffort<T>(operation: (() => Promise<T>) | null): Promise<T | null> {
  if (!operation) return null;
  try { return await operation(); } catch { return null; }
}
interface NativeRouteJob {
  priority: number;
  sequence: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}
const nativeRouteJobs: NativeRouteJob[] = [];
let nativeRouteBusy = false;
let nativeRouteSequence = 0;

function nativeRoutePriority(path: string, init?: RequestInit): number {
  const requestPriority = new Headers(init?.headers).get("x-olive-request-priority")?.trim().toLowerCase();
  if ((path === "/api/library/browse" || path === "/api/upnp/browse" || path === "/api/upnp/catalog-status") && requestPriority === "background") return 4;
  if (path === "/api/playback" || path === "/api/upnp/volume") return 0;
  if (path === "/api/now-playing" || path === "/api/upnp/player-state") return 1;
  if (["/api/library/navigation", "/api/library/browse", "/api/library/search", "/api/upnp/catalog-status", "/api/upnp/browse", "/api/upnp/search", "/api/device/identify"].includes(path)) return 2;
  if (path === "/api/library/item-metadata") return 3;
  return 2;
}

function drainNativeRouteJobs(): void {
  if (nativeRouteBusy) return;
  nativeRouteJobs.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
  const job = nativeRouteJobs.shift();
  if (!job) return;
  nativeRouteBusy = true;
  void job.run().then(job.resolve, job.reject).finally(() => {
    nativeRouteBusy = false;
    drainNativeRouteJobs();
  });
}

function scheduleNativeRoute(path: string, init: RequestInit | undefined, run: () => Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    nativeRouteJobs.push({ priority: nativeRoutePriority(path, init), sequence: nativeRouteSequence++, run, resolve, reject });
    drainNativeRouteJobs();
  });
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

function oliveEvidence(...values: Array<string | undefined>): string[] {
  const labels = ["manufacturer", "model", "friendly name", "server", "web response"];
  return values.flatMap((value, index) => value && /olive|maestro|4hd|3hd|5hd|6hd|opus|melody|symphony|musica/i.test(value)
    ? [`${labels[index]}: ${value.replace(/\s+/g, " ").slice(0, 120)}`]
    : []);
}

async function controllerPort(address: string): Promise<number> {
  for (const port of [80, 8163]) {
    try {
      const response = await nativeTransport.request({ method: "GET", url: `http://${address}:${port}/index.php`, timeoutMs: 900 });
      const evidence = oliveEvidence(
        undefined,
        undefined,
        undefined,
        response.headers.server,
        response.body,
      );
      if (response.status >= 200 && response.status < 400 && evidence.length) return port;
    } catch { /* Try the next allow-listed controller port. */ }
  }
  return 80;
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
      return (/device:MediaServer:/i.test(entry.reply.st) ? 8 : 0)
        + (/device:MediaServer:/i.test(rootType) ? 4 : 0)
        + (services.some((service) => /:service:ContentDirectory:/i.test(service.serviceType)) ? 2 : 0)
        + (/rootdevice/i.test(entry.reply.st) ? 1 : 0);
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

async function inspectSsdp(replies: readonly SsdpReply[]): Promise<NativeCandidate | null> {
  const uniqueReplies = [...new Map(replies
    .filter((reply) => Boolean(reply.location))
    .map((reply) => [`${reply.location}|${reply.usn}`, reply])).values()];
  const descriptions = await Promise.all(uniqueReplies.map(async (reply): Promise<InspectedDescription> => {
    let xml = "";
    let parsed: UpnpDeviceDescription | null = null;
    try {
      xml = (await nativeTransport.request({ method: "GET", url: reply.location, timeoutMs: 1_200 })).body;
      parsed = parseUpnpDeviceDescription(xml, { descriptionUrl: reply.location, ssdpUsn: reply.usn });
    } catch { /* SSDP headers can still identify a candidate. */ }
    return { reply, xml, parsed };
  }));
  const canonical = canonicalDescription(descriptions) ?? (replies[0] ? { reply: replies[0], xml: "", parsed: null } : undefined);
  if (!canonical) return null;
  const manufacturer = canonical.parsed?.rootDevice.manufacturer || xmlValue(canonical.xml, "manufacturer");
  const model = canonical.parsed?.rootDevice.modelName || xmlValue(canonical.xml, "modelName");
  const friendlyName = canonical.parsed?.rootDevice.friendlyName || xmlValue(canonical.xml, "friendlyName");
  const evidence = oliveEvidence(
    manufacturer,
    model,
    friendlyName,
    replies.map((reply) => reply.server).filter(Boolean).join(" · "),
  );
  if (!evidence.length) return null;
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
  const descriptionUrls = [...new Set(orderedDescriptions.map((entry) => entry.reply.location).filter(Boolean))];
  const deviceId = canonical.parsed?.stableIdentity
    ?? deriveStableUpnpIdentity({ udn: canonical.parsed?.udn ?? null, usn: canonical.reply.usn });
  return {
    address: canonical.reply.address,
    port: await controllerPort(canonical.reply.address),
    name: friendlyName ?? model ?? `Possible music server at ${canonical.reply.address}`,
    ...(deviceId ? { deviceId } : {}),
    ...(canonical.parsed?.udn ? { udn: canonical.parsed.udn } : {}),
    ...(canonical.reply.usn ? { usn: canonical.reply.usn } : {}),
    ...(model ? { model } : {}),
    ...(manufacturer ? { manufacturer } : {}),
    ...(canonical.reply.location ? {
      description: canonical.reply.location,
      descriptionUrl: canonical.reply.location,
    } : {}),
    ...(descriptionUrls.length ? { descriptionUrls } : {}),
    source: "ssdp",
    confidence: evidence.length >= 2 ? "high" : "possible",
    evidence,
    ...(services.length ? {
      services,
      serviceTypes: [...new Set(services.map((service) => service.serviceType))],
      approvedServiceDeviceIds,
    } : {}),
  };
}

async function inspectOpenHost(host: OpenHost): Promise<NativeCandidate | null> {
  for (const port of host.ports.filter((value) => value === 80 || value === 8163)) {
    let server = "";
    let observedBody = "";
    for (const path of ["/", "/maestro.php", "/index.php"]) {
      try {
        const response = await nativeTransport.request({ method: "GET", url: `http://${host.address}:${port}${path}`, timeoutMs: 700 });
        server ||= response.headers.server ?? "";
        observedBody += response.body.slice(0, 3_000);
      } catch { /* Continue through the three known paths only. */ }
    }
    const evidence = oliveEvidence(undefined, undefined, undefined, server, observedBody);
    if (evidence.length) {
      const modelId = detectOliveModel(observedBody);
      const profile = capabilitiesForModel(modelId);
      return {
        address: host.address,
        port,
        name: modelId === "unknown" ? `Possible music server at ${host.address}` : profile.displayName,
        ...(modelId !== "unknown" ? { model: profile.displayName } : {}),
        source: "subnet",
        confidence: /olive|maestro/i.test(evidence.join(" ")) ? "high" : "possible",
        evidence,
      };
    }
  }
  return null;
}

async function discoverNative(): Promise<{ candidates: NativeCandidate[]; subnet?: string; ssdpResponses: number }> {
  if (!OliveDiscovery) throw new Error("Native discovery is available only in the Android or iOS app.");
  let ssdpResponses = 0;
  try {
    const ssdp = await OliveDiscovery.discover({ timeoutMs: 1_800 });
    ssdpResponses = ssdp.responses.length;
    const replyGroups = new Map<string, SsdpReply[]>();
    for (const reply of ssdp.responses) {
      const group = replyGroups.get(reply.address) ?? [];
      group.push(reply);
      replyGroups.set(reply.address, group);
    }
    const inspected = await Promise.all([...replyGroups.values()].map(inspectSsdp));
    const candidates = inspected.filter((value): value is NativeCandidate => value !== null);
    if (candidates.length) return { candidates, ssdpResponses };
  } catch {
    // Debug provisioning may not include Apple's restricted multicast entitlement.
    // Continue to the bounded current-subnet scan instead of failing discovery.
  }

  const scan = await OliveDiscovery.scanSubnet({ timeoutMs: 250, concurrency: 16 });
  const scanned = await Promise.all(scan.hosts.map(inspectOpenHost));
  return {
    candidates: scanned.filter((value): value is NativeCandidate => value !== null),
    subnet: scan.subnet,
    ssdpResponses,
  };
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string" || !init.body) return {};
  return JSON.parse(init.body) as unknown;
}

async function handleNativeRoute(path: string, init?: RequestInit): Promise<unknown> {
  const body = parseBody(init);
  switch (path) {
    case "/api/device/identify": return nativeClient.detectDevice(body as OliveDeviceTarget);
    case "/api/probe": return nativeClient.testKnownSurfaces(body as OliveDeviceTarget);
    case "/api/library/navigation": return nativeClient.getLibraryNavigation(body as OliveDeviceTarget);
    case "/api/library/browse": {
      const input = body as { target: OliveDeviceTarget; browse: MaestroBrowseRequest };
      return nativeClient.browseLibrary(input.target, input.browse);
    }
    case "/api/library/item-metadata": {
      const input = body as { target: OliveDeviceTarget; itemId: string };
      return nativeClient.getItemMetadata(input.target, input.itemId);
    }
    case "/api/now-playing": return nativeClient.getNowPlaying(body as OliveDeviceTarget);
    case "/api/playback": {
      const input = body as { target: OliveDeviceTarget; command: PlaybackCommand };
      if (input.command?.action === "seek") {
        throw new Error("Seeking is quarantined because no Olive seek endpoint has been physically verified.");
      }
      return { ok: true, ...(await nativeClient.controlPlayback(input.target, input.command)) };
    }
    case "/api/library/search": {
      const input = body as { target: OliveDeviceTarget; term: string; scope: LibrarySearchScope };
      return nativeClient.searchLibrary(input.target, input.term, input.scope);
    }
    case "/api/upnp/catalog-status": {
      const target = body as NativeUpnpTarget;
      const service = targetUpnpService(target, "ContentDirectory");
      if (!service) return { available: false, sampledAt: Date.now() };
      const updateId = await nativeUpnpClient.getSystemUpdateId(service);
      const search = await bestEffort(() => nativeUpnpClient.getSearchCapabilities(service));
      const sort = await bestEffort(() => nativeUpnpClient.getSortCapabilities(service));
      return {
        available: true,
        sampledAt: Date.now(),
        updateId,
        searchCapabilities: search?.values ?? [],
        sortCapabilities: sort?.values ?? [],
      };
    }
    case "/api/upnp/browse": {
      const input = body as {
        target: NativeUpnpTarget;
        objectId: string;
        startingIndex?: number;
        requestedCount?: number;
        browseFlag?: "BrowseMetadata" | "BrowseDirectChildren";
      };
      const service = targetUpnpService(input.target, "ContentDirectory");
      if (!service) throw new Error("This Olive did not advertise ContentDirectory.");
      const background = new Headers(init?.headers).get("x-olive-request-priority")?.trim().toLowerCase() === "background";
      const result = await nativeUpnpClient.browse(service, {
        objectId: input.objectId,
        startingIndex: input.startingIndex ?? 0,
        requestedCount: input.requestedCount ?? 64,
        browseFlag: input.browseFlag ?? "BrowseDirectChildren",
        timeoutMs: background ? 12_000 : 5_000,
      });
      const { rawDidl: _rawDidl, ...catalog } = result;
      return { ...catalog, objectId: input.objectId };
    }
    case "/api/upnp/search": {
      const input = body as { target: NativeUpnpTarget; term: string; startingIndex?: number; requestedCount?: number };
      const service = targetUpnpService(input.target, "ContentDirectory");
      if (!service) throw new Error("This Olive did not advertise ContentDirectory search.");
      const capabilities = await nativeUpnpClient.getSearchCapabilities(service);
      const result = await nativeUpnpClient.search(service, {
        containerId: "0",
        searchCriteria: buildOliveUpnpSearchCriteria(input.term, capabilities.values),
        startingIndex: input.startingIndex ?? 0,
        requestedCount: input.requestedCount ?? 64,
      });
      const { rawDidl: _rawDidl, ...catalog } = result;
      return { ...catalog, objectId: "0" };
    }
    case "/api/upnp/player-state": {
      const target = body as NativeUpnpTarget & { includeRendering?: boolean; includeMedia?: boolean };
      const avTransport = targetUpnpService(target, "AVTransport");
      const rendering = targetUpnpService(target, "RenderingControl");
      if (!avTransport && !rendering) return { available: false, sampledAt: Date.now() };
      const [position, transport, volume, mute] = await Promise.all([
        bestEffort(avTransport ? () => nativeUpnpClient.getPositionInfo(avTransport) : null),
        bestEffort(avTransport ? () => nativeUpnpClient.getTransportInfo(avTransport) : null),
        bestEffort(rendering && target.includeRendering !== false ? () => nativeUpnpClient.getVolume(rendering) : null),
        bestEffort(rendering && target.includeRendering !== false ? () => nativeUpnpClient.getMute(rendering) : null),
      ]);
      const media = target.includeMedia === false || position?.trackMetadata.length
        ? null
        : await bestEffort(avTransport ? () => nativeUpnpClient.getMediaInfo(avTransport) : null);
      return {
        available: true,
        sampledAt: Date.now(),
        position,
        transport,
        media,
        rendering: target.includeRendering === false
          ? null
          : { volume: volume?.value ?? null, muted: mute?.value ?? null },
      };
    }
    case "/api/upnp/volume": {
      const input = body as { target: NativeUpnpTarget; volume?: number; muted?: boolean };
      const service = targetUpnpService(input.target, "RenderingControl");
      if (!service) throw new Error("This Olive did not advertise RenderingControl.");
      const setsVolume = Object.prototype.hasOwnProperty.call(input, "volume");
      const setsMute = Object.prototype.hasOwnProperty.call(input, "muted");
      if (setsVolume === setsMute) throw new Error("Choose exactly one absolute volume or mute value.");
      if (setsVolume) {
        const volume = await nativeUpnpClient.setVolume(service, Number(input.volume));
        const mute = await nativeUpnpClient.getMute(service);
        return { sampledAt: Date.now(), volume: volume.value, muted: mute.value };
      }
      if (typeof input.muted !== "boolean") throw new Error("Muted must be a boolean.");
      const mute = await nativeUpnpClient.setMute(service, input.muted);
      const volume = await nativeUpnpClient.getVolume(service);
      return { sampledAt: Date.now(), volume: volume.value, muted: mute.value };
    }
    case "/api/request":
      if (!import.meta.env.DEV) throw new Error("Experimental request tunneling is disabled in release builds.");
      return nativeClient.experimentalRequest(body as ExplorerRequest);
    case "/api/discover": return discoverNative();
    case "/api/logs": return nativeLogs;
    case "/api/logs/export": return {
      exportedAt: new Date().toISOString(),
      redacted: true,
      platform: Capacitor.getPlatform(),
      logs: nativeLogs.map(({ route, ...entry }) => ({ ...entry, route, device: "[LOCAL_DEVICE]" })),
    };
    default: throw new Error(`Native route is not implemented: ${path}`);
  }
}

export async function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const value = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = value.split("?")[0] ?? value;
  if (path.startsWith("/api/")) {
    try {
      const demo = handleDemoApi(path, parseBody(init));
      if (demo.handled) return new Response(JSON.stringify(demo.value), { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Demo request failed.";
      return new Response(JSON.stringify({ error: message }), { status: 502, headers: { "content-type": "application/json" } });
    }
  }
  if (!isNativeApp || !value.startsWith("/api/")) return fetch(input, init);
  const started = performance.now();
  try {
    const data = await scheduleNativeRoute(path, init, () => handleNativeRoute(path, init));
    nativeLogs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), method: init?.method ?? "GET", route: path, status: 200, durationMs: Math.round(performance.now() - started) });
    if (nativeLogs.length > 300) nativeLogs.length = 300;
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Native request failed.";
    nativeLogs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), method: init?.method ?? "GET", route: path, status: 502, durationMs: Math.round(performance.now() - started), error: message });
    return new Response(JSON.stringify({ error: message }), { status: 502, headers: { "content-type": "application/json" } });
  }
}
