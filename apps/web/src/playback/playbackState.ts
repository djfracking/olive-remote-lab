import {
  parseTimeSeconds,
  type MaestroTrackMetadata,
  type MaestroTreeNode,
  type NowPlayingSnapshot,
} from "@olive-remote-lab/olive-client";

export interface PlaybackTrack {
  itemId: string;
  metadata: MaestroTrackMetadata;
  playbackIndex?: number;
}

function firstValue(values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() ?? "";
}

function normalizeArtworkPath(value: string): string {
  if (!value || /artworknotfound\.gif(?:$|\?)/i.test(value)) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("/")) return value;
  return `/${value.replace(/^\.\//, "")}`;
}

export function mergeTrackMetadata(
  itemId: string,
  ...candidates: Array<MaestroTrackMetadata | null | undefined>
): MaestroTrackMetadata {
  const result: MaestroTrackMetadata = {
    id: itemId,
    title: "",
    album: "",
    artist: "",
    genre: "",
    artworkPath: "",
    durationSeconds: null,
    playCount: null,
    rating: null,
    raw: {},
  };
  for (const candidate of candidates) {
    if (!candidate || (candidate.id && candidate.id !== itemId)) continue;
    result.title = candidate.title || result.title;
    result.album = candidate.album || result.album;
    result.artist = candidate.artist || result.artist;
    result.genre = candidate.genre || result.genre;
    result.artworkPath = normalizeArtworkPath(candidate.artworkPath || result.artworkPath);
    result.durationSeconds = candidate.durationSeconds ?? result.durationSeconds;
    result.playCount = candidate.playCount ?? result.playCount;
    result.rating = candidate.rating ?? result.rating;
    result.raw = { ...result.raw, ...candidate.raw };
  }
  return result;
}

export function metadataFromNode(node: MaestroTreeNode): MaestroTrackMetadata {
  const data = node.userData;
  return {
    id: node.id,
    title: node.title || "Untitled",
    album: firstValue([data.album, data.albumname]),
    artist: firstValue([data.artist, data.interpreter, data.performer]),
    genre: firstValue([data.genre, data.major_genre]),
    artworkPath: normalizeArtworkPath(firstValue([
      data.albumart,
      data.albumArt,
      data.artwork,
      data.artworkPath,
      data.cover,
    ])),
    durationSeconds: parseTimeSeconds(firstValue([data.duration, data.trackDuration, data.TrackDuration])),
    playCount: null,
    rating: null,
    raw: { ...data },
  };
}

export function playbackTrackFromNode(node: MaestroTreeNode, cached?: MaestroTrackMetadata | null): PlaybackTrack {
  const playbackIndex = node.userData.playbackIndex ? Number(node.userData.playbackIndex) : undefined;
  return {
    itemId: node.id,
    metadata: mergeTrackMetadata(node.id, cached, metadataFromNode(node)),
    ...(playbackIndex !== undefined && Number.isInteger(playbackIndex) && playbackIndex >= 0 ? { playbackIndex } : {}),
  };
}

export function snapshotForTrack(track: PlaybackTrack, sampledAt = Date.now()): NowPlayingSnapshot {
  return {
    itemId: track.itemId,
    metadata: track.metadata,
    transportState: "playing",
    positionSeconds: 0,
    durationSeconds: track.metadata.durationSeconds,
    sampledAt,
  };
}

export function stoppedSnapshot(sampledAt = Date.now()): NowPlayingSnapshot {
  return {
    itemId: "",
    metadata: null,
    transportState: "stopped",
    positionSeconds: null,
    durationSeconds: null,
    sampledAt,
  };
}

/**
 * Turns an Olive observation into an atomic item + metadata snapshot. Metadata
 * is looked up only by the observed item ID, so an old song can never donate
 * its title or artwork to a newly observed item.
 */
export function normalizeObservation(
  incoming: Partial<NowPlayingSnapshot> & Pick<NowPlayingSnapshot, "itemId" | "metadata">,
  cachedForItem: MaestroTrackMetadata | null,
  sampledAt = Date.now(),
): NowPlayingSnapshot {
  const transportState = incoming.transportState ?? (incoming.itemId ? "unknown" : "stopped");
  if (transportState === "stopped") return stoppedSnapshot(incoming.sampledAt ?? sampledAt);
  const metadata = incoming.itemId
    ? mergeTrackMetadata(incoming.itemId, cachedForItem, incoming.metadata)
    : null;
  return {
    itemId: incoming.itemId,
    metadata: metadata?.title ? metadata : null,
    transportState,
    positionSeconds: incoming.positionSeconds ?? null,
    durationSeconds: incoming.durationSeconds ?? metadata?.durationSeconds ?? null,
    sampledAt: incoming.sampledAt ?? sampledAt,
  };
}

export function projectPosition(snapshot: NowPlayingSnapshot | null, now = Date.now()): NowPlayingSnapshot | null {
  if (!snapshot || snapshot.positionSeconds === null || snapshot.transportState !== "playing") return snapshot;
  const elapsed = Math.max(0, (now - snapshot.sampledAt) / 1_000);
  const positionSeconds = snapshot.durationSeconds === null
    ? snapshot.positionSeconds + elapsed
    : Math.min(snapshot.durationSeconds, snapshot.positionSeconds + elapsed);
  return { ...snapshot, positionSeconds };
}

export function mergeMatchingObservation(
  current: NowPlayingSnapshot,
  incoming: NowPlayingSnapshot,
  sampledAt = Date.now(),
): NowPlayingSnapshot {
  if (!current.itemId || incoming.itemId !== current.itemId) return current;
  const projected = projectPosition(current, sampledAt) ?? current;
  const metadata = mergeTrackMetadata(current.itemId, current.metadata, incoming.metadata);
  const anchorTime = incoming.positionSeconds === null ? sampledAt : incoming.sampledAt;
  return {
    itemId: current.itemId,
    metadata,
    transportState: incoming.transportState === "unknown" ? current.transportState : incoming.transportState,
    positionSeconds: incoming.positionSeconds ?? projected.positionSeconds,
    durationSeconds: incoming.durationSeconds ?? metadata.durationSeconds ?? current.durationSeconds,
    sampledAt: anchorTime,
  };
}

export function adjacentTrack(
  context: PlaybackTrack[],
  itemId: string,
  direction: "previous" | "next",
): PlaybackTrack | null {
  const index = context.findIndex((track) => track.itemId === itemId);
  if (index < 0) return null;
  return context[index + (direction === "next" ? 1 : -1)] ?? null;
}
