import { describe, expect, it } from "vitest";
import {
  advanceAlbumFanoutCursor,
  albumFanoutCoversExhaustedTrackRoot,
  albumFanoutMatchesTrackTotal,
  AUTOMATIC_CATALOG_SCOPES,
  artistIndexMatchesCatalog,
  canResumeAlbumFanout,
  canResumeFlatUpnpCatalog,
  canPublishCatalogRevision,
  canResumeCatalogRevision,
  cachedScopeMatchesProbe,
  flatTrackIndexMatchesCrawl,
  LIBRARY_SEARCH_SCOPES,
  missingLibrarySearchScopes,
  nextAlbumFanoutFailure,
  nextCatalogCursor,
  shouldContinueFlatTrackFallback,
  trackCatalogSnapshotMatches,
  upnpCatalogPageFinished,
  upnpTotalMatches,
  type ArtistIndexCache,
  type LibraryCatalogManifest,
} from "../src/libraryCatalog";
import type { SearchDocument } from "../src/searchIndex";

function manifest(scopes: LibraryCatalogManifest["scopes"]): LibraryCatalogManifest {
  const cursors = Object.fromEntries(Object.entries(scopes).map(([scope, count]) => [
    scope,
    { nextStartingIndex: count, totalMatches: count, itemCount: count, complete: true, containerUpdateId: "7" },
  ])) as LibraryCatalogManifest["cursors"];
  return {
    version: 2,
    protocol: "upnp",
    deviceId: "upnp:uuid:test",
    updateId: "20001",
    complete: true,
    completedAt: 1,
    itemCount: Object.values(scopes).reduce((sum, count) => sum + (count ?? 0), 0),
    scopes,
    cursors,
  };
}

function document(id: string): SearchDocument {
  return {
    key: `albums:${id}`,
    scope: "albums",
    item: { id, title: `Album ${id}`, childCount: 0, userData: { type: "album" } },
    searchable: `album ${id}`,
    updatedAt: 1,
  };
}

function upnpTrackDocument(id: string): SearchDocument {
  return {
    key: `tracks:upnp:${id}`,
    scope: "tracks",
    item: {
      id,
      title: `Track ${id}`,
      childCount: 0,
      userData: {
        type: "track",
        source: "upnp",
        objectKind: "item",
        upnpId: id,
      },
    },
    searchable: `track ${id}`,
    updatedAt: 1,
  };
}

describe("revision-aware library catalog strategy", () => {
  it("automatically mirrors every searchable root, including tracks and composers", () => {
    expect(AUTOMATIC_CATALOG_SCOPES).toEqual(["artists", "albums", "genres", "playlists", "composers", "tracks"]);
  });

  it("uses server search only for scopes that are not fully local", () => {
    expect(missingLibrarySearchScopes(null)).toEqual(LIBRARY_SEARCH_SCOPES);
    expect(missingLibrarySearchScopes(manifest({
      artists: 900,
      albums: 4_000,
      playlists: 20,
      genres: 30,
    }))).toEqual(["composers", "tracks"]);
  });

  it("keeps a legacy complete track index fully local", () => {
    expect(missingLibrarySearchScopes(manifest({
      tracks: 45_683,
      artists: 900,
      albums: 4_000,
      playlists: 20,
      genres: 30,
      composers: 400,
    }))).toEqual([]);
  });

  it("advances from the actual UPnP NumberReturned and resumes only the same revision", () => {
    expect(nextCatalogCursor(64, 17)).toBe(81);
    expect(canResumeCatalogRevision({ protocol: "upnp", updateId: "20001" }, "upnp", "20001")).toBe(true);
    expect(canResumeCatalogRevision({ protocol: "upnp", updateId: "20001" }, "upnp", "20002")).toBe(false);
    expect(canResumeCatalogRevision({ protocol: "maestro", updateId: "20001" }, "upnp", "20001")).toBe(false);
  });

  it("resumes album fanout only from a fully specified cursor for the same UPnP revision", () => {
    expect(canResumeAlbumFanout({
      protocol: "upnp",
      updateId: "20001",
      strategy: "album-fanout",
      parentIndex: 12,
      parentStartingIndex: 64,
    }, "20001")).toBe(true);
    expect(canResumeAlbumFanout({
      protocol: "upnp",
      updateId: "20002",
      strategy: "album-fanout",
      parentIndex: 12,
      parentStartingIndex: 64,
    }, "20001")).toBe(false);
    expect(canResumeAlbumFanout({
      protocol: "upnp",
      updateId: "20001",
      strategy: "flat",
      parentIndex: 12,
      parentStartingIndex: 64,
    }, "20001")).toBe(false);
    expect(canResumeAlbumFanout({
      protocol: "upnp",
      updateId: "20001",
      strategy: "album-fanout",
      parentIndex: -1,
      parentStartingIndex: 0,
    }, "20001")).toBe(false);
  });

  it("keeps an album update ID only across pages of that same album", () => {
    const firstPage = advanceAlbumFanoutCursor({
      parentIndex: 12,
      parentStartingIndex: 0,
      parentContainerUpdateId: null,
      pageUpdateId: "album-7",
      numberReturned: 64,
      totalMatches: 100,
    });
    expect(firstPage).toEqual({
      parentIndex: 12,
      parentStartingIndex: 64,
      parentContainerUpdateId: "album-7",
      albumFinished: false,
    });
    expect(advanceAlbumFanoutCursor({
      parentIndex: firstPage.parentIndex,
      parentStartingIndex: firstPage.parentStartingIndex,
      parentContainerUpdateId: firstPage.parentContainerUpdateId,
      pageUpdateId: "album-7",
      numberReturned: 36,
      totalMatches: 100,
    })).toEqual({
      parentIndex: 13,
      parentStartingIndex: 0,
      parentContainerUpdateId: null,
      albumFinished: true,
    });
    expect(() => advanceAlbumFanoutCursor({
      parentIndex: 12,
      parentStartingIndex: 64,
      parentContainerUpdateId: "album-7",
      pageUpdateId: "album-8",
      numberReturned: 36,
      totalMatches: 100,
    })).toThrow("album changed");
  });

  it("keeps a same-revision flat fallback resumable without mixing fanout chunks", () => {
    expect(canResumeFlatUpnpCatalog({
      protocol: "upnp",
      updateId: "20001",
      strategy: "flat",
    }, "20001")).toBe(true);
    expect(canResumeFlatUpnpCatalog({
      protocol: "upnp",
      updateId: "20001",
    }, "20001")).toBe(true);
    expect(canResumeFlatUpnpCatalog({
      protocol: "upnp",
      updateId: "20001",
      strategy: "album-fanout",
    }, "20001")).toBe(false);
    expect(canResumeFlatUpnpCatalog({
      protocol: "upnp",
      updateId: "20002",
      strategy: "flat",
    }, "20001")).toBe(false);
  });

  it("distinguishes a verified flat fallback from a pre-fanout flat checkpoint", () => {
    const priorFlat = {
      protocol: "upnp" as const,
      updateId: "20001",
      strategy: "flat" as const,
    };
    expect(shouldContinueFlatTrackFallback(priorFlat, "20001")).toBe(false);
    expect(shouldContinueFlatTrackFallback({
      ...priorFlat,
      flatFallback: true,
    }, "20001")).toBe(true);
    expect(shouldContinueFlatTrackFallback({
      ...priorFlat,
      flatFallback: true,
    }, "20002")).toBe(false);
  });

  it("falls back only after three consecutive failures for the same album", () => {
    expect(nextAlbumFanoutFailure(undefined, undefined, 12)).toEqual({
      parentFailureIndex: 12,
      parentFailureCount: 1,
      shouldFallback: false,
    });
    expect(nextAlbumFanoutFailure(12, 1, 12)).toEqual({
      parentFailureIndex: 12,
      parentFailureCount: 2,
      shouldFallback: false,
    });
    expect(nextAlbumFanoutFailure(12, 2, 12)).toEqual({
      parentFailureIndex: 12,
      parentFailureCount: 3,
      shouldFallback: true,
    });
    expect(nextAlbumFanoutFailure(11, 9, 12)).toEqual({
      parentFailureIndex: 12,
      parentFailureCount: 1,
      shouldFallback: false,
    });
  });

  it("publishes album fanout only for the exact canonical unique track total", () => {
    const tracks = [
      upnpTrackDocument("ROOT_ALLAL_AL10_TR100"),
      upnpTrackDocument("ROOT_ALLAL_AL20_TR200"),
    ];
    expect(albumFanoutMatchesTrackTotal(2, tracks)).toBe(true);
    expect(albumFanoutMatchesTrackTotal(3, tracks)).toBe(false);
    expect(albumFanoutMatchesTrackTotal(null, tracks)).toBe(false);
    expect(albumFanoutMatchesTrackTotal(2, [
      tracks[0]!,
      upnpTrackDocument("ROOT_ALLAL_AL20_TR100"),
    ])).toBe(false);
    expect(albumFanoutMatchesTrackTotal(2, [
      tracks[0]!,
      upnpTrackDocument("ROOT_ALLAU_TR200"),
    ])).toBe(false);
  });

  it("accepts only the proven off-by-one root total after positive enumeration is exhausted", () => {
    const tracks = [
      upnpTrackDocument("ROOT_ALLAL_AL10_TR100"),
      upnpTrackDocument("ROOT_ALLAL_AL20_TR200"),
    ];
    const root = { numberReturned: 1, totalMatches: 3, objects: [{} as never] };
    const exhausted = { numberReturned: 0, totalMatches: 3, objects: [] };
    expect(albumFanoutCoversExhaustedTrackRoot(3, tracks, root, exhausted)).toBe(true);
    expect(albumFanoutCoversExhaustedTrackRoot(4, tracks, {
      ...root,
      totalMatches: 4,
    }, {
      ...exhausted,
      totalMatches: 4,
    })).toBe(false);
    expect(albumFanoutCoversExhaustedTrackRoot(3, tracks, root, {
      ...exhausted,
      numberReturned: 1,
    })).toBe(false);
    expect(albumFanoutCoversExhaustedTrackRoot(3, tracks, {
      ...root,
      numberReturned: 0,
      objects: [],
    }, exhausted)).toBe(false);
    expect(albumFanoutCoversExhaustedTrackRoot(3, [
      tracks[0]!,
      upnpTrackDocument("ROOT_ALLAL_AL20_TR100"),
    ], root, exhausted)).toBe(false);
  });

  it("rejects duplicate or incomplete flat track pages before local-only publication", () => {
    const tracks = [
      upnpTrackDocument("ROOT_ALLAU_TR100"),
      upnpTrackDocument("ROOT_ALLAU_TR200"),
    ];
    expect(flatTrackIndexMatchesCrawl(2, 2, tracks)).toBe(true);
    expect(flatTrackIndexMatchesCrawl(2, 3, tracks)).toBe(false);
    expect(flatTrackIndexMatchesCrawl(3, 3, tracks)).toBe(false);
    expect(flatTrackIndexMatchesCrawl(2, 2, [
      tracks[0]!,
      upnpTrackDocument("ROOT_ALLAL_AL20_TR100"),
    ])).toBe(false);
  });

  it("never publishes a mixed or incomplete catalog revision", () => {
    const cursors = Object.fromEntries(AUTOMATIC_CATALOG_SCOPES.map((scope) => [
      scope,
      { nextStartingIndex: 64, totalMatches: 64, itemCount: 64, complete: true, containerUpdateId: "7" },
    ]));
    expect(canPublishCatalogRevision("20001", "20001", cursors)).toBe(true);
    expect(canPublishCatalogRevision("20001", "20002", cursors)).toBe(false);
    expect(canPublishCatalogRevision("20001", "20001", {
      ...cursors,
      tracks: { nextStartingIndex: 64, totalMatches: 128, itemCount: 64, complete: false, containerUpdateId: "7" },
    })).toBe(false);
  });

  it("treats the track-root total as a firmware fallback revision signal", () => {
    const cursor = {
      nextStartingIndex: 45_682,
      totalMatches: 45_683,
      itemCount: 45_682,
      complete: true,
      containerUpdateId: null,
      strategy: "album-fanout" as const,
    };
    expect(trackCatalogSnapshotMatches(cursor, 45_683)).toBe(true);
    expect(trackCatalogSnapshotMatches(cursor, 45_410)).toBe(false);
    expect(trackCatalogSnapshotMatches({ ...cursor, complete: false }, 45_683)).toBe(false);
    expect(trackCatalogSnapshotMatches(cursor, null)).toBe(false);
    expect(trackCatalogSnapshotMatches({ ...cursor, itemCount: 45_681 }, 45_683)).toBe(false);
    expect(trackCatalogSnapshotMatches({
      ...cursor,
      strategy: "flat",
      itemCount: 45_683,
    }, 45_683)).toBe(true);
    expect(trackCatalogSnapshotMatches({
      ...cursor,
      strategy: "flat",
    }, 45_683)).toBe(false);
  });

  it("treats TotalMatches zero as unknown while non-empty pages continue", () => {
    expect(upnpTotalMatches(0, 64)).toBeNull();
    expect(upnpTotalMatches(0, 0, 64)).toBeNull();
    expect(upnpTotalMatches(0, 0, 0)).toBe(0);
    expect(upnpCatalogPageFinished({
      startingIndex: 0,
      numberReturned: 64,
      requestedCount: 64,
      totalMatches: null,
    })).toBe(false);
    expect(upnpCatalogPageFinished({
      startingIndex: 64,
      numberReturned: 17,
      requestedCount: 64,
      totalMatches: null,
    })).toBe(true);
  });

  it("rejects an empty page before a known reported end", () => {
    expect(() => upnpCatalogPageFinished({
      startingIndex: 64,
      numberReturned: 0,
      requestedCount: 64,
      totalMatches: 128,
    })).toThrow("empty page before the reported end");
  });

  it("accepts an artist artifact only for its exact device and revision", () => {
    const catalog = manifest({
      artists: 1,
      albums: 0,
      genres: 0,
      playlists: 0,
      composers: 0,
      tracks: 0,
    });
    const cache: ArtistIndexCache = {
      version: 2,
      deviceId: catalog.deviceId,
      updateId: catalog.updateId,
      completedAt: 1,
      tree: {
        id: "ROOT_ALLAR",
        totalItems: 1,
        items: [{ id: "AR1", title: "ABBA", childCount: 1, userData: { type: "artist" } }],
      },
    };
    expect(artistIndexMatchesCatalog(cache, catalog)).toBe(true);
    expect(artistIndexMatchesCatalog({ ...cache, updateId: "20002" }, catalog)).toBe(false);
    expect(artistIndexMatchesCatalog({ ...cache, deviceId: "upnp:uuid:other" }, catalog)).toBe(false);
    expect(artistIndexMatchesCatalog({ ...cache, tree: { ...cache.tree, items: [] } }, catalog)).toBe(false);
  });

  it("migrates a cached scope only when its count and first page match the Olive", () => {
    const cached = [document("1"), document("2"), document("3")];
    const firstPage = {
      id: "ROOT_ALLAL",
      totalItems: 3,
      items: cached.slice(0, 2).map((entry) => entry.item),
    };
    expect(cachedScopeMatchesProbe(cached, firstPage, true, 21)).toBe(true);
    expect(cachedScopeMatchesProbe(cached.slice(0, 2), firstPage, true, 21)).toBe(false);
    expect(cachedScopeMatchesProbe([document("9"), document("2"), document("3")], firstPage, true, 21)).toBe(false);
  });

  it("accepts an exact nonpaged first-page cache when no total is reported", () => {
    const cached = [document("1"), document("2")];
    expect(cachedScopeMatchesProbe(cached, {
      id: "playlists",
      totalItems: null,
      items: cached.map((entry) => entry.item),
    }, false, 21)).toBe(true);
  });

  it("does not guess completion from a full paged response without a total", () => {
    const cached = Array.from({ length: 21 }, (_, index) => document(String(index)));
    expect(cachedScopeMatchesProbe(cached, {
      id: "ROOT_ALLAL",
      totalItems: null,
      items: cached.map((entry) => entry.item),
    }, true, 21)).toBe(false);
  });
});
