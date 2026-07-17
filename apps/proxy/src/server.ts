import express from "express";
import {
  OliveCompatibilityClient,
  type ExplorerRequest,
  type MaestroBrowseRequest,
  type OliveDeviceTarget,
  type PlaybackCommand,
  type LibrarySearchScope,
  buildOliveUrl,
} from "@olive-remote-lab/olive-client";
import { discoverOliveDevices } from "./discovery.js";
import { addLog, getLogs, redactForExport } from "./logger.js";
import { LocalHttpTransport } from "./transport.js";
import { assertLocalUrl } from "./security.js";

const app = express();
const port = Number(process.env.PROXY_PORT ?? 3001);
const client = new OliveCompatibilityClient(new LocalHttpTransport());

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
    response.setHeader("cache-control", "private, max-age=300");
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

app.post("/api/request", async (request, response) => {
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
