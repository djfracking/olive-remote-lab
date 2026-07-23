import { describe, expect, it } from "vitest";
import type { MaestroTrackMetadata, MaestroTreeNode, NowPlayingSnapshot } from "@olive-remote-lab/olive-client";
import {
  adjacentTrack,
  mergeMatchingObservation,
  normalizeObservation,
  playbackTrackFromNode,
  projectPosition,
  snapshotForTrack,
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
      transportState: "stopped",
      positionSeconds: null,
      durationSeconds: null,
    }, metadata("track-old", "Old song", "/old.jpg"), 1_000);
    expect(observed).toEqual({
      itemId: "",
      metadata: null,
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

  it("selects previous and next from the app-owned order", () => {
    const context = [node("one", "One"), node("two", "Two"), node("three", "Three")].map((item) => playbackTrackFromNode(item));
    expect(adjacentTrack(context, "two", "previous")?.itemId).toBe("one");
    expect(adjacentTrack(context, "two", "next")?.itemId).toBe("three");
    expect(adjacentTrack(context, "three", "next")).toBeNull();
  });
});
