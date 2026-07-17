import { describe, expect, it } from "vitest";
import { parseCurrentPlayingId, parseMaestroTrackList, parseMaestroTree, parsePlaybackStatus, parseTimeSeconds, parseTrackMetadata } from "../src/maestro.js";

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

  it("removes double-encoded punctuation from browse titles", () => {
    const tree = parseMaestroTree(`<tree id="0"><item id="album-1" text="Don&amp;#39;t Stop &amp;amp; Listen" child="1" /></tree>`);
    expect(tree.items[0]?.title).toBe("Don't Stop & Listen");
  });

  it("parses an empty tree", () => {
    expect(parseMaestroTree('<tree id="0"></tree>').items).toEqual([]);
  });

  it("extracts the private current-playing identifier", () => {
    expect(parseCurrentPlayingId("inf_showcurrentplaying( 'track-42' );")).toBe("track-42");
    expect(parseCurrentPlayingId("inf_showcurrentplaying('');")).toBeNull();
  });

  it("parses current-track metadata from the legacy callback", () => {
    const result = parseTrackMetadata(`new_info('{"track":{"id":"42","track":"Blue &amp; Gold","album":"Green","artist":"Ada","genre":"Jazz","albumart":"/art.jpg","playcount":"3","myRating":4}}');`);
    expect(result).toMatchObject({
      id: "42", title: "Blue & Gold", album: "Green", artist: "Ada", genre: "Jazz",
      artworkPath: "/art.jpg", playCount: 3, rating: 4,
    });
  });

  it("decodes double-encoded decimal and hexadecimal punctuation in track metadata", () => {
    const result = parseTrackMetadata(`new_info('{"track":{"id":"42","track":"What&amp;#039;s New&amp;#x3f;","artist":"Simon &amp;amp; Garfunkel"}}');`);
    expect(result).toMatchObject({ title: "What's New?", artist: "Simon & Garfunkel" });
  });

  it("preserves a private HTTP artwork URL including its port", () => {
    const result = parseTrackMetadata(`new_info('{"track":{"id":"42","albumart":"http://192.168.50.10:8163/albumart/42.jpg"}}');`);
    expect(result.artworkPath).toBe("http://192.168.50.10:8163/albumart/42.jpg");
  });

  it("normalizes device-relative artwork and hides the legacy missing-art image", () => {
    expect(parseTrackMetadata(`new_info('{"track":{"id":"42","albumart":"albumart/42.jpg"}}');`)?.artworkPath).toBe("/albumart/42.jpg");
    expect(parseTrackMetadata(`new_info('{"track":{"id":"42","albumart":"images/artworknotfound.gif"}}');`)?.artworkPath).toBe("");
  });

  it("parses legacy track duration and live playback position", () => {
    const metadata = parseTrackMetadata(`new_info('{"track":{"id":"42","duration":"00:04:05"}}');`);
    expect(metadata?.durationSeconds).toBe(245);
    expect(parseTimeSeconds("4:05")).toBe(245);
    expect(parsePlaybackStatus('{"TransportState":"PLAYING","RelativeTimePosition":"00:01:12","TrackDuration":"00:04:05"}')).toEqual({
      transportState: "playing", positionSeconds: 72, durationSeconds: 245,
    });
  });

  it("parses nested state-change playback data and tolerates invalid status", () => {
    expect(parsePlaybackStatus('{"playmediainfo":{"TransportState":"PAUSED_PLAYBACK","RelativeTimePosition":"0:09"}}')).toMatchObject({
      transportState: "paused", positionSeconds: 9,
    });
    expect(parsePlaybackStatus("not-json")).toEqual({ transportState: "unknown", positionSeconds: null, durationSeconds: null });
  });

  it("parses the legacy JSON track list", () => {
    expect(parseMaestroTrackList('{"0":{"id":"7","title":"Song","isDir":"0"},"totalItems":"1","startindex":"0","itemsReturned":"1"}')).toEqual({
      id: "tracks",
      totalItems: 1,
      items: [{ id: "7", title: "Song", childCount: 0, userData: { type: "track", playbackIndex: "1" } }],
    });
  });

  it("decodes double-encoded punctuation in JSON track lists", () => {
    const result = parseMaestroTrackList('{"0":{"id":"7","title":"Rock &amp;#39;n&amp;#39; Roll","isDir":"0"}}');
    expect(result.items[0]?.title).toBe("Rock 'n' Roll");
  });

  it("preserves the one-based playback index used by the original track list", () => {
    const result = parseMaestroTrackList('{"0":{"id":"7","title":"Song","isDir":"0"},"1":{"id":"8","title":"Next","isDir":"0"},"startindex":"64","itemsReturned":"2"}');
    expect(result.items.map((item) => item.userData.playbackIndex)).toEqual(["65", "66"]);
  });
});
