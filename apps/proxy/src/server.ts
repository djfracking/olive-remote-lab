import express from "express";
import {
  OliveCompatibilityClient,
  OliveUpnpClient,
  buildOliveUpnpSearchCriteria,
  type ExplorerRequest,
  type MaestroBrowseRequest,
  type OliveDeviceTarget,
  type PlaybackCommand,
  type LibrarySearchScope,
  type UpnpServiceDescription,
  buildOliveUrl,
} from "@olive-remote-lab/olive-client";
import { discoverOliveDevices } from "./discovery.js";
import { addLog, getLogs, redactForExport } from "./logger.js";
import { LocalHttpTransport } from "./transport.js";
import { assertLocalUrl } from "./security.js";

const app = express();
const port = Number(process.env.PROXY_PORT ?? 3001);
const transport = new LocalHttpTransport();
const client = new OliveCompatibilityClient(transport);
const upnpClient = new OliveUpnpClient(transport);
const experimentalRequestsEnabled = process.env.OLIVE_ENABLE_EXPERIMENTAL_REQUESTS === "1";

interface UpnpTarget extends OliveDeviceTarget {
  services?: readonly UpnpServiceDescription[];
  approvedServiceDeviceIds?: readonly string[];
}

function upnpService(
  target: UpnpTarget,
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
  const control = new URL(service.controlUrl);
  if (control.hostname.toLowerCase() !== target.host.trim().toLowerCase()) {
    throw new Error(`${family} endpoint does not belong to the selected Olive.`);
  }
  return service;
}

async function bestEffort<T>(operation: (() => Promise<T>) | null): Promise<T | null> {
  if (!operation) return null;
  try { return await operation(); } catch { return null; }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

app.get("/api/health", (_request, response) => response.json({ ok: true, localOnly: true }));

app.get("/api/artwork", async (request, response) => {
  const host = typeof request.query.host === "string" ? request.query.host : "";
  const port = Number(request.query.port);
  const path = typeof request.query.path === "string" ? request.query.path : "";
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith("/")) {
    response.status(400).json({ error: "Invalid local artwork target." }); return;
  }
  try {
    const url = buildOliveUrl({ host, port }, path);
    await assertLocalUrl(url);
    const upstream = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !contentType.toLowerCase().startsWith("image/")) {
      response.status(404).end(); return;
    }
    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) { response.status(413).end(); return; }
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "private, max-age=604800, stale-while-revalidate=86400");
    response.send(Buffer.from(bytes));
  } catch { response.status(404).end(); }
});

app.post("/api/probe", async (request, response) => {
  const target = request.body as OliveDeviceTarget;
  try {
    const results = await client.testKnownSurfaces(target);
    results.forEach((result) => addLog({ method: "GET", url: result.url, status: result.status, durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}), responsePreview: result.preview }));
    response.json(results);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Probe failed." });
  }
});

app.post("/api/device/identify", async (request, response) => {
  const target = request.body as OliveDeviceTarget;
  try {
    const profile = await client.detectDevice(target);
    addLog({ method: "GET", url: `${target.host}:${target.port}/index.php`, status: 200, responsePreview: profile.model });
    response.json(profile);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Device identification failed." });
  }
});

app.post("/api/library/navigation", async (request, response) => {
  const target = request.body as OliveDeviceTarget;
  try {
    const tree = await client.getLibraryNavigation(target);
    addLog({ method: "POST", url: `${target.host}:${target.port}/server/getNavitree.php`, status: 200, responsePreview: `${tree.items.length} navigation roots` });
    response.json(tree);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Library navigation failed." });
  }
});

app.post("/api/library/browse", async (request, response) => {
  const { target, browse } = request.body as { target: OliveDeviceTarget; browse: MaestroBrowseRequest };
  try {
    const tree = await client.browseLibrary(target, browse);
    addLog({ method: "POST", url: `${target.host}:${target.port}/server/getCompilationsAndTracks.php`, status: 200, responsePreview: `${tree.items.length} items; private titles omitted` });
    response.json(tree);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Library browse failed." });
  }
});

app.post("/api/library/item-metadata", async (request, response) => {
  const { target, itemId } = request.body as { target: OliveDeviceTarget; itemId: string };
  try {
    const metadata = await client.getItemMetadata(target, itemId);
    addLog({ method: "GET", url: `${target.host}:${target.port}/server/getnewinfo.php`, status: 200, responsePreview: metadata?.artworkPath ? "Artwork metadata available; private fields omitted" : "No artwork metadata returned" });
    response.json(metadata);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Item metadata failed." });
  }
});

app.post("/api/now-playing", async (request, response) => {
  const target = request.body as OliveDeviceTarget;
  try {
    const nowPlaying = await client.getNowPlaying(target);
    addLog({ method: "POST", url: `${target.host}:${target.port}/server/getcurrentplaying.php`, status: 200, responsePreview: nowPlaying.itemId ? "Current item detected; metadata omitted" : "Nothing playing" });
    response.json(nowPlaying);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Now Playing failed." });
  }
});

app.post("/api/playback", async (request, response) => {
  const { target, command } = request.body as { target: OliveDeviceTarget; command: PlaybackCommand };
  if (command?.action === "seek") {
    response.status(409).json({
      error: "Seeking is quarantined because no Olive seek endpoint has been physically verified.",
    });
    return;
  }
  try {
    const result = await client.controlPlayback(target, command);
    addLog({ method: "PLAYBACK", url: `${target.host}:${target.port}`, status: result.status, durationMs: result.durationMs, responsePreview: command.action });
    response.json({ ok: true, ...result });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Playback command failed." });
  }
});

app.post("/api/library/search", async (request, response) => {
  const { target, term, scope } = request.body as { target: OliveDeviceTarget; term: string; scope: LibrarySearchScope };
  try {
    const result = await client.searchLibrary(target, term, scope);
    addLog({ method: "POST", url: `${target.host}:${target.port}/server/getSearchResult.php`, status: 200, responsePreview: `${result.items.length} ${scope} matches; query and titles omitted` });
    response.json(result);
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "Search failed." });
  }
});

app.post("/api/upnp/catalog-status", async (request, response) => {
  const target = request.body as UpnpTarget;
  try {
    const service = upnpService(target, "ContentDirectory");
    if (!service) { response.json({ available: false, sampledAt: Date.now() }); return; }
    const updateId = await upnpClient.getSystemUpdateId(service);
    const search = await bestEffort(() => upnpClient.getSearchCapabilities(service));
    const sort = await bestEffort(() => upnpClient.getSortCapabilities(service));
    addLog({ method: "UPNP", url: service.controlUrl ?? target.host, status: 200, responsePreview: `ContentDirectory revision ${updateId}` });
    response.json({
      available: true,
      sampledAt: Date.now(),
      updateId,
      searchCapabilities: search?.values ?? [],
      sortCapabilities: sort?.values ?? [],
    });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "UPnP catalog status failed." });
  }
});

app.post("/api/upnp/browse", async (request, response) => {
  const { target, objectId, startingIndex = 0, requestedCount = 64, browseFlag = "BrowseDirectChildren" } = request.body as {
    target: UpnpTarget;
    objectId: string;
    startingIndex?: number;
    requestedCount?: number;
    browseFlag?: "BrowseMetadata" | "BrowseDirectChildren";
  };
  try {
    const service = upnpService(target, "ContentDirectory");
    if (!service) throw new Error("This Olive did not advertise ContentDirectory.");
    const background = request.get("x-olive-request-priority")?.trim().toLowerCase() === "background";
    const result = await upnpClient.browse(service, {
      objectId,
      startingIndex,
      requestedCount,
      browseFlag,
      timeoutMs: background ? 12_000 : 5_000,
    });
    const { rawDidl: _rawDidl, ...catalog } = result;
    addLog({ method: "UPNP", url: service.controlUrl ?? target.host, status: 200, responsePreview: `${result.numberReturned}/${result.totalMatches} catalog objects; metadata omitted` });
    response.json({ ...catalog, objectId });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "UPnP browse failed." });
  }
});

app.post("/api/upnp/search", async (request, response) => {
  const { target, term, startingIndex = 0, requestedCount = 64 } = request.body as {
    target: UpnpTarget;
    term: string;
    startingIndex?: number;
    requestedCount?: number;
  };
  try {
    const service = upnpService(target, "ContentDirectory");
    if (!service) throw new Error("This Olive did not advertise ContentDirectory search.");
    const capabilities = await upnpClient.getSearchCapabilities(service);
    const result = await upnpClient.search(service, {
      containerId: "0",
      searchCriteria: buildOliveUpnpSearchCriteria(term, capabilities.values),
      startingIndex,
      requestedCount,
    });
    const { rawDidl: _rawDidl, ...catalog } = result;
    addLog({ method: "UPNP", url: service.controlUrl ?? target.host, status: 200, responsePreview: `${result.numberReturned}/${result.totalMatches} search objects; query and metadata omitted` });
    response.json({ ...catalog, objectId: "0" });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "UPnP search failed." });
  }
});

app.post("/api/upnp/player-state", async (request, response) => {
  const target = request.body as UpnpTarget & { includeRendering?: boolean; includeMedia?: boolean };
  try {
    const avTransport = upnpService(target, "AVTransport");
    const rendering = upnpService(target, "RenderingControl");
    if (!avTransport && !rendering) { response.json({ available: false, sampledAt: Date.now() }); return; }
    const [position, transportInfo, volume, mute] = await Promise.all([
      bestEffort(avTransport ? () => upnpClient.getPositionInfo(avTransport) : null),
      bestEffort(avTransport ? () => upnpClient.getTransportInfo(avTransport) : null),
      bestEffort(rendering && target.includeRendering !== false ? () => upnpClient.getVolume(rendering) : null),
      bestEffort(rendering && target.includeRendering !== false ? () => upnpClient.getMute(rendering) : null),
    ]);
    const media = target.includeMedia === false || position?.trackMetadata.length
      ? null
      : await bestEffort(avTransport ? () => upnpClient.getMediaInfo(avTransport) : null);
    response.json({
      available: true,
      sampledAt: Date.now(),
      position,
      transport: transportInfo,
      media,
      rendering: target.includeRendering === false
        ? null
        : { volume: volume?.value ?? null, muted: mute?.value ?? null },
    });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "UPnP player state failed." });
  }
});

app.post("/api/upnp/volume", async (request, response) => {
  const input = request.body as { target: UpnpTarget; volume?: number; muted?: boolean };
  try {
    const service = upnpService(input.target, "RenderingControl");
    if (!service) throw new Error("This Olive did not advertise RenderingControl.");
    const setsVolume = Object.prototype.hasOwnProperty.call(input, "volume");
    const setsMute = Object.prototype.hasOwnProperty.call(input, "muted");
    if (setsVolume === setsMute) throw new Error("Choose exactly one absolute volume or mute value.");
    if (setsVolume) {
      const volume = await upnpClient.setVolume(service, Number(input.volume));
      const mute = await upnpClient.getMute(service);
      response.json({ sampledAt: Date.now(), volume: volume.value, muted: mute.value });
      return;
    }
    if (typeof input.muted !== "boolean") throw new Error("Muted must be a boolean.");
    const mute = await upnpClient.setMute(service, input.muted);
    const volume = await upnpClient.getVolume(service);
    response.json({ sampledAt: Date.now(), volume: volume.value, muted: mute.value });
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : "UPnP volume command failed." });
  }
});

app.post("/api/request", async (request, response) => {
  if (!experimentalRequestsEnabled) {
    response.status(404).json({ error: "Experimental request tunneling is disabled." });
    return;
  }
  const input = request.body as ExplorerRequest;
  try {
    const result = await client.experimentalRequest(input);
    addLog({ method: input.method, url: result.url, status: result.status, durationMs: result.durationMs, request: { query: input.query, form: input.form }, responsePreview: result.body.slice(0, 1_000) });
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    addLog({ method: input.method ?? "UNKNOWN", url: `${input.target?.host ?? "unknown"}${input.path ?? ""}`, error: message });
    response.status(502).json({ error: message });
  }
});

app.post("/api/discover", async (_request, response) => {
  try {
    const result = await discoverOliveDevices();
    addLog({ method: "DISCOVERY", url: result.subnet ?? "SSDP", status: 200, responsePreview: `${result.candidates.length} candidate(s)` });
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discovery failed.";
    addLog({ method: "DISCOVERY", url: "local network", error: message });
    response.status(500).json({ error: message });
  }
});

app.get("/api/logs", (_request, response) => response.json(getLogs()));
app.get("/api/logs/export", (_request, response) => {
  response.setHeader("content-disposition", `attachment; filename="olive-remote-lab-diagnostics-${Date.now()}.json"`);
  response.json({ exportedAt: new Date().toISOString(), redacted: true, logs: redactForExport(getLogs()) });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Local proxy listening on http://0.0.0.0:${port}`);
});

function shutdown(): void {
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
