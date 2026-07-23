import { describe, expect, it } from "vitest";
import { OliveCompatibilityClient } from "../src/client.js";
import type { OliveTransport, TransportRequest, TransportResponse } from "../src/types.js";

const response = (request: TransportRequest, body: string): TransportResponse => ({
  url: request.url, status: 200, statusText: "OK", headers: {}, body, durationMs: 1,
});

describe("Olive compatibility client", () => {
  it("identifies an Olive whose controller serves maestro.php but not index.php", async () => {
    const paths: string[] = [];
    const transport: OliveTransport = { request: async (request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/index.php") throw new Error("connection closed");
      return response(request, "<title>Olive OPUS No.4 Maestro</title>");
    } };
    const client = new OliveCompatibilityClient(transport);
    await expect(client.detectDevice({ host: "192.168.68.110", port: 80 })).resolves.toMatchObject({ displayName: "OPUS No.4" });
    expect(paths).toEqual(["/index.php", "/index.php", "/maestro.php"]);
  });

  it("fails over from port 80 to 8163 and remembers the healthy port", async () => {
    const urls: string[] = [];
    const transport: OliveTransport = { request: async (request) => {
      urls.push(request.url);
      if (new URL(request.url).port === "") throw new Error("timed out");
      return response(request, '<tree id="0"></tree>');
    } };
    const client = new OliveCompatibilityClient(transport);
    await client.getLibraryNavigation({ host: "192.168.1.8", port: 80 });
    await client.getLibraryNavigation({ host: "192.168.1.8", port: 80 });
    expect(urls.map((url) => new URL(url).port || "80")).toEqual(["80", "8163", "8163"]);
  });

  it("uses the original Maestro player request with its one-based menu index", async () => {
    let requestUrl = "";
    const transport: OliveTransport = { request: async (request) => {
      requestUrl = request.url; return response(request, "");
    } };
    const client = new OliveCompatibilityClient(transport);
    await client.controlPlayback({ host: "192.168.1.8", port: 80 }, { action: "play", itemId: "track-7", index: 65 });
    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/server/player.php");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      mode: "play", id: "track-7", index: "65",
    });
  });

  it("remembers a played item when Maestro current-playing is blank", async () => {
    const transport: OliveTransport = { request: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("getcurrentplaying.php")) return response(request, "inf_showcurrentplaying('');");
      if (url.searchParams.get("action") === "getBottomStatus") return response(request, '{"TransportState":"PLAYING"}');
      if (url.pathname.endsWith("getnewinfo.php")) return response(request, `new_info('{"track":{"id":"track-7","title":"Song"}}');`);
      return response(request, '{"err":null,"action":"playItem"}');
    } };
    const client = new OliveCompatibilityClient(transport);
    const target = { host: "192.168.1.8", port: 80 };
    await client.controlPlayback(target, { action: "play", itemId: "track-7", index: 1 });
    await expect(client.getNowPlaying(target)).resolves.toMatchObject({ itemId: "track-7", metadata: { title: "Song" } });
  });

  it("does not report the previous item after a hardware skip when current-playing is blank", async () => {
    const transport: OliveTransport = { request: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("getcurrentplaying.php")) return response(request, "inf_showcurrentplaying('');");
      if (url.searchParams.get("action") === "getBottomStatus") return response(request, '{"TransportState":"PLAYING"}');
      return response(request, "{}");
    } };
    const client = new OliveCompatibilityClient(transport);
    const target = { host: "192.168.1.8", port: 80 };
    await client.controlPlayback(target, { action: "play", itemId: "track-7", index: 1 });
    await client.controlPlayback(target, { action: "next" });
    await expect(client.getNowPlaying(target)).resolves.toMatchObject({ itemId: "", metadata: null });
  });

  it("keeps current identity and transport when metadata hydration fails", async () => {
    const transport: OliveTransport = { request: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("getcurrentplaying.php")) return response(request, "inf_showcurrentplaying('track-9');");
      if (url.searchParams.get("action") === "getBottomStatus") return response(request, '{"TransportState":"PLAYING"}');
      if (url.pathname.endsWith("getnewinfo.php")) throw new Error("metadata timed out");
      return response(request, "{}");
    } };
    const client = new OliveCompatibilityClient(transport);
    await expect(client.getNowPlaying({ host: "192.168.1.8", port: 80 })).resolves.toMatchObject({
      itemId: "track-9", metadata: null, transportState: "playing",
    });
  });

  it("binds returned metadata to the item that was requested", async () => {
    const transport: OliveTransport = { request: async (request) => response(request, `new_info('{"track":{"id":"legacy-alias","title":"Song"}}');`) };
    const client = new OliveCompatibilityClient(transport);
    await expect(client.getItemMetadata({ host: "192.168.1.8", port: 80 }, "track-9")).resolves.toMatchObject({
      id: "track-9", title: "Song",
    });
  });

  it("uses the front-panel play/pause toggle contract", async () => {
    let requestUrl = "";
    const transport: OliveTransport = { request: async (request) => { requestUrl = request.url; return response(request, "{}"); } };
    const client = new OliveCompatibilityClient(transport);
    await client.controlPlayback({ host: "192.168.1.8", port: 80 }, { action: "pause" });
    expect(Object.fromEntries(new URL(requestUrl).searchParams)).toMatchObject({
      action: "controlPlayer", root: "null", upnpid: "null", index: "0",
    });
  });

  it("uses the front-panel skip contracts for previous and next", async () => {
    const requestUrls: string[] = [];
    const transport: OliveTransport = { request: async (request) => {
      requestUrls.push(request.url);
      return response(request, "{}");
    } };
    const client = new OliveCompatibilityClient(transport);
    await client.controlPlayback({ host: "192.168.1.8", port: 80 }, { action: "previous" });
    await client.controlPlayback({ host: "192.168.1.8", port: 80 }, { action: "next" });
    expect(requestUrls.map((url) => Object.fromEntries(new URL(url).searchParams))).toEqual([
      { action: "left_skip" },
      { action: "right_skip" },
    ]);
  });

  it("formats a seek as an Olive relative-time command", async () => {
    let requestUrl = "";
    const transport: OliveTransport = { request: async (request) => { requestUrl = request.url; return response(request, "{}"); } };
    const client = new OliveCompatibilityClient(transport);
    await client.controlPlayback({ host: "192.168.1.8", port: 80 }, { action: "seek", positionSeconds: 245.8 });
    expect(Object.fromEntries(new URL(requestUrl).searchParams)).toMatchObject({
      action: "seek", unit: "REL_TIME", target: "00:04:05",
    });
  });

  it("uses the O4HD front-panel relative volume actions without inventing a level", async () => {
    const urls: string[] = [];
    const transport: OliveTransport = { request: async (request) => { urls.push(request.url); return response(request, "{}"); } };
    const client = new OliveCompatibilityClient(transport);
    const target = { host: "192.168.1.8", port: 80 };
    await client.controlPlayback(target, { action: "volumeDown" });
    await client.controlPlayback(target, { action: "mute" });
    await client.controlPlayback(target, { action: "volumeUp" });
    expect(urls.map((url) => Object.fromEntries(new URL(url).searchParams))).toEqual([
      { action: "volumeDown" }, { action: "mute" }, { action: "volumeUp" },
    ]);
  });
});
