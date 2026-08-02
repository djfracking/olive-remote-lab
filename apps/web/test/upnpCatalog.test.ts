import { describe, expect, it } from "vitest";
import type { UpnpDidlObject } from "@olive-remote-lab/olive-client";
import {
  maestroPlaybackId,
  normalizeUpnpArtworkUri,
  scopeForUpnpObject,
  scopeForUpnpTreeNode,
  shouldApplyUpnpPageResponse,
  upnpPageCursor,
  upnpObjectToTreeNode,
  withMaestroMapping,
} from "../src/upnpCatalog";

const target = { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-1" };

function object(overrides: Partial<UpnpDidlObject> = {}): UpnpDidlObject {
  return {
    kind: "item",
    identifiers: { maestroId: null, upnpId: "UPNP-42", upnpRefId: "REF-42", upnpParentId: "ALBUM-1" },
    id: "UPNP-42",
    refId: "REF-42",
    parentId: "ALBUM-1",
    restricted: true,
    searchable: null,
    childCount: 0,
    className: "object.item.audioItem.musicTrack",
    title: "Dancing Queen",
    artist: "ABBA",
    artists: ["ABBA"],
    album: "Arrival",
    genre: "Pop",
    genres: ["Pop"],
    creator: "Benny Andersson",
    albumArtUri: "http://192.168.0.112:49152/art/arrival.jpg?size=large",
    resources: [],
    resourceUri: "http://192.168.0.112:49152/audio/42",
    resourceProtocolInfo: "http-get:*:audio/flac:*",
    duration: "00:03:51",
    durationSeconds: 231,
    ...overrides,
  };
}

describe("UPnP catalog adaptation", () => {
  it("keeps UPnP and Maestro identifiers explicitly separate", () => {
    const item = upnpObjectToTreeNode(target, object(), "tracks");
    expect(item.id).toBe("UPNP-42");
    expect(item.userData).toMatchObject({
      source: "upnp",
      upnpId: "UPNP-42",
      upnpRefId: "REF-42",
      upnpParentId: "ALBUM-1",
    });
    expect(item.userData.maestroId).toBeUndefined();
    expect(maestroPlaybackId(item)).toBeNull();
    expect(maestroPlaybackId(withMaestroMapping(item, "ROOT_ALLAU_TR42"))).toBe("ROOT_ALLAU_TR42");
  });

  it("stores same-device sleeve art as a relocatable path", () => {
    expect(normalizeUpnpArtworkUri(target, object().albumArtUri))
      .toBe("http://192.168.0.112:49152/art/arrival.jpg?size=large");
    expect(normalizeUpnpArtworkUri(target, "http://192.168.0.113/art/other.jpg"))
      .toBe("http://192.168.0.113/art/other.jpg");
  });

  it("uses explicit class metadata and the composer-root fallback", () => {
    expect(scopeForUpnpObject(object(), "albums")).toBe("tracks");
    expect(scopeForUpnpObject(object({
      kind: "container",
      className: "object.container.person.musicArtist",
    }), "composers")).toBe("composers");
    expect(scopeForUpnpObject(object({
      kind: "container",
      className: "object.container.artist",
    }), "albums")).toBe("artists");
    expect(scopeForUpnpObject(object({
      kind: "container",
      className: "object.container.composer",
    }), "albums")).toBe("composers");
  });

  it("uses explicit parent identities to separate generic composers, artists, and albums", () => {
    expect(scopeForUpnpObject(object({
      kind: "container",
      className: "object.container.person",
      identifiers: {
        maestroId: null,
        upnpId: "opaque-composer",
        upnpRefId: null,
        upnpParentId: "ROOT_ALLCO_CO1",
      },
    }), "albums")).toBe("composers");
    expect(scopeForUpnpObject(object({
      kind: "container",
      className: "object.container.person",
      identifiers: {
        maestroId: null,
        upnpId: "opaque-artist",
        upnpRefId: null,
        upnpParentId: "ROOT_ALLAR_AR1",
      },
    }), "albums")).toBe("artists");
    const album = upnpObjectToTreeNode(target, object({
      kind: "container",
      className: "object.container",
      identifiers: {
        maestroId: null,
        upnpId: "opaque-album",
        upnpRefId: null,
        upnpParentId: "ROOT_ALLAL_AL1",
      },
    }), "artists");
    expect(scopeForUpnpTreeNode(album, "artists")).toBe("albums");
  });

  it("advances pages by NumberReturned and rejects a mismatched payload", () => {
    const objects = [object({ id: "1" }), object({ id: "2" }), object({ id: "3" })];
    const cursor = upnpPageCursor("browse", "album:1", 64, 64, {
      numberReturned: 3,
      totalMatches: 100,
      objects,
    });
    expect(cursor).toMatchObject({
      startingIndex: 64,
      numberReturned: 3,
      nextStartingIndex: 67,
      complete: false,
    });
    expect(() => upnpPageCursor("search", "abba", 0, 64, {
      numberReturned: 2,
      totalMatches: 3,
      objects,
    })).toThrow(/count/i);
    expect(() => upnpPageCursor("browse", "album:1", 64, 64, {
      numberReturned: 0,
      totalMatches: 100,
      objects: [],
    })).toThrow(/empty page/i);
    expect(upnpPageCursor("search", "abba", 0, 64, {
      numberReturned: 3,
      totalMatches: 0,
      objects,
    })).toMatchObject({ totalMatches: null, complete: true });
    const fullUnknownPage = Array.from({ length: 64 }, (_, index) => object({ id: String(index) }));
    expect(upnpPageCursor("search", "same-title", 0, 64, {
      numberReturned: 64,
      totalMatches: 0,
      objects: fullUnknownPage,
    })).toMatchObject({ totalMatches: null, complete: false, nextStartingIndex: 64 });
  });

  it("accepts a page response only for the same revision, target, and request", () => {
    expect(shouldApplyUpnpPageResponse(7, 7, "olive:a", "olive:a", "albums@64", "albums@64")).toBe(true);
    expect(shouldApplyUpnpPageResponse(7, 8, "olive:a", "olive:a", "albums@64", "albums@64")).toBe(false);
    expect(shouldApplyUpnpPageResponse(7, 7, "olive:a", "olive:b", "albums@64", "albums@64")).toBe(false);
    expect(shouldApplyUpnpPageResponse(7, 7, "olive:a", "olive:a", "albums@64", "albums@128")).toBe(false);
  });
});
