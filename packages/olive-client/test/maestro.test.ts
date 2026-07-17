import { describe, expect, it } from "vitest";
import { parseCurrentPlayingId, parseMaestroTrackList, parseMaestroTree, parseTrackMetadata } from "../src/maestro.js";

describe("Maestro response parsing", () => {
  it("parses navigation XML and decodes entities", () => {
    const tree = parseMaestroTree(`<?xml version="1.0"?><tree id="0" totalItems="22">
      <item id="ROOT_ALLAL" text="Albums &amp; EPs" child="1">
        <userdata name="type">albumname</userdata>
      </item>
    </tree>`);
    expect(tree).toEqual({
      id: "0",
      totalItems: 22,
      items: [{ id: "ROOT_ALLAL", title: "Albums & EPs", childCount: 1, userData: { type: "albumname" } }],
    });
  });

  it("parses an empty tree", () => {
    expect(parseMaestroTree('<tree id="0"></tree>').items).toEqual([]);
  });

  it("extracts the private current-playing identifier", () => {
    expect(parseCurrentPlayingId("inf_showcurrentplaying( 'track-42' );")).toBe("track-42");
    expect(parseCurrentPlayingId("inf_showcurrentplaying('');")).toBeNull();
  });

  it("parses current-track metadata from the legacy callback", () => {
    const result = parseTrackMetadata(`new_info('{"track":{"id":"42","track":"Blue","album":"Green","artist":"Ada","genre":"Jazz","albumart":"/art.jpg","playcount":"3","myRating":4}}');`);
    expect(result).toMatchObject({
      id: "42", title: "Blue", album: "Green", artist: "Ada", genre: "Jazz",
      artworkPath: "/art.jpg", playCount: 3, rating: 4,
    });
  });

  it("preserves a private HTTP artwork URL including its port", () => {
    const result = parseTrackMetadata(`new_info('{"track":{"id":"42","albumart":"http://192.168.50.10:8163/albumart/42.jpg"}}');`);
    expect(result.artworkPath).toBe("http://192.168.50.10:8163/albumart/42.jpg");
  });

  it("parses the legacy JSON track list", () => {
    expect(parseMaestroTrackList('{"0":{"id":"7","title":"Song","isDir":"0"},"totalItems":"1","startindex":"0","itemsReturned":"1"}')).toEqual({
      id: "tracks",
      totalItems: 1,
      items: [{ id: "7", title: "Song", childCount: 0, userData: { type: "track", playbackIndex: "1" } }],
    });
  });

  it("preserves the one-based playback index used by the original track list", () => {
    const result = parseMaestroTrackList('{"0":{"id":"7","title":"Song","isDir":"0"},"1":{"id":"8","title":"Next","isDir":"0"},"startindex":"64","itemsReturned":"2"}');
    expect(result.items.map((item) => item.userData.playbackIndex)).toEqual(["65", "66"]);
  });
});
