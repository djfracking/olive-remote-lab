import {
  parseTimeSeconds,
  type MaestroTrackMetadata,
  type MaestroTreeNode,
  type NowPlayingSnapshot,
  type UpnpDidlObject,
  type UpnpMediaInfo,
  type UpnpPositionInfo,
  type UpnpTransportInfo,
} from "@olive-remote-lab/olive-client";

export interface PlaybackTrack {
  itemId: string;
  metadata: MaestroTrackMetadata;
  playbackIndex?: number;
}

export interface PlaybackProgress {
  positionSeconds: number;
  durationSeconds: number;
  percent: number;
}

export interface UpnpPlayerStateResponse {
  readonly available: boolean;
  readonly sampledAt: number;
  readonly position: UpnpPositionInfo | null;
  readonly transport: UpnpTransportInfo | null;
  readonly media: UpnpMediaInfo | null;
  readonly rendering: {
    readonly volume: number | null;
    readonly muted: boolean | null;
  } | null;
}

export interface PlaybackRenderingTelemetry {
  readonly volumePercent: number | null;
  readonly muted: boolean | null;
  readonly sampledAt: number;
}

function firstValue(values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value?.trim()))?.trim() ?? "";
}

function normalizedComparable(value: string | null | undefined): string {
  return value?.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase() ?? "";
}

function normalizeArtworkPath(value: string): string {
  if (!value || /artworknotfound\.gif(?:$|\?)/i.test(value)) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("/")) return value;
  return `/${value.replace(/^\.\//, "")}`;
}

function transportStateFromUpnp(
  value: string | null | undefined,
): NowPlayingSnapshot["transportState"] | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  if (normalized === "PLAYING") return "playing";
  if (normalized === "PAUSED" || normalized === "PAUSED_PLAYBACK" || normalized === "PAUSED_RECORDING") return "paused";
  if (normalized === "STOPPED" || normalized === "NO_MEDIA_PRESENT") return "stopped";
  return normalized ? "unknown" : null;
}

function upnpLocalItemId(item: UpnpDidlObject): string {
  const maestroId = item.identifiers.maestroId?.trim() ?? "";
  if (maestroId) return maestroId;
  const upnpId = item.identifiers.upnpRefId?.trim()
    || item.identifiers.upnpId?.trim()
    || item.refId?.trim()
    || item.id.trim();
  if (!upnpId) return "";
  return upnpId.startsWith("upnp:") ? upnpId : `upnp:${upnpId}`;
}

function upnpMetadata(item: UpnpDidlObject, itemId: string): MaestroTrackMetadata {
  return {
    id: itemId,
    title: item.title || "Untitled",
    album: item.album ?? "",
    artist: item.artist ?? item.artists[0] ?? item.creator ?? "",
    genre: item.genre ?? item.genres[0] ?? "",
    artworkPath: normalizeArtworkPath(item.albumArtUri ?? ""),
    durationSeconds: item.durationSeconds,
    playCount: null,
    rating: null,
    raw: {
      source: "upnp",
      upnpId: item.identifiers.upnpId,
      upnpRefId: item.identifiers.upnpRefId,
      upnpParentId: item.identifiers.upnpParentId,
      maestroId: item.identifiers.maestroId,
      className: item.className,
      resourceUri: item.resourceUri,
    },
  };
}

function metadataDescribesSameTrack(
  current: MaestroTrackMetadata | null,
  incoming: UpnpDidlObject,
): boolean {
  if (!current?.title || !incoming.title) return false;
  if (normalizedComparable(current.title) !== normalizedComparable(incoming.title)) return false;
  let corroborated = false;
  const currentArtist = normalizedComparable(current.artist);
  const incomingArtist = normalizedComparable(incoming.artist ?? incoming.artists[0] ?? incoming.creator);
  if (currentArtist && incomingArtist && currentArtist !== incomingArtist) return false;
  if (currentArtist && incomingArtist) corroborated = true;
  const currentAlbum = normalizedComparable(current.album);
  const incomingAlbum = normalizedComparable(incoming.album);
  if (currentAlbum && incomingAlbum && currentAlbum !== incomingAlbum) return false;
  if (currentAlbum && incomingAlbum) corroborated = true;
  return corroborated;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reconciles read-only AVTransport telemetry into the app-owned snapshot. A
 * UPnP-only ID is explicitly namespaced and is never mistaken for a Maestro ID.
 * When DIDL metadata clearly describes the current app-started track, its
 * Maestro identity is retained while its live transport clock is refreshed.
 */
export function reconcileUpnpPlaybackObservation(
  current: NowPlayingSnapshot | null,
  telemetry: UpnpPlayerStateResponse,
  now = Date.now(),
): NowPlayingSnapshot | null {
  if (!telemetry.available) return current;
  const sampledAt = Number.isFinite(telemetry.sampledAt) && telemetry.sampledAt > 0
    ? telemetry.sampledAt
    : now;
  const transportState = transportStateFromUpnp(telemetry.transport?.currentTransportState);
  if (transportState === "stopped") return stoppedSnapshot(sampledAt);

  const didl = telemetry.position?.trackMetadata[0]
    ?? telemetry.media?.currentUriMetadata[0]
    ?? null;
  const didlItemId = didl ? upnpLocalItemId(didl) : "";
  const explicitMaestroId = didl?.identifiers.maestroId?.trim() ?? "";
  const sameUpnpIdentity = Boolean(current?.itemId && didlItemId && current.itemId === didlItemId);
  const sameDescribedTrack = Boolean(didl && metadataDescribesSameTrack(current?.metadata ?? null, didl));
  const retainCurrentIdentity = Boolean(
    current?.itemId
    && !explicitMaestroId
    && (sameUpnpIdentity || sameDescribedTrack),
  );
  const itemId = explicitMaestroId
    || (retainCurrentIdentity ? current?.itemId ?? "" : didlItemId)
    || current?.itemId
    || "";

  const didlMetadata = didl && itemId ? upnpMetadata(didl, itemId) : null;
  const metadata = itemId
    ? mergeTrackMetadata(itemId, retainCurrentIdentity ? current?.metadata : null, didlMetadata)
    : null;
  const telemetryPosition = finiteOrNull(telemetry.position?.relativeTimeSeconds);
  const projectedCurrent = projectPosition(current, sampledAt);
  const telemetryIsAtLeastAsFresh = !current || sampledAt >= current.sampledAt;
  const positionSeconds = telemetryPosition !== null && telemetryIsAtLeastAsFresh
    ? telemetryPosition
    : (itemId === current?.itemId ? projectedCurrent?.positionSeconds ?? null : null);
  const durationSeconds = finiteOrNull(telemetry.position?.trackDurationSeconds)
    ?? finiteOrNull(didl?.durationSeconds)
    ?? finiteOrNull(telemetry.media?.mediaDurationSeconds)
    ?? (itemId === current?.itemId ? current?.durationSeconds ?? current?.metadata?.durationSeconds ?? null : null);
  const resolvedTransportState = !telemetryIsAtLeastAsFresh || transportState === null || transportState === "unknown"
    ? current?.transportState ?? "unknown"
    : transportState;
  const observationSampledAt = !telemetryIsAtLeastAsFresh && itemId === current?.itemId
    ? current?.sampledAt ?? sampledAt
    : sampledAt;

  const hasPlaybackObservation = Boolean(
    telemetry.position
    || telemetry.transport
    || telemetry.media
    || didl
  );
  if (!hasPlaybackObservation) return current;
  return {
    itemId,
    metadata: metadata?.title ? metadata : null,
    identitySource: itemId ? "device" : "none",
    transportState: resolvedTransportState,
    positionSeconds,
    durationSeconds,
    sampledAt: observationSampledAt,
  };
}

export function renderingTelemetryFromPlayerState(
  telemetry: UpnpPlayerStateResponse,
): PlaybackRenderingTelemetry | null {
  if (!telemetry.available || !telemetry.rendering) return null;
  const volume = finiteOrNull(telemetry.rendering.volume);
  const volumePercent = volume !== null && volume >= 0 && volume <= 100 ? volume : null;
  const muted = typeof telemetry.rendering.muted === "boolean" ? telemetry.rendering.muted : null;
  if (volumePercent === null && muted === null) return null;
  return {
    volumePercent,
    muted,
    sampledAt: Number.isFinite(telemetry.sampledAt) && telemetry.sampledAt > 0
      ? telemetry.sampledAt
      : Date.now(),
  };
}

export function hasLivePositionTelemetry(telemetry: UpnpPlayerStateResponse): boolean {
  if (!telemetry.available || !telemetry.position) return false;
  return finiteOrNull(telemetry.position.relativeTimeSeconds) !== null
    && (
      finiteOrNull(telemetry.position.trackDurationSeconds) !== null
      || finiteOrNull(telemetry.position.trackMetadata[0]?.durationSeconds) !== null
      || finiteOrNull(telemetry.media?.mediaDurationSeconds) !== null
    );
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
    identitySource: "command-fallback",
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
    identitySource: "none",
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
  const identitySource = incoming.itemId ? incoming.identitySource ?? "device" : "none";
  const metadata = incoming.itemId
    ? mergeTrackMetadata(incoming.itemId, cachedForItem, incoming.metadata)
    : null;
  return {
    itemId: incoming.itemId,
    metadata: metadata?.title ? metadata : null,
    identitySource,
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

export function playbackProgress(
  positionSeconds: number | null,
  durationSeconds: number | null,
): PlaybackProgress | null {
  if (
    positionSeconds === null
    || durationSeconds === null
    || !Number.isFinite(positionSeconds)
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
  ) {
    return null;
  }
  const boundedPosition = Math.min(durationSeconds, Math.max(0, positionSeconds));
  return {
    positionSeconds: boundedPosition,
    durationSeconds,
    percent: boundedPosition / durationSeconds * 100,
  };
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
    identitySource: current.identitySource === "device" || incoming.identitySource === "device"
      ? "device"
      : incoming.identitySource,
    transportState: incoming.transportState === "unknown" ? current.transportState : incoming.transportState,
    positionSeconds: incoming.positionSeconds ?? projected.positionSeconds,
    durationSeconds: incoming.durationSeconds ?? metadata.durationSeconds ?? current.durationSeconds,
    sampledAt: anchorTime,
  };
}

export function observationIndicatesNaturalRollover(
  current: NowPlayingSnapshot,
  incoming: NowPlayingSnapshot,
  sampledAt = incoming.sampledAt,
): boolean {
  if (current.transportState === "stopped" || incoming.transportState === "stopped" || incoming.transportState === "paused") {
    return false;
  }
  const durationSeconds = current.durationSeconds ?? current.metadata?.durationSeconds ?? null;
  const projected = projectPosition(current, sampledAt) ?? current;
  if (durationSeconds === null || projected.positionSeconds === null) return false;
  const nearEnd = projected.positionSeconds >= Math.max(0, durationSeconds - 2);
  if (!nearEnd) return false;
  if (incoming.positionSeconds === null) return true;
  const resetCeiling = Math.min(12, Math.max(3, durationSeconds * 0.1));
  return incoming.positionSeconds <= resetCeiling
    && incoming.positionSeconds + 5 < projected.positionSeconds;
}

export function inferredNaturalNext(
  context: PlaybackTrack[],
  current: NowPlayingSnapshot,
  incoming: NowPlayingSnapshot,
): PlaybackTrack | null {
  if (!observationIndicatesNaturalRollover(current, incoming)) return null;
  return adjacentTrack(context, current.itemId, "next");
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

export function isPlaybackContextBoundary(
  context: PlaybackTrack[],
  itemId: string,
  direction: "previous" | "next",
): boolean {
  const index = context.findIndex((track) => track.itemId === itemId);
  if (index < 0) return false;
  return direction === "next" ? index === context.length - 1 : index === 0;
}
