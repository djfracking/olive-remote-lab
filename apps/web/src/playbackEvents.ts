import type { MaestroTrackMetadata, MaestroTreeNode } from "@olive-remote-lab/olive-client";

export const TRACK_STARTING_EVENT = "olive-track-starting";
export const TRACK_CHANGING_EVENT = "olive-track-changing";

export interface TrackStartingDetail {
  itemId: string;
  metadata: MaestroTrackMetadata;
}

export interface TrackChangingDetail { previousItemId: string }

export function announceTrackStarting(track: MaestroTreeNode): void {
  const detail: TrackStartingDetail = {
    itemId: track.id,
    metadata: {
      id: track.id,
      title: track.title || "Untitled",
      album: track.userData.album ?? "",
      artist: track.userData.artist ?? track.userData.interpreter ?? "",
      genre: track.userData.genre ?? "",
      artworkPath: track.userData.artworkPath ?? track.userData.cover ?? "",
      durationSeconds: null,
      playCount: null,
      rating: null,
      raw: {},
    },
  };
  window.dispatchEvent(new CustomEvent<TrackStartingDetail>(TRACK_STARTING_EVENT, { detail }));
}

export function announceTrackChanging(previousItemId: string): void {
  window.dispatchEvent(new CustomEvent<TrackChangingDetail>(TRACK_CHANGING_EVENT, {
    detail: { previousItemId },
  }));
}
