import { describe, expect, it } from "vitest";
import { OliveCompatibilityClient } from "../src/client.js";
import type { OliveTransport, TransportRequest, TransportResponse } from "../src/types.js";

const response = (request: TransportRequest, body: string): TransportResponse => ({
  url: request.url, status: 200, statusText: "OK", headers: {}, body, durationMs: 1,
});

describe("Olive compatibility client", () => {
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

  it("uses the device-native controlPlayer request with the original one-based menu index", async () => {
    let requestUrl = "";
    const transport: OliveTransport = { request: async (request) => {
      requestUrl = request.url; return response(request, "");
    } };
    const client = new OliveCompatibilityClient(transport);
    await client.controlPlayback({ host: "192.168.1.8", port: 80 }, { action: "play", itemId: "track-7", index: 65 });
    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/includes/ajax/a_executeOperation.php");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      action: "controlPlayer", root: "playItem", upnpid: "track-7", sortCrit: "+upnp:originalTrackNumber", index: "65",
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

  it("uses the front-panel play/pause toggle contract", async () => {
    let requestUrl = "";
    const transport: OliveTransport = { request: async (request) => { requestUrl = request.url; return response(request, "{}"); } };
    const client = new OliveCompatibilityClient(transport);
    await client.controlPlayback({ host: "192.168.1.8", port: 80 }, { action: "pause" });
    expect(Object.fromEntries(new URL(requestUrl).searchParams)).toMatchObject({
      action: "controlPlayer", root: "null", upnpid: "null", index: "0",
    });
  });
});
