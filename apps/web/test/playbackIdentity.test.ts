import { describe, expect, it } from "vitest";
import type { MaestroTreeNode } from "@olive-remote-lab/olive-client";
import {
  derivedMaestroPlaybackId,
  uniqueCanonicalUpnpPlaybackMatch,
  uniqueExactMaestroMatch,
} from "../src/playbackIdentity";

function track(id: string, title: string, artist = "ABBA", album = "Arrival"): MaestroTreeNode {
  return { id, title, childCount: 0, userData: { type: "track", artist, album } };
}

describe("UPnP to Maestro playback identity", () => {
  const upnp = {
    ...track("UPNP-42", "Dáncing Queen"),
    userData: { type: "track", source: "upnp", upnpId: "UPNP-42", artist: "ABBA", album: "Arrival" },
  };

  it("maps only one exact normalized metadata match", () => {
    expect(uniqueExactMaestroMatch(upnp, [
      track("ROOT_ALLAU_TR1", "Dancing Queen"),
      track("ROOT_ALLAU_TR2", "Mamma Mia"),
    ])?.id).toBe("ROOT_ALLAU_TR1");
  });

  it("accepts one exact-title result when legacy firmware omits artist and album", () => {
    expect(uniqueExactMaestroMatch(upnp, [
      track("ROOT_ALLAL_AL6_TR37", "Dancing Queen", "", ""),
    ])?.id).toBe("ROOT_ALLAL_AL6_TR37");
  });

  it("quarantines ambiguous and metadata-mismatched candidates", () => {
    expect(uniqueExactMaestroMatch(upnp, [
      track("ROOT_ALLAU_TR1", "Dancing Queen"),
      track("ROOT_ALLAU_TR2", "Dancing Queen"),
    ])).toBeNull();
    expect(uniqueExactMaestroMatch(upnp, [
      track("ROOT_ALLAU_TR3", "Dancing Queen", "Cover Band"),
    ])).toBeNull();
  });

  it("derives only the physically verified O4 album-track identity shape", () => {
    expect(derivedMaestroPlaybackId({
      ...track("ROOT_ALLAR_AR57411_AL57410_TR57414", "Take a Chance of Me"),
      userData: {
        type: "track",
        source: "upnp",
        objectKind: "item",
        upnpId: "ROOT_ALLAR_AR57411_AL57410_TR57414",
      },
    })).toBe("ROOT_ALLAL_AL57410_TR57414");
    expect(derivedMaestroPlaybackId({
      ...track("ROOT_ALLAU_TR57414", "Take a Chance of Me"),
      userData: { type: "track", source: "upnp", objectKind: "item", upnpId: "ROOT_ALLAU_TR57414" },
    })).toBeNull();
    expect(derivedMaestroPlaybackId({
      ...track("ROOT_ALLAR_ARX_ALY_TRZ", "Untrusted shape"),
      userData: { type: "track", source: "upnp", objectKind: "item", upnpId: "ROOT_ALLAR_ARX_ALY_TRZ" },
    })).toBeNull();
    expect(derivedMaestroPlaybackId({
      ...track("ROOT_ALLCO_CO57411_AL57410_TR57414", "Unverified tree"),
      userData: {
        type: "track",
        source: "upnp",
        objectKind: "item",
        upnpId: "ROOT_ALLCO_CO57411_AL57410_TR57414",
      },
    })).toBeNull();
  });

  it("accepts only one exact canonical album-tree result from UPnP search", () => {
    const globalTrack = {
      ...track("ROOT_ALLAU_TR57415", "I Have a Dream", "ABBA", "ABBA Gold Greatest Hits"),
      userData: {
        type: "track",
        source: "upnp",
        objectKind: "item",
        upnpId: "ROOT_ALLAU_TR57415",
        artist: "ABBA",
        album: "ABBA Gold Greatest Hits",
      },
    };
    const canonical = {
      ...track("ROOT_ALLAL_AL57410_TR57415", "I Have a Dream", "ABBA", "ABBA Gold Greatest Hits"),
      userData: {
        type: "track",
        source: "upnp",
        objectKind: "item",
        upnpId: "ROOT_ALLAL_AL57410_TR57415",
        artist: "ABBA",
        album: "ABBA Gold Greatest Hits",
      },
    };
    expect(uniqueCanonicalUpnpPlaybackMatch(globalTrack, [canonical])?.id)
      .toBe("ROOT_ALLAL_AL57410_TR57415");
    expect(uniqueCanonicalUpnpPlaybackMatch(globalTrack, [
      canonical,
      { ...canonical, id: "ROOT_ALLAL_AL999_TR57415", userData: { ...canonical.userData, upnpId: "ROOT_ALLAL_AL999_TR57415" } },
    ])).toBeNull();
    expect(uniqueCanonicalUpnpPlaybackMatch(globalTrack, [{
      ...canonical,
      id: "ROOT_ALLAU_TR57415",
      userData: { ...canonical.userData, upnpId: "ROOT_ALLAU_TR57415" },
    }])).toBeNull();
  });
});
