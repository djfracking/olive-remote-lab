import { describe, expect, it } from "vitest";
import type { MaestroTreeNode } from "@olive-remote-lab/olive-client";
import {
  nextCatalogPage,
  searchResultBrowseType,
  searchResultIdentity,
  searchResultScope,
  serverSearchRequired,
  shouldApplyRootSearch,
} from "../src/components/SearchView";

function item(id: string, type: string): MaestroTreeNode {
  return {
    id,
    title: "Test item",
    userData: { type },
  };
}

describe("search result routing", () => {
  it("does not let an index refresh replace an open artist or album", () => {
    expect(shouldApplyRootSearch(4, 4, 0)).toBe(true);
    expect(shouldApplyRootSearch(4, 4, 1)).toBe(false);
    expect(shouldApplyRootSearch(4, 4, 0, true)).toBe(false);
    expect(shouldApplyRootSearch(4, 5, 0)).toBe(false);
  });

  it("opens an artist result as an artist even when Olive labels it as a compilation", () => {
    const artist = item("ROOT_ALLAR_AR57411", "compilation");
    expect(searchResultScope(artist, "artists")).toBe("artists");
    expect(searchResultBrowseType(artist, "artists")).toBe("artists");
  });

  it("opens an artist child album as an album even when Olive labels it as an interpreter", () => {
    const album = item("ROOT_ALLAR_AR57411_AL57410", "interpreter");
    expect(searchResultScope(album, "artists")).toBe("albums");
    expect(searchResultBrowseType(album, "artists")).toBe("compilation");
  });

  it("opens a direct album result as an album", () => {
    const album = item("ROOT_ALLAL_AL57410", "compilation");
    expect(searchResultScope(album, "albums")).toBe("albums");
    expect(searchResultBrowseType(album, "albums")).toBe("compilation");
  });

  it("preserves direct track playback routing", () => {
    const track = item("ROOT_ALLAL_AL57410_TR57424", "track");
    expect(searchResultScope(track, "albums")).toBe("tracks");
    expect(searchResultBrowseType(track, "albums")).toBe("track");
  });

  it("deduplicates the same UPnP track across global and canonical album trees", () => {
    const global = item("ROOT_ALLAU_TR57415", "track");
    global.userData = {
      ...global.userData,
      source: "upnp",
      objectKind: "item",
      upnpId: global.id,
    };
    const canonical = item("ROOT_ALLAL_AL57410_TR57415", "track");
    canonical.userData = {
      ...canonical.userData,
      source: "upnp",
      objectKind: "item",
      upnpId: canonical.id,
    };
    expect(searchResultIdentity(global, "tracks"))
      .toBe(searchResultIdentity(canonical, "tracks"));
  });

  it("keeps Olive's explicit track type as a fallback for legacy IDs", () => {
    const track = item("LEGACY_TRACK_ID", "track");
    expect(searchResultScope(track, "albums")).toBe("tracks");
    expect(searchResultBrowseType(track, "albums")).toBe("track");
  });

  it("routes UPnP containers from explicit metadata rather than ID suffix guesses", () => {
    const artist = item("opaque-42", "artists");
    artist.userData = {
      ...artist.userData,
      source: "upnp",
      upnpId: "opaque-42",
      upnpClass: "object.container.person.musicArtist",
    };
    expect(searchResultScope(artist, "albums")).toBe("artists");
    expect(searchResultBrowseType(artist, "albums")).toBe("artists");
  });

  it("routes a generic UPnP person under the composer root as a composer", () => {
    const composer = item("opaque-43", "artists");
    composer.userData = {
      ...composer.userData,
      source: "upnp",
      objectKind: "container",
      upnpId: "opaque-43",
      upnpClass: "object.container.person",
      upnpParentId: "ROOT_ALLCO_CO1",
    };
    expect(searchResultScope(composer, "albums")).toBe("composers");
    expect(searchResultBrowseType(composer, "albums")).toBe("composer");
  });

  it("advances drilldown paging by the actual returned object count", () => {
    expect(nextCatalogPage(64, 7)).toBe(71);
  });

  it("uses server search until both the manifest and every scope are complete", () => {
    expect(serverSearchRequired(null, 0)).toBe(true);
    expect(serverSearchRequired({ complete: false }, 0)).toBe(true);
    expect(serverSearchRequired({ complete: true }, 1)).toBe(true);
    expect(serverSearchRequired({ complete: true }, 0)).toBe(false);
  });
});
