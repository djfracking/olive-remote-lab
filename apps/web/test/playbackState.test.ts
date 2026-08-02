import { describe, expect, it } from "vitest";
import type {
  MaestroTrackMetadata,
  MaestroTreeNode,
  NowPlayingSnapshot,
  UpnpDidlObject,
} from "@olive-remote-lab/olive-client";
import {
  adjacentTrack,
  hasLivePositionTelemetry,
  inferredNaturalNext,
  isPlaybackContextBoundary,
  mergeMatchingObservation,
  normalizeObservation,
  observationIndicatesNaturalRollover,
  playbackProgress,
  playbackTrackFromNode,
  projectPosition,
  reconcileUpnpPlaybackObservation,
  renderingTelemetryFromPlayerState,
  snapshotForTrack,
  type UpnpPlayerStateResponse,
} from "../src/playback/playbackState";

function metadata(id: string, title: string, artworkPath: string): MaestroTrackMetadata {
  return {
    id,
    title,
    artworkPath,
    artist: "Artist",
    album: "Album",
    genre: "",
    durationSeconds: 240,
    playCount: null,
    rating: null,
    raw: {},
  };
}

function node(id: string, title: string, artworkPath = ""): MaestroTreeNode {
  return {
    id,
    title,
    childCount: 0,
    userData: { type: "track", albumart: artworkPath, artist: "Artist" },
  };
}

function didl(overrides: Partial<UpnpDidlObject> = {}): UpnpDidlObject {
  return {
    kind: "item",
    identifiers: {
      maestroId: null,
      upnpId: "upnp-object-1",
      upnpRefId: "upnp-track-1",
      upnpParentId: "album-1",
    },
    id: "upnp-object-1",
    refId: "upnp-track-1",
    parentId: "album-1",
    restricted: true,
    searchable: null,
    childCount: null,
    className: "object.item.audioItem.musicTrack",
    title: "Song",
    artist: "Artist",
    artists: ["Artist"],
    album: "Album",
    genre: "Rock",
    genres: ["Rock"],
    creator: "Artist",
    albumArtUri: "/art/song.jpg",
    resources: [],
    resourceUri: "http://192.168.0.112/media/song.flac",
    resourceProtocolInfo: "http-get:*:audio/flac:*",
    duration: "0:04:00",
    durationSeconds: 240,
    ...overrides,
  };
}

function playerState(overrides: Partial<UpnpPlayerStateResponse> = {}): UpnpPlayerStateResponse {
  const item = didl();
  return {
    available: true,
    sampledAt: 2_000,
    position: {
      track: 1,
      trackDuration: "0:04:00",
      trackDurationSeconds: 240,
      trackMetadata: [item],
      trackUri: item.resourceUri,
      relativeTime: "0:00:42",
      relativeTimeSeconds: 42,
      absoluteTime: "0:00:42",
      absoluteTimeSeconds: 42,
      relativeCount: null,
      absoluteCount: null,
    },
    transport: {
      currentTransportState: "PLAYING",
      currentTransportStatus: "OK",
      currentSpeed: "1",
    },
    media: null,
    rendering: { volume: 51, muted: false },
    ...overrides,
  };
}

describe("app-owned playback projection", () => {
  it("normalizes the artwork aliases used by Maestro browse nodes", () => {
    const track = playbackTrackFromNode(node("track-1", "Song", "covers/song.jpg"));
    expect(track.metadata).toMatchObject({
      id: "track-1",
      title: "Song",
      artworkPath: "/covers/song.jpg",
    });
  });

  it("never attaches another item's metadata or artwork to a new item", () => {
    const observed = normalizeObservation({
      itemId: "track-new",
      metadata: null,
      identitySource: "device",
      transportState: "playing",
      positionSeconds: 3,
      durationSeconds: null,
    }, metadata("track-old", "Old song", "/old.jpg"), 1_000);
    expect(observed).toMatchObject({ itemId: "track-new", metadata: null });
  });

  it("turns a stopped observation into an empty atomic snapshot", () => {
    const observed = normalizeObservation({
      itemId: "",
      metadata: null,
      identitySource: "none",
      transportState: "stopped",
      positionSeconds: null,
      durationSeconds: null,
    }, metadata("track-old", "Old song", "/old.jpg"), 1_000);
    expect(observed).toEqual({
      itemId: "",
      metadata: null,
      identitySource: "none",
      transportState: "stopped",
      positionSeconds: null,
      durationSeconds: null,
      sampledAt: 1_000,
    });
  });

  it("merges same-item telemetry without erasing canonical metadata", () => {
    const current = snapshotForTrack({ itemId: "track-1", metadata: metadata("track-1", "Song", "/right.jpg") }, 1_000);
    const incoming: NowPlayingSnapshot = {
      itemId: "track-1",
      metadata: null,
      identitySource: "device",
      transportState: "playing",
      positionSeconds: 45,
      durationSeconds: 240,
      sampledAt: 2_000,
    };
    expect(mergeMatchingObservation(current, incoming, 2_000)).toMatchObject({
      itemId: "track-1",
      metadata: { title: "Song", artworkPath: "/right.jpg" },
      positionSeconds: 45,
    });
  });

  it("projects one shared playhead from the canonical time anchor", () => {
    const current = snapshotForTrack({ itemId: "track-1", metadata: metadata("track-1", "Song", "") }, 1_000);
    expect(projectPosition({ ...current, positionSeconds: 12 }, 4_500)?.positionSeconds).toBe(15.5);
  });

  it("builds a determinate live progress value only from usable telemetry", () => {
    expect(playbackProgress(75, 300)).toEqual({
      positionSeconds: 75,
      durationSeconds: 300,
      percent: 25,
    });
    expect(playbackProgress(310, 300)?.percent).toBe(100);
    expect(playbackProgress(12, null)).toBeNull();
    expect(playbackProgress(null, 300)).toBeNull();
    expect(playbackProgress(12, 0)).toBeNull();
  });

  it("selects previous and next from the app-owned order", () => {
    const context = [node("one", "One"), node("two", "Two"), node("three", "Three")].map((item) => playbackTrackFromNode(item));
    expect(adjacentTrack(context, "two", "previous")?.itemId).toBe("one");
    expect(adjacentTrack(context, "two", "next")?.itemId).toBe("three");
    expect(adjacentTrack(context, "three", "next")).toBeNull();
    expect(isPlaybackContextBoundary(context, "three", "next")).toBe(true);
    expect(isPlaybackContextBoundary(context, "one", "previous")).toBe(true);
    expect(isPlaybackContextBoundary(context, "two", "next")).toBe(false);
    expect(isPlaybackContextBoundary(context, "outside", "next")).toBe(false);
  });

  it("infers the app-owned next item when weak telemetry resets at the natural end", () => {
    const context = [node("one", "One"), node("two", "Two")].map((item) => playbackTrackFromNode(item));
    const current: NowPlayingSnapshot = {
      ...snapshotForTrack(context[0]!, 1_000),
      positionSeconds: 238,
      durationSeconds: 240,
    };
    const incoming: NowPlayingSnapshot = {
      itemId: "one",
      metadata: null,
      identitySource: "command-fallback",
      transportState: "playing",
      positionSeconds: 2,
      durationSeconds: 210,
      sampledAt: 4_000,
    };
    expect(observationIndicatesNaturalRollover(current, incoming)).toBe(true);
    expect(inferredNaturalNext(context, current, incoming)?.itemId).toBe("two");
  });

  it("does not mistake an ordinary weak same-track observation for a rollover", () => {
    const context = [node("one", "One"), node("two", "Two")].map((item) => playbackTrackFromNode(item));
    const current: NowPlayingSnapshot = {
      ...snapshotForTrack(context[0]!, 1_000),
      positionSeconds: 80,
      durationSeconds: 240,
    };
    const incoming: NowPlayingSnapshot = {
      itemId: "one",
      metadata: null,
      identitySource: "command-fallback",
      transportState: "playing",
      positionSeconds: 83,
      durationSeconds: 240,
      sampledAt: 4_000,
    };
    expect(observationIndicatesNaturalRollover(current, incoming)).toBe(false);
    expect(inferredNaturalNext(context, current, incoming)).toBeNull();
  });

  it("keeps an app-owned Maestro identity while applying matching live UPnP telemetry", () => {
    const current: NowPlayingSnapshot = {
      ...snapshotForTrack({ itemId: "maestro-track-1", metadata: metadata("maestro-track-1", "Song", "/old.jpg") }, 1_000),
      positionSeconds: 10,
    };
    expect(reconcileUpnpPlaybackObservation(current, playerState())).toMatchObject({
      itemId: "maestro-track-1",
      identitySource: "device",
      transportState: "playing",
      positionSeconds: 42,
      durationSeconds: 240,
      metadata: {
        id: "maestro-track-1",
        title: "Song",
        artworkPath: "/art/song.jpg",
      },
    });
  });

  it("does not rewind a fresher app playhead when a slower legacy poll reuses older UPnP telemetry", () => {
    const current: NowPlayingSnapshot = {
      ...snapshotForTrack({ itemId: "maestro-track-1", metadata: metadata("maestro-track-1", "Song", "") }, 3_000),
      positionSeconds: 50,
    };
    expect(reconcileUpnpPlaybackObservation(current, playerState({ sampledAt: 2_000 }))).toMatchObject({
      itemId: "maestro-track-1",
      positionSeconds: 50,
      sampledAt: 3_000,
    });
  });

  it("uses a namespaced read-only identity when hardware changes to an unmapped UPnP track", () => {
    const current = snapshotForTrack({
      itemId: "maestro-track-1",
      metadata: metadata("maestro-track-1", "Old song", "/old.jpg"),
    }, 1_000);
    const nextItem = didl({
      title: "New song",
      identifiers: {
        maestroId: null,
        upnpId: "volatile-object-2",
        upnpRefId: "stable-track-2",
        upnpParentId: "album-2",
      },
      albumArtUri: "/art/new.jpg",
    });
    const observed = reconcileUpnpPlaybackObservation(current, playerState({
      position: {
        ...playerState().position!,
        trackMetadata: [nextItem],
        relativeTimeSeconds: 3,
      },
    }));
    expect(observed).toMatchObject({
      itemId: "upnp:stable-track-2",
      metadata: {
        id: "upnp:stable-track-2",
        title: "New song",
        artworkPath: "/art/new.jpg",
      },
      positionSeconds: 3,
    });
    expect(observed?.metadata?.raw).toMatchObject({
      source: "upnp",
      upnpId: "volatile-object-2",
      upnpRefId: "stable-track-2",
      maestroId: null,
    });
  });

  it("uses only an explicitly mapped Maestro ID from DIDL", () => {
    const mappedItem = didl({
      identifiers: {
        maestroId: "maestro-exact-9",
        upnpId: "upnp-object-9",
        upnpRefId: "upnp-track-9",
        upnpParentId: "album-9",
      },
    });
    const observed = reconcileUpnpPlaybackObservation(null, playerState({
      position: { ...playerState().position!, trackMetadata: [mappedItem] },
    }));
    expect(observed?.itemId).toBe("maestro-exact-9");
    expect(observed?.metadata?.id).toBe("maestro-exact-9");
  });

  it("clears stale song identity and artwork on a truthful stopped observation", () => {
    const current = snapshotForTrack({
      itemId: "maestro-track-1",
      metadata: metadata("maestro-track-1", "Song", "/old.jpg"),
    }, 1_000);
    expect(reconcileUpnpPlaybackObservation(current, playerState({
      transport: {
        currentTransportState: "STOPPED",
        currentTransportStatus: "OK",
        currentSpeed: "1",
      },
    }))).toEqual({
      itemId: "",
      metadata: null,
      identitySource: "none",
      transportState: "stopped",
      positionSeconds: null,
      durationSeconds: null,
      sampledAt: 2_000,
    });
  });

  it("publishes only bounded, confirmed RenderingControl readings", () => {
    expect(renderingTelemetryFromPlayerState(playerState())).toEqual({
      volumePercent: 51,
      muted: false,
      sampledAt: 2_000,
    });
    expect(renderingTelemetryFromPlayerState(playerState({
      rendering: { volume: 101, muted: null },
    }))).toBeNull();
    expect(renderingTelemetryFromPlayerState(playerState({
      rendering: { volume: null, muted: true },
    }))).toEqual({
      volumePercent: null,
      muted: true,
      sampledAt: 2_000,
    });
  });

  it("enables live scrubber telemetry only with both position and duration", () => {
    expect(hasLivePositionTelemetry(playerState())).toBe(true);
    expect(hasLivePositionTelemetry(playerState({
      position: { ...playerState().position!, trackDurationSeconds: null, trackMetadata: [] },
    }))).toBe(false);
    expect(hasLivePositionTelemetry(playerState({ available: false }))).toBe(false);
  });
});
