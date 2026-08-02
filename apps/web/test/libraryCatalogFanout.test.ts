import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LibrarySearchScope,
  MaestroTreeNode,
  OliveDeviceTarget,
  UpnpDidlObject,
  UpnpServiceDescription,
} from "@olive-remote-lab/olive-client";

const catalogHarness = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  scopeChunks: new Map<string, Map<string, unknown[]>>(),
  requests: [] as Array<{ path: string; body: Record<string, unknown> }>,
  fetchImpl: undefined as
    | ((path: string, init?: RequestInit) => Promise<Response>)
    | undefined,
  writeError: undefined as
    | ((resource: string, value: unknown) => Error | null)
    | undefined,
}));

vi.mock("../src/deviceCache", () => ({
  readDeviceCacheStrict: vi.fn(async (_target: unknown, resource: string) =>
    catalogHarness.records.get(resource) ?? null),
  writeDeviceCacheStrict: vi.fn(async (
    _target: unknown,
    resource: string,
    value: unknown,
  ) => {
    const error = catalogHarness.writeError?.(resource, value);
    if (error) throw error;
    catalogHarness.records.set(resource, value);
  }),
}));

vi.mock("../src/nativeApi", () => ({
  appFetch: vi.fn(async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" && init.body
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    catalogHarness.requests.push({ path, body });
    if (!catalogHarness.fetchImpl) throw new Error(`No response configured for ${path}.`);
    return catalogHarness.fetchImpl(path, init);
  }),
}));

vi.mock("../src/searchIndex", () => {
  function chunksFor(scope: string): Map<string, unknown[]> {
    const chunks = catalogHarness.scopeChunks.get(scope) ?? new Map<string, unknown[]>();
    catalogHarness.scopeChunks.set(scope, chunks);
    return chunks;
  }

  function documentsFor(scope: string): Array<{
    key: string;
    scope: string;
    item: Record<string, unknown>;
    searchable: string;
    updatedAt: number;
  }> {
    const documents = new Map<string, {
      key: string;
      scope: string;
      item: Record<string, unknown>;
      searchable: string;
      updatedAt: number;
    }>();
    for (const items of chunksFor(scope).values()) {
      for (const value of items) {
        const item = value as {
          id: string;
          title: string;
          userData: Record<string, string>;
        };
        const sourceId = item.userData.upnpId || item.id;
        const key = `${scope}:${item.userData.source ?? "maestro"}:${sourceId}`;
        documents.set(key, {
          key,
          scope,
          item,
          searchable: item.title.toLowerCase(),
          updatedAt: 1,
        });
      }
    }
    return [...documents.values()];
  }

  return {
    beginSearchScope: vi.fn(async (
      _target: unknown,
      scope: string,
      _generation: string,
    ) => {
      catalogHarness.scopeChunks.set(scope, new Map());
    }),
    appendSearchScopePage: vi.fn(async (
      _target: unknown,
      scope: string,
      _generation: string,
      chunkId: string,
      items: unknown[],
    ) => {
      chunksFor(scope).set(chunkId, items);
      return documentsFor(scope).length;
    }),
    completeSearchScope: vi.fn(async () => undefined),
    readSearchScope: vi.fn(async (_target: unknown, scope: string) =>
      documentsFor(scope)),
  };
});

import { syncLibraryCatalog, type LibraryCatalogManifest } from "../src/libraryCatalog";
import { writeDeviceCacheStrict } from "../src/deviceCache";
import {
  appendSearchScopePage,
  beginSearchScope,
  completeSearchScope,
  readSearchScope,
} from "../src/searchIndex";

const REVISION = "20001";
const MANIFEST_RESOURCE = "library:catalog-manifest:v2";
const TRACK_CHECKPOINT_RESOURCE = "library:catalog-checkpoint:v2:tracks";
const ARTIST_INDEX_RESOURCE = "library:artist-index:v2";

function contentDirectoryService(host: string): UpnpServiceDescription {
  const controlUrl = `http://${host}:49152/MediaServer/ContentDirectory/Control`;
  return {
    serviceType: "urn:schemas-upnp-org:service:ContentDirectory:1",
    serviceId: "urn:upnp-org:serviceId:ContentDirectory",
    rawScpdUrl: "/MediaServer/ContentDirectory/Scpd.xml",
    rawControlUrl: "/MediaServer/ContentDirectory/Control",
    rawEventSubUrl: "/MediaServer/ContentDirectory/Event",
    scpdUrl: `http://${host}:49152/MediaServer/ContentDirectory/Scpd.xml`,
    controlUrl,
    eventSubUrl: `http://${host}:49152/MediaServer/ContentDirectory/Event`,
    deviceUdn: "uuid:fanout-test",
  };
}

function target(suffix: string): OliveDeviceTarget & {
  deviceId: string;
  services: readonly UpnpServiceDescription[];
} {
  const host = `192.168.0.${suffix}`;
  return {
    host,
    port: 80,
    deviceId: `uuid:fanout-test-${suffix}`,
    services: [contentDirectoryService(host)],
  };
}

function albumNode(id: number): MaestroTreeNode {
  const upnpId = `ROOT_ALLAL_AL${id}`;
  return {
    id: upnpId,
    title: `Album ${id}`,
    childCount: 1,
    userData: {
      type: "compilation",
      source: "upnp",
      objectKind: "container",
      upnpId,
      upnpClass: "object.container.album.musicAlbum",
      upnpParentId: "ROOT_ALLAL",
    },
  };
}

function trackObject(
  id: string,
  parentId: string,
  title = `Track ${id}`,
): UpnpDidlObject {
  return {
    kind: "item",
    identifiers: {
      maestroId: null,
      upnpId: id,
      upnpRefId: null,
      upnpParentId: parentId,
    },
    id,
    refId: null,
    parentId,
    restricted: true,
    searchable: null,
    childCount: 0,
    className: "object.item.audioItem.musicTrack",
    title,
    artist: "ABBA",
    artists: ["ABBA"],
    album: "Gold",
    genre: null,
    genres: [],
    creator: null,
    albumArtUri: null,
    resources: [],
    resourceUri: null,
    resourceProtocolInfo: null,
    duration: null,
    durationSeconds: null,
  };
}

function trackNode(id: string, parentId = "ROOT_ALLAU"): MaestroTreeNode {
  return {
    id,
    title: `Track ${id}`,
    childCount: 0,
    userData: {
      type: "track",
      source: "upnp",
      objectKind: "item",
      upnpId: id,
      upnpClass: "object.item.audioItem.musicTrack",
      upnpParentId: parentId,
      artist: "ABBA",
      album: "Gold",
    },
  };
}

function catalogPage(
  objectId: string,
  objects: readonly UpnpDidlObject[],
  totalMatches: number,
  updateId = `update:${objectId}`,
): Record<string, unknown> {
  return {
    objectId,
    objects,
    numberReturned: objects.length,
    totalMatches,
    updateId,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return typeof init?.body === "string" && init.body
    ? JSON.parse(init.body) as Record<string, unknown>
    : {};
}

function seedIncompleteCatalog(
  olive: ReturnType<typeof target>,
  albums: MaestroTreeNode[],
): void {
  const scopes = {
    artists: 1,
    albums: albums.length,
    genres: 0,
    playlists: 0,
    composers: 0,
  } satisfies Partial<Record<LibrarySearchScope, number>>;
  const cursors = Object.fromEntries(Object.entries(scopes).map(([scope, count]) => [
    scope,
    {
      nextStartingIndex: count,
      totalMatches: count,
      itemCount: count,
      complete: true,
      containerUpdateId: `update:${scope}`,
      strategy: "flat",
    },
  ])) as LibraryCatalogManifest["cursors"];
  const deviceId = `upnp:${olive.deviceId}`;
  catalogHarness.records.set(MANIFEST_RESOURCE, {
    version: 2,
    protocol: "upnp",
    deviceId,
    updateId: REVISION,
    complete: false,
    completedAt: 0,
    itemCount: Object.values(scopes).reduce((sum, count) => sum + count, 0),
    scopes,
    cursors,
  } satisfies LibraryCatalogManifest);
  catalogHarness.records.set(ARTIST_INDEX_RESOURCE, {
    version: 2,
    deviceId,
    updateId: REVISION,
    completedAt: 1,
    tree: {
      id: "ROOT_ALLAR",
      totalItems: 1,
      items: [{
        id: "ROOT_ALLAR_AR1",
        title: "ABBA",
        childCount: 1,
        userData: { type: "artists" },
      }],
    },
  });
  catalogHarness.scopeChunks.set("albums", new Map([["seed", albums]]));
}

function installCatalogHandler(
  browse: (body: Record<string, unknown>) => Response | Promise<Response>,
): void {
  catalogHarness.fetchImpl = async (path, init) => {
    if (path === "/api/upnp/catalog-status") {
      return jsonResponse({
        available: true,
        sampledAt: Date.now(),
        updateId: REVISION,
        searchCapabilities: ["dc:title"],
        sortCapabilities: [],
      });
    }
    if (path === "/api/upnp/browse") return browse(requestBody(init));
    return jsonResponse({ error: `Unexpected route ${path}.` }, 500);
  };
}

function browseRequests(): Array<Record<string, unknown>> {
  return catalogHarness.requests
    .filter(({ path }) => path === "/api/upnp/browse")
    .map(({ body }) => body);
}

beforeEach(() => {
  catalogHarness.records.clear();
  catalogHarness.scopeChunks.clear();
  catalogHarness.requests.length = 0;
  catalogHarness.fetchImpl = undefined;
  catalogHarness.writeError = undefined;
  vi.clearAllMocks();
  vi.stubGlobal("window", {
    setTimeout(callback: () => void) {
      callback();
      return 1;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("album-fanout catalog orchestration", () => {
  it("publishes an exact canonical album fanout without crawling the flat root", async () => {
    const olive = target("121");
    seedIncompleteCatalog(olive, [albumNode(10), albumNode(20)]);
    installCatalogHandler((body) => {
      const objectId = String(body.objectId);
      const requestedCount = Number(body.requestedCount);
      if (objectId === "ROOT_ALLAU" && requestedCount === 1) {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAU_TR100", objectId)],
          2,
        ));
      }
      if (objectId === "ROOT_ALLAL_AL10") {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAL_AL10_TR100", objectId)],
          1,
        ));
      }
      if (objectId === "ROOT_ALLAL_AL20") {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAL_AL20_TR200", objectId)],
          1,
        ));
      }
      return jsonResponse({ error: `Unexpected browse ${objectId}.` }, 500);
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(completed.complete).toBe(true);
    expect(completed.scopes.tracks).toBe(2);
    expect(completed.cursors.tracks).toMatchObject({
      strategy: "album-fanout",
      itemCount: 2,
      complete: true,
      parentIndex: 2,
    });
    expect(browseRequests().map((body) => [
      body.objectId,
      body.startingIndex,
      body.requestedCount,
    ])).toEqual([
      ["ROOT_ALLAU", 0, 1],
      ["ROOT_ALLAL_AL10", 0, 64],
      ["ROOT_ALLAL_AL20", 0, 64],
      ["ROOT_ALLAU", 0, 1],
    ]);
    expect(vi.mocked(beginSearchScope)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appendSearchScopePage).mock.calls.map((call) => call[3]))
      .toEqual(["album-0-offset-0", "album-1-offset-0"]);
    expect(vi.mocked(completeSearchScope)).toHaveBeenCalledWith(
      olive,
      "tracks",
      `${REVISION}.tracks-2.album-fanout`,
    );
  });

  it("replays a fanout page safely when its append persisted before its checkpoint", async () => {
    const olive = target("126");
    seedIncompleteCatalog(olive, [albumNode(10)]);
    let albumRequestCount = 0;
    let injected = false;
    catalogHarness.writeError = (resource, value) => {
      const checkpoint = value as { strategy?: string; itemCount?: number };
      if (
        !injected
        && resource === TRACK_CHECKPOINT_RESOURCE
        && checkpoint.strategy === "album-fanout"
        && checkpoint.itemCount === 1
      ) {
        injected = true;
        return new Error("simulated checkpoint interruption");
      }
      return null;
    };
    installCatalogHandler((body) => {
      const objectId = String(body.objectId);
      const requestedCount = Number(body.requestedCount);
      if (objectId === "ROOT_ALLAU" && requestedCount === 1) {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAU_TR100", objectId)],
          1,
        ));
      }
      if (objectId === "ROOT_ALLAL_AL10") {
        albumRequestCount += 1;
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAL_AL10_TR100", objectId)],
          1,
        ));
      }
      return jsonResponse({ error: `Unexpected browse ${objectId}.` }, 500);
    });

    await expect(syncLibraryCatalog(olive, vi.fn()))
      .rejects.toThrow("simulated checkpoint interruption");
    expect(catalogHarness.records.get(TRACK_CHECKPOINT_RESOURCE)).toMatchObject({
      strategy: "album-fanout",
      itemCount: 0,
      parentIndex: 0,
      parentStartingIndex: 0,
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(albumRequestCount).toBe(2);
    expect(completed.cursors.tracks).toMatchObject({
      strategy: "album-fanout",
      itemCount: 1,
      complete: true,
    });
    expect(vi.mocked(beginSearchScope)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendSearchScopePage).mock.calls.map((call) => call[3]))
      .toEqual(["album-0-offset-0", "album-0-offset-0"]);
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id))
      .toEqual(["ROOT_ALLAL_AL10_TR100"]);
  });

  it("repairs search-scope completion from a durable complete fanout checkpoint", async () => {
    const olive = target("127");
    seedIncompleteCatalog(olive, [albumNode(10)]);
    catalogHarness.records.set(TRACK_CHECKPOINT_RESOURCE, {
      version: 2,
      protocol: "upnp",
      updateId: REVISION,
      nextStartingIndex: 1,
      totalMatches: 1,
      itemCount: 1,
      complete: true,
      containerUpdateId: null,
      strategy: "album-fanout",
      parentIndex: 1,
      parentStartingIndex: 0,
    });
    catalogHarness.scopeChunks.set("tracks", new Map([
      ["album-0-offset-0", [
        trackNode("ROOT_ALLAL_AL10_TR100", "ROOT_ALLAL_AL10"),
      ]],
    ]));
    installCatalogHandler((body) => {
      const objectId = String(body.objectId);
      if (objectId === "ROOT_ALLAU" && Number(body.requestedCount) === 1) {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAU_TR100", objectId)],
          1,
        ));
      }
      return jsonResponse({ error: `Unexpected browse ${objectId}.` }, 500);
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(completed.cursors.tracks).toMatchObject({
      strategy: "album-fanout",
      itemCount: 1,
      complete: true,
    });
    expect(browseRequests()).toHaveLength(1);
    expect(vi.mocked(beginSearchScope)).not.toHaveBeenCalled();
    expect(vi.mocked(appendSearchScopePage)).not.toHaveBeenCalled();
    expect(vi.mocked(completeSearchScope)).toHaveBeenCalledWith(
      olive,
      "tracks",
      `${REVISION}.tracks-1.album-fanout`,
    );
  });

  it("resumes an existing flat checkpoint only after matching the live track snapshot", async () => {
    const olive = target("122");
    seedIncompleteCatalog(olive, [albumNode(10)]);
    catalogHarness.records.set(TRACK_CHECKPOINT_RESOURCE, {
      version: 2,
      protocol: "upnp",
      updateId: REVISION,
      nextStartingIndex: 1,
      totalMatches: 3,
      itemCount: 1,
      complete: false,
      containerUpdateId: "tracks-7",
      strategy: "flat",
      flatFallback: true,
    });
    catalogHarness.scopeChunks.set("tracks", new Map([
      ["0", [trackNode("ROOT_ALLAU_TR1")]],
    ]));
    installCatalogHandler((body) => {
      expect(body.objectId).toBe("ROOT_ALLAU");
      if (Number(body.requestedCount) === 1) {
        expect(body.startingIndex).toBe(0);
        return jsonResponse(catalogPage(
          "ROOT_ALLAU",
          [trackObject("ROOT_ALLAU_TR1", "ROOT_ALLAU")],
          3,
          "tracks-7",
        ));
      }
      expect(body.startingIndex).toBe(1);
      expect(body.requestedCount).toBe(64);
      return jsonResponse(catalogPage("ROOT_ALLAU", [
        trackObject("ROOT_ALLAU_TR2", "ROOT_ALLAU"),
        trackObject("ROOT_ALLAU_TR3", "ROOT_ALLAU"),
      ], 3, "tracks-7"));
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(completed.cursors.tracks).toMatchObject({
      strategy: "flat",
      nextStartingIndex: 3,
      itemCount: 3,
      complete: true,
    });
    expect(vi.mocked(beginSearchScope)).not.toHaveBeenCalled();
    expect(browseRequests()).toHaveLength(3);
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id))
      .toEqual(["ROOT_ALLAU_TR1", "ROOT_ALLAU_TR2", "ROOT_ALLAU_TR3"]);
  });

  it("clears a complete flat checkpoint when the live track snapshot changed", async () => {
    const olive = target("129");
    seedIncompleteCatalog(olive, [albumNode(10)]);
    catalogHarness.records.set(TRACK_CHECKPOINT_RESOURCE, {
      version: 2,
      protocol: "upnp",
      updateId: REVISION,
      nextStartingIndex: 3,
      totalMatches: 3,
      itemCount: 3,
      complete: true,
      containerUpdateId: "tracks-7",
      strategy: "flat",
      flatFallback: true,
    });
    catalogHarness.scopeChunks.set("tracks", new Map([
      ["0", [
        trackNode("ROOT_ALLAU_TR1"),
        trackNode("ROOT_ALLAU_TR2"),
        trackNode("ROOT_ALLAU_TR3"),
      ]],
    ]));
    installCatalogHandler((body) => {
      expect(body.objectId).toBe("ROOT_ALLAU");
      if (Number(body.requestedCount) === 1) {
        return jsonResponse(catalogPage(
          "ROOT_ALLAU",
          [trackObject("ROOT_ALLAU_TR10", "ROOT_ALLAU")],
          4,
          "tracks-8",
        ));
      }
      expect(body.startingIndex).toBe(0);
      expect(body.requestedCount).toBe(64);
      return jsonResponse(catalogPage(
        "ROOT_ALLAU",
        [
          trackObject("ROOT_ALLAU_TR10", "ROOT_ALLAU"),
          trackObject("ROOT_ALLAU_TR20", "ROOT_ALLAU"),
          trackObject("ROOT_ALLAU_TR30", "ROOT_ALLAU"),
          trackObject("ROOT_ALLAU_TR40", "ROOT_ALLAU"),
        ],
        4,
        "tracks-8",
      ));
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(completed.cursors.tracks).toMatchObject({
      strategy: "flat",
      itemCount: 4,
      totalMatches: 4,
      complete: true,
    });
    expect(vi.mocked(beginSearchScope)).toHaveBeenCalledOnce();
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id))
      .toEqual([
        "ROOT_ALLAU_TR10",
        "ROOT_ALLAU_TR20",
        "ROOT_ALLAU_TR30",
        "ROOT_ALLAU_TR40",
      ]);
  });

  it("idempotently clears a zero flat transition checkpoint before its first page", async () => {
    const olive = target("125");
    seedIncompleteCatalog(olive, [albumNode(10)]);
    catalogHarness.records.set(TRACK_CHECKPOINT_RESOURCE, {
      version: 2,
      protocol: "upnp",
      updateId: REVISION,
      nextStartingIndex: 0,
      totalMatches: null,
      itemCount: 0,
      complete: false,
      containerUpdateId: null,
      strategy: "flat",
      flatFallback: true,
    });
    catalogHarness.scopeChunks.set("tracks", new Map([
      ["album-0-offset-0", [
        trackNode("ROOT_ALLAL_AL10_TR999", "ROOT_ALLAL_AL10"),
      ]],
    ]));
    installCatalogHandler((body) => {
      expect(body.objectId).toBe("ROOT_ALLAU");
      expect(body.startingIndex).toBe(0);
      expect([1, 64]).toContain(body.requestedCount);
      return jsonResponse(catalogPage(
        "ROOT_ALLAU",
        [trackObject("ROOT_ALLAU_TR100", "ROOT_ALLAU")],
        1,
        "tracks-7",
      ));
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(completed.cursors.tracks).toMatchObject({
      strategy: "flat",
      itemCount: 1,
      complete: true,
    });
    expect(vi.mocked(beginSearchScope)).toHaveBeenCalledOnce();
    expect(vi.mocked(beginSearchScope)).toHaveBeenCalledWith(
      olive,
      "tracks",
      REVISION,
    );
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id))
      .toEqual(["ROOT_ALLAU_TR100"]);
  });

  it("refuses publication when a flat track page contains overlapping IDs", async () => {
    const olive = target("128");
    seedIncompleteCatalog(olive, [albumNode(10)]);
    catalogHarness.records.set(TRACK_CHECKPOINT_RESOURCE, {
      version: 2,
      protocol: "upnp",
      updateId: REVISION,
      nextStartingIndex: 0,
      totalMatches: null,
      itemCount: 0,
      complete: false,
      containerUpdateId: null,
      strategy: "flat",
      flatFallback: true,
    });
    installCatalogHandler((body) => {
      expect(body.objectId).toBe("ROOT_ALLAU");
      expect(body.startingIndex).toBe(0);
      if (Number(body.requestedCount) === 1) {
        return jsonResponse(catalogPage(
          "ROOT_ALLAU",
          [trackObject("ROOT_ALLAU_TR100", "ROOT_ALLAU", "First appearance")],
          2,
          "tracks-7",
        ));
      }
      expect(body.requestedCount).toBe(64);
      return jsonResponse(catalogPage(
        "ROOT_ALLAU",
        [
          trackObject("ROOT_ALLAU_TR100", "ROOT_ALLAU", "First appearance"),
          trackObject("ROOT_ALLAU_TR100", "ROOT_ALLAU", "Duplicate appearance"),
        ],
        2,
        "tracks-7",
      ));
    });

    await expect(syncLibraryCatalog(olive, vi.fn()))
      .rejects.toThrow("stored 1 unique canonical tracks");

    const storedManifest = catalogHarness.records.get(MANIFEST_RESOURCE) as LibraryCatalogManifest;
    expect(storedManifest.complete).toBe(false);
    expect(storedManifest.scopes.tracks).toBeUndefined();
    expect(storedManifest.cursors.tracks).toBeUndefined();
    expect(catalogHarness.records.get(TRACK_CHECKPOINT_RESOURCE)).toMatchObject({
      strategy: "flat",
      flatFallback: true,
      itemCount: 0,
      complete: false,
    });
    expect(vi.mocked(completeSearchScope)).not.toHaveBeenCalled();
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id))
      .toEqual(["ROOT_ALLAU_TR100"]);
  });

  it("clears duplicate fanout data before publishing a verified flat fallback", async () => {
    const olive = target("123");
    seedIncompleteCatalog(olive, [albumNode(10), albumNode(20)]);
    installCatalogHandler((body) => {
      const objectId = String(body.objectId);
      const requestedCount = Number(body.requestedCount);
      if (objectId === "ROOT_ALLAU" && requestedCount === 1) {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAU_TR100", objectId)],
          2,
          "tracks-7",
        ));
      }
      if (objectId === "ROOT_ALLAL_AL10") {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAL_AL10_TR100", objectId)],
          1,
        ));
      }
      if (objectId === "ROOT_ALLAL_AL20") {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAL_AL20_TR100", objectId)],
          1,
        ));
      }
      if (objectId === "ROOT_ALLAU" && requestedCount === 64) {
        return jsonResponse(catalogPage(objectId, [
          trackObject("ROOT_ALLAU_TR100", objectId),
          trackObject("ROOT_ALLAU_TR200", objectId),
        ], 2, "tracks-7"));
      }
      return jsonResponse({ error: `Unexpected browse ${objectId}.` }, 500);
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(completed.cursors.tracks).toMatchObject({
      strategy: "flat",
      itemCount: 2,
      complete: true,
    });
    expect(vi.mocked(beginSearchScope).mock.calls.map((call) => call[1]))
      .toEqual(["tracks", "tracks"]);
    const flatZeroWriteIndex = vi.mocked(writeDeviceCacheStrict).mock.calls.findIndex((call) =>
      call[1] === TRACK_CHECKPOINT_RESOURCE
      && (call[2] as { strategy?: string }).strategy === "flat"
      && (call[2] as { itemCount?: number }).itemCount === 0);
    expect(flatZeroWriteIndex).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(writeDeviceCacheStrict).mock.invocationCallOrder[flatZeroWriteIndex]!)
      .toBeLessThan(vi.mocked(beginSearchScope).mock.invocationCallOrder[1]!);
    expect(vi.mocked(appendSearchScopePage).mock.calls.map((call) => call[3]))
      .toEqual(["album-0-offset-0", "album-1-offset-0", "0"]);
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id))
      .toEqual(["ROOT_ALLAU_TR100", "ROOT_ALLAU_TR200"]);
  });

  it("enters the flat fallback after the third resumable failure of one album", async () => {
    const olive = target("124");
    seedIncompleteCatalog(olive, [albumNode(10)]);
    let albumRequestCount = 0;
    installCatalogHandler((body) => {
      const objectId = String(body.objectId);
      const requestedCount = Number(body.requestedCount);
      if (objectId === "ROOT_ALLAU" && requestedCount === 1) {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAU_TR100", objectId)],
          1,
          "tracks-7",
        ));
      }
      if (objectId === "ROOT_ALLAL_AL10") {
        albumRequestCount += 1;
        return jsonResponse({ error: "album unavailable" }, 502);
      }
      if (objectId === "ROOT_ALLAU" && requestedCount === 64) {
        return jsonResponse(catalogPage(
          objectId,
          [trackObject("ROOT_ALLAU_TR100", objectId)],
          1,
          "tracks-7",
        ));
      }
      return jsonResponse({ error: `Unexpected browse ${objectId}.` }, 500);
    });

    await expect(syncLibraryCatalog(olive, vi.fn())).rejects.toThrow("album unavailable");
    expect(catalogHarness.records.get(TRACK_CHECKPOINT_RESOURCE)).toMatchObject({
      strategy: "album-fanout",
      parentIndex: 0,
      parentFailureIndex: 0,
      parentFailureCount: 1,
    });

    await expect(syncLibraryCatalog(olive, vi.fn())).rejects.toThrow("album unavailable");
    expect(catalogHarness.records.get(TRACK_CHECKPOINT_RESOURCE)).toMatchObject({
      strategy: "album-fanout",
      parentIndex: 0,
      parentFailureIndex: 0,
      parentFailureCount: 2,
    });

    const completed = await syncLibraryCatalog(olive, vi.fn());

    expect(albumRequestCount).toBe(6);
    expect(completed.cursors.tracks).toMatchObject({
      strategy: "flat",
      itemCount: 1,
      complete: true,
    });
    expect(browseRequests().filter((body) =>
      body.objectId === "ROOT_ALLAU" && body.requestedCount === 64)).toHaveLength(1);
    expect(vi.mocked(beginSearchScope).mock.calls.filter((call) =>
      call[1] === "tracks")).toHaveLength(4);
  });

});
