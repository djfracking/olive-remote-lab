import { describe, expect, it } from "vitest";
import type { MaestroTreeNode } from "@olive-remote-lab/olive-client";
import { playbackContextForSelection } from "../src/playback/playbackContext";

function track(id: string, artist: string, album: string): MaestroTreeNode {
  return {
    id,
    title: id,
    childCount: 0,
    userData: { type: "track", artist, album },
  };
}

describe("playback collection context", () => {
  const firstAlbum = [
    track("a1", "ABBA", "Gold"),
    track("a2", "ABBA", "Gold"),
  ];
  const secondAlbum = [
    track("a3", "ABBA", "Voyage"),
    track("b1", "Bee Gees", "Gold"),
  ];
  const broadListing = [...firstAlbum, ...secondAlbum];

  it("keeps an explicitly opened artist or album in its visible order", () => {
    expect(playbackContextForSelection(firstAlbum[0]!, broadListing, "explicit"))
      .toEqual(broadListing);
  });

  it("narrows a broad listing to the selected artist and album", () => {
    expect(playbackContextForSelection(firstAlbum[0]!, broadListing, "automatic"))
      .toEqual(firstAlbum);
  });

  it("falls back to the artist when album metadata is unavailable", () => {
    const artistTracks = [
      track("a1", "ABBA", ""),
      track("a2", "ABBA", ""),
      track("b1", "Bee Gees", ""),
    ];
    expect(playbackContextForSelection(artistTracks[0]!, artistTracks, "automatic"))
      .toEqual(artistTracks.slice(0, 2));
  });

  it("uses only the selected track when no collection identity exists", () => {
    const unknown = [track("one", "", ""), track("two", "", "")];
    expect(playbackContextForSelection(unknown[0]!, unknown, "automatic"))
      .toEqual([unknown[0]]);
  });
});
