import { buildOliveUrl, endpointProbeUrls } from "./url.js";
import { capabilitiesForModel, detectOliveModel, type OliveModelCapabilities } from "./models.js";
import {
  parseCurrentPlayingId,
  parseMaestroTrackList,
  parseMaestroTree,
  parseTrackMetadata,
  type MaestroTrackMetadata,
  type MaestroTree,
} from "./maestro.js";
import type {
  EndpointProbe,
  ExplorerRequest,
  OliveDeviceTarget,
  OliveTransport,
  MaestroBrowseRequest,
  PlaybackCommand,
  LibrarySearchScope,
  TransportResponse,
  TransportRequest,
} from "./types.js";

export class OliveCompatibilityClient {
  private readonly preferredPorts = new Map<string, number>();
  private readonly currentItemIds = new Map<string, string>();

  public constructor(private readonly transport: OliveTransport) {}

  public async testKnownSurfaces(target: OliveDeviceTarget): Promise<EndpointProbe[]> {
    return Promise.all(
      endpointProbeUrls(target).map(async (url): Promise<EndpointProbe> => {
        try {
          const response = await this.transport.request({ method: "GET", url, timeoutMs: 5_000 });
          return {
            ...response,
            contentType: response.headers["content-type"] ?? "unknown",
            preview: response.body.slice(0, 800),
          };
        } catch (error) {
          return {
            url,
            status: 0,
            statusText: "Unavailable",
            headers: {},
            body: "",
            durationMs: 0,
            contentType: "unknown",
            preview: "",
            error: error instanceof Error ? error.message : "Unknown request error",
          };
        }
      }),
    );
  }

  public async detectDevice(target: OliveDeviceTarget): Promise<OliveModelCapabilities> {
    const response = await this.requestWithPortFallback(target, (candidate) => ({
      method: "GET", url: buildOliveUrl(candidate, "/index.php"), timeoutMs: 5_000,
    }));
    if (response.status < 200 || response.status >= 400) throw new Error(`Device identification failed (${response.status}).`);
    return capabilitiesForModel(detectOliveModel(response.body));
  }

  public async getLibraryNavigation(target: OliveDeviceTarget): Promise<MaestroTree> {
    const response = await this.maestroPost(target, "/server/getNavitree.php");
    return parseMaestroTree(response.body);
  }

  public async browseLibrary(target: OliveDeviceTarget, input: MaestroBrowseRequest): Promise<MaestroTree> {
    if (!input.id.trim()) throw new Error("A library container ID is required.");
    const allowedTypes = new Set(["albumname", "artists", "artist", "album", "compilation", "genre", "playlist", "track"]);
    if (!allowedTypes.has(input.type)) throw new Error("Unsupported library container type.");
    const startIndex = input.startIndex ?? 0;
    const index = input.index ?? Math.floor(startIndex / 21);
    if (!Number.isInteger(startIndex) || startIndex < 0 || !Number.isInteger(index) || index < 0) {
      throw new Error("Library page indexes must be non-negative integers.");
    }
    if ((input.type === "genre" && input.id === "genres") || (input.type === "playlist" && input.id === "playlists")) {
      const response = await this.maestroPost(target, "/server/getSubNavitree.php", { type: input.type, id: input.id });
      return parseMaestroTree(response.body);
    }
    if (input.type === "genre") {
      const response = await this.maestroPost(target, "/server/getInterpretersByGenreId.php", { gid: input.id });
      return parseMaestroTree(response.body);
    }
    if (input.type === "track" && input.id === "tracks") {
      const response = await this.maestroPost(target, "/server/getTracks.php", { startindex: String(startIndex) });
      return parseMaestroTrackList(response.body);
    }
    const rootId = input.type === "albumname" && input.id === "albumname" ? "ROOT_ALLAL"
      : input.type === "artists" && input.id === "artists" ? "ROOT_ALLAR"
        : input.id;
    const response = await this.maestroPost(
      target,
      "/server/getCompilationsAndTracks.php",
      { id: rootId, type: input.type, startindex: String(startIndex), index: String(index) },
    );
    return parseMaestroTree(response.body);
  }

  public async getNowPlaying(target: OliveDeviceTarget): Promise<{ itemId: string; metadata: MaestroTrackMetadata | null }> {
    const current = await this.maestroPost(target, "/server/getcurrentplaying.php");
    let itemId = parseCurrentPlayingId(current.body) ?? "";
    if (!itemId) {
      const status = await this.requestWithPortFallback(target, (candidate) => ({
        method: "GET",
        url: buildOliveUrl(candidate, "/includes/ajax/a_executeOperation.php", {
          action: "getBottomStatus", varAlarm: "alarmEnable", varTimer: "Idle30",
        }),
        timeoutMs: 5_000,
      }), "front");
      let transportState = "";
      try {
        const parsed = JSON.parse(status.body) as { TransportState?: unknown };
        if (typeof parsed.TransportState === "string") transportState = parsed.TransportState;
      } catch { /* Some firmware returns only the legacy status callback. */ }
      if (transportState === "PLAYING" || transportState === "PAUSED_PLAYBACK") {
        itemId = this.currentItemIds.get(target.host) ?? "";
      } else {
        this.currentItemIds.delete(target.host);
      }
    }
    if (!itemId) return { itemId: "", metadata: null };
    const details = await this.requestWithPortFallback(target, (candidate) => ({
      method: "GET", url: buildOliveUrl(candidate, "/server/getnewinfo.php", { id: itemId }), timeoutMs: 5_000,
    }), "maestro");
    return { itemId, metadata: parseTrackMetadata(details.body) };
  }

  public async searchLibrary(target: OliveDeviceTarget, term: string, scope: LibrarySearchScope): Promise<MaestroTree> {
    const query = term.trim();
    if (!query || query.length > 200) throw new Error("Search text must be between 1 and 200 characters.");
    const roots: Record<LibrarySearchScope, string> = {
      albums: "ROOT_ALLAL", artists: "ROOT_ALLAR", genres: "ROOT_ALLGE", tracks: "ROOT_ALLAU", playlists: "ROOT_ALLPL",
    };
    if (!(scope in roots)) throw new Error("Unsupported search scope.");
    const response = await this.maestroPost(target, "/server/getSearchResult.php", { id: roots[scope], searchterm: query });
    return scope === "tracks" ? parseMaestroTrackList(response.body) : parseMaestroTree(response.body);
  }

  /** Playback-only operations copied from the observed legacy controllers. */
  public async controlPlayback(target: OliveDeviceTarget, command: PlaybackCommand): Promise<{ status: number; durationMs: number }> {
    const action = (command as { action?: unknown }).action;
    if (typeof action !== "string" || !["play", "pause", "stop", "previous", "next"].includes(action)) {
      throw new Error("Unsupported playback command.");
    }
    let response: TransportResponse;
    if (command.action === "play") {
      if (!command.itemId.trim()) throw new Error("A playable item ID is required.");
      const query: Record<string, string> = {
        action: "controlPlayer",
        root: "playItem",
        upnpid: command.itemId,
        sortCrit: "+upnp:originalTrackNumber",
      };
      if (command.index !== undefined) {
        if (!Number.isInteger(command.index) || command.index < 0) throw new Error("Playback index must be a non-negative integer.");
        query.index = String(command.index);
      } else query.index = "0";
      response = await this.requestWithPortFallback(target, (candidate) => ({
        method: "GET", url: buildOliveUrl(candidate, "/includes/ajax/a_executeOperation.php", query), timeoutMs: 8_000,
      }), "front");
      if (response.status < 200 || response.status >= 400) throw new Error(`Playback command failed (${response.status}).`);
      this.currentItemIds.set(target.host, command.itemId);
    } else {
      const action = command.action === "stop" || command.action === "pause" ? "controlPlayer"
        : command.action === "previous" ? "left_skip" : "right_skip";
      const query = command.action === "stop" ? { action, id: "stop" }
        : command.action === "pause" ? {
          action, root: "null", upnpid: "null", sortCrit: "+upnp:originalTrackNumber", index: "0",
        }
          : { action };
      response = await this.requestWithPortFallback(target, (candidate) => ({
        method: "GET", url: buildOliveUrl(candidate, "/includes/ajax/a_executeOperation.php", query), timeoutMs: 5_000,
      }), "front");
      if (response.status < 200 || response.status >= 400) throw new Error(`Playback command failed (${response.status}).`);
      if (command.action === "stop") this.currentItemIds.delete(target.host);
    }
    return { status: response.status, durationMs: response.durationMs };
  }

  private async maestroPost(
    target: OliveDeviceTarget,
    path: string,
    query: Record<string, string> = {},
  ): Promise<TransportResponse> {
    const response = await this.requestWithPortFallback(target, (candidate) => ({
      method: "POST",
      url: buildOliveUrl(candidate, path, query),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
      timeoutMs: 8_000,
    }), "maestro");
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Maestro request failed (${response.status} ${response.statusText}).`);
    }
    return response;
  }

  private async requestWithPortFallback(
    target: OliveDeviceTarget,
    createRequest: (candidate: OliveDeviceTarget) => TransportRequest,
    surface = "web",
  ): Promise<TransportResponse> {
    const portKey = `${target.host}:${surface}`;
    const preferred = this.preferredPorts.get(portKey);
    const ports = [...new Set([preferred, target.port, 80, 8163].filter((port): port is number => port !== undefined))];
    let lastError: unknown = new Error("No local Olive port was available.");
    for (const port of ports) {
      try {
        const response = await this.transport.request(createRequest({ ...target, port }));
        if (response.status >= 200 && response.status < 400) {
          this.preferredPorts.set(portKey, port);
          return response;
        }
        lastError = new Error(`Olive endpoint returned ${response.status} on port ${port}.`);
      } catch (error) { lastError = error; }
    }
    throw lastError;
  }

  /** Experimental: sends only user-specified requests. No undocumented command is assumed. */
  public async experimentalRequest(input: ExplorerRequest): Promise<TransportResponse> {
    const body = input.method === "POST" && input.form
      ? new URLSearchParams(input.form).toString()
      : undefined;
    const headers = { ...input.headers };
    if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    return this.transport.request({
      method: input.method,
      url: buildOliveUrl(input.target, input.path, input.query),
      headers,
      ...(body ? { body } : {}),
      timeoutMs: input.timeoutMs ?? 8_000,
    });
  }
}
