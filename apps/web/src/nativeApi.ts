import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import {
  OliveCompatibilityClient,
  capabilitiesForModel,
  detectOliveModel,
  type ExplorerRequest,
  type LibrarySearchScope,
  type MaestroBrowseRequest,
  type OliveDeviceTarget,
  type OliveTransport,
  type PlaybackCommand,
  type TransportRequest,
  type TransportResponse,
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
  model?: string;
  manufacturer?: string;
  description?: string;
  source: "ssdp" | "subnet";
  confidence: "high" | "possible";
  evidence: string[];
  services?: string[];
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

function nativeRoutePriority(path: string): number {
  if (path === "/api/playback") return 0;
  if (["/api/library/navigation", "/api/library/browse", "/api/library/search", "/api/device/identify"].includes(path)) return 1;
  if (path === "/api/now-playing") return 2;
  if (path === "/api/library/item-metadata") return 3;
  return 1;
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

function scheduleNativeRoute(path: string, run: () => Promise<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    nativeRouteJobs.push({ priority: nativeRoutePriority(path), sequence: nativeRouteSequence++, run, resolve, reject });
    drainNativeRouteJobs();
  });
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

function serviceTypes(xml: string): string[] {
  return [...xml.matchAll(/<serviceType>([^<]+)<\/serviceType>/gi)].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
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
      if (response.status >= 200 && response.status < 400) return port;
    } catch { /* Try the next allow-listed controller port. */ }
  }
  return 80;
}

async function inspectSsdp(reply: SsdpReply): Promise<NativeCandidate | null> {
  let xml = "";
  if (reply.location) {
    try { xml = (await nativeTransport.request({ method: "GET", url: reply.location, timeoutMs: 1_200 })).body; }
    catch { /* SSDP headers can still identify a candidate. */ }
  }
  const manufacturer = xmlValue(xml, "manufacturer");
  const model = xmlValue(xml, "modelName");
  const friendlyName = xmlValue(xml, "friendlyName");
  const evidence = oliveEvidence(manufacturer, model, friendlyName, reply.server);
  if (!evidence.length) return null;
  return {
    address: reply.address,
    port: await controllerPort(reply.address),
    name: friendlyName ?? model ?? `Possible music server at ${reply.address}`,
    ...(model ? { model } : {}),
    ...(manufacturer ? { manufacturer } : {}),
    ...(reply.location ? { description: reply.location } : {}),
    source: "ssdp",
    confidence: evidence.length >= 2 ? "high" : "possible",
    evidence,
    services: serviceTypes(xml),
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
    const uniqueReplies = [...new Map(ssdp.responses.map((reply) => [reply.address, reply])).values()];
    const inspected = await Promise.all(uniqueReplies.map(inspectSsdp));
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
      return { ok: true, ...(await nativeClient.controlPlayback(input.target, input.command)) };
    }
    case "/api/library/search": {
      const input = body as { target: OliveDeviceTarget; term: string; scope: LibrarySearchScope };
      return nativeClient.searchLibrary(input.target, input.term, input.scope);
    }
    case "/api/request": return nativeClient.experimentalRequest(body as ExplorerRequest);
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
    const data = await scheduleNativeRoute(path, () => handleNativeRoute(path, init));
    nativeLogs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), method: init?.method ?? "GET", route: path, status: 200, durationMs: Math.round(performance.now() - started) });
    if (nativeLogs.length > 300) nativeLogs.length = 300;
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Native request failed.";
    nativeLogs.unshift({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), method: init?.method ?? "GET", route: path, status: 502, durationMs: Math.round(performance.now() - started), error: message });
    return new Response(JSON.stringify({ error: message }), { status: 502, headers: { "content-type": "application/json" } });
  }
}
