import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  MaestroTrackMetadata,
  MaestroTreeNode,
  NowPlayingSnapshot,
  OliveDeviceTarget,
  PlaybackCommand,
} from "@olive-remote-lab/olive-client";
import { appFetch, isNativeApp } from "../nativeApi";
import { isDemoTarget } from "../demoOlive";
import {
  clearSystemPlayback,
  readSystemPlayback,
  subscribeSystemPlaybackCommands,
  updateSystemPlayback,
} from "../systemPlayback";
import {
  queueFromNode,
  readQueue,
  queuedTrackNode,
  writeQueue,
  type QueuedTrack,
} from "../playbackQueue";
import { deviceCacheNamespace, deviceRequestKey, type StableOliveTarget } from "../deviceIdentity";
import { PLAYBACK_METADATA_STORAGE_KEY } from "../deviceStorageMigration";
import { resolveMaestroPlaybackNode } from "../playbackIdentity";
import { isUpnpTreeNode, maestroPlaybackId } from "../upnpCatalog";
import {
  adjacentTrack,
  inferredNaturalNext,
  isPlaybackContextBoundary,
  mergeMatchingObservation,
  mergeTrackMetadata,
  normalizeObservation,
  observationIndicatesNaturalRollover,
  hasLivePositionTelemetry,
  playbackTrackFromNode,
  projectPosition,
  reconcileUpnpPlaybackObservation,
  renderingTelemetryFromPlayerState,
  snapshotForTrack,
  stoppedSnapshot,
  type PlaybackRenderingTelemetry,
  type PlaybackTrack,
  type UpnpPlayerStateResponse,
} from "./playbackState";

const METADATA_TTL_MS = 24 * 60 * 60 * 1_000;
const OBSERVATION_HOLD_MS = 6_000;
const UPNP_TELEMETRY_TTL_MS = 5_000;
const IDENTITYLESS_DEFAULT_HOLD_MS = 30_000;
const IDENTITYLESS_END_GRACE_MS = 15_000;
const IDENTITYLESS_MAX_HOLD_MS = 4 * 60 * 60 * 1_000;

interface CachedMetadata {
  metadata: MaestroTrackMetadata;
  cachedAt: number;
}

interface ConfirmedState {
  snapshot: NowPlayingSnapshot | null;
  ownsIdentity: boolean;
  ownedItemId: string;
  context: PlaybackTrack[];
}

type RolloverAction =
  | { kind: "play"; track: PlaybackTrack; context: PlaybackTrack[] }
  | { kind: "stop"; context: PlaybackTrack[] };

interface PlaybackStateValue {
  connected: boolean;
  target: OliveDeviceTarget;
  nowPlaying: NowPlayingSnapshot | null;
  commandPending: boolean;
  volumeControlEnabled: boolean;
  seekControlEnabled: boolean;
  livePositionTelemetry: boolean;
  renderingTelemetry: PlaybackRenderingTelemetry | null;
  queue: QueuedTrack[];
}

interface PlaybackActionsValue {
  playTrack: (node: MaestroTreeNode, context?: MaestroTreeNode[]) => Promise<void>;
  playQueuedTrack: (track: QueuedTrack) => Promise<void>;
  control: (action: "pause" | "stop" | "previous" | "next") => Promise<void>;
  seek: (positionSeconds: number) => Promise<void>;
  setVolume: (level: number) => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  enqueue: (node: MaestroTreeNode) => void;
  moveQueueItem: (index: number, offset: number) => void;
  removeQueueItem: (queueId: string) => void;
  clearQueue: () => void;
}

const PlaybackStateContext = createContext<PlaybackStateValue | null>(null);
const PlaybackActionsContext = createContext<PlaybackActionsValue | null>(null);

function targetKey(target: OliveDeviceTarget): string {
  return deviceCacheNamespace(target as StableOliveTarget);
}

function cacheKey(target: OliveDeviceTarget, itemId: string): string {
  return `${targetKey(target)}:${itemId}`;
}

function identitylessHoldMs(current: NowPlayingSnapshot, sampledAt: number): number {
  const projected = projectPosition(current, sampledAt) ?? current;
  const durationSeconds = current.durationSeconds ?? current.metadata?.durationSeconds ?? null;
  if (durationSeconds === null || projected.positionSeconds === null) return IDENTITYLESS_DEFAULT_HOLD_MS;
  const remainingMs = Math.max(0, durationSeconds - projected.positionSeconds) * 1_000;
  return Math.min(IDENTITYLESS_MAX_HOLD_MS, Math.max(
    IDENTITYLESS_END_GRACE_MS,
    remainingMs + IDENTITYLESS_END_GRACE_MS,
  ));
}

function readMetadataCache(): Record<string, CachedMetadata> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYBACK_METADATA_STORAGE_KEY) ?? "{}") as Record<string, CachedMetadata>;
    const cutoff = Date.now() - METADATA_TTL_MS;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value?.cachedAt >= cutoff && Boolean(value.metadata?.title)));
  } catch { return {}; }
}

function queuedTrackAsPlaybackTrack(track: QueuedTrack, cached?: MaestroTrackMetadata | null): PlaybackTrack {
  return {
    itemId: track.itemId,
    metadata: mergeTrackMetadata(track.itemId, cached, {
      id: track.itemId,
      title: track.title,
      artist: track.artist,
      album: track.album,
      genre: "",
      artworkPath: track.artworkPath,
      durationSeconds: null,
      playCount: null,
      rating: null,
      raw: {},
    }),
    ...(track.playbackIndex !== undefined ? { playbackIndex: track.playbackIndex } : {}),
  };
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return new Error(body.error);
  } catch { /* Use the stable fallback below. */ }
  return new Error(fallback);
}

export function PlaybackProvider({
  connected,
  target,
  volumeControlEnabled,
  seekControlEnabled,
  onStatus,
  children,
}: {
  connected: boolean;
  target: OliveDeviceTarget;
  volumeControlEnabled: boolean;
  seekControlEnabled: boolean;
  onStatus: (status: string) => void;
  children: ReactNode;
}) {
  const [snapshot, setSnapshotState] = useState<NowPlayingSnapshot | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [pendingCommands, setPendingCommands] = useState(0);
  const [livePositionTelemetry, setLivePositionTelemetry] = useState(false);
  const [renderingTelemetry, setRenderingTelemetry] = useState<PlaybackRenderingTelemetry | null>(null);
  const [rolloverActionRevision, setRolloverActionRevision] = useState(0);
  const [queue, setQueueState] = useState<QueuedTrack[]>(() => readQueue(target));
  const snapshotRef = useRef<NowPlayingSnapshot | null>(null);
  const queueRef = useRef(queue);
  const contextRef = useRef<PlaybackTrack[]>([]);
  const ownsIdentityRef = useRef(false);
  const ownedItemIdRef = useRef("");
  const confirmedRef = useRef<ConfirmedState>({ snapshot: null, ownsIdentity: false, ownedItemId: "", context: [] });
  const revisionRef = useRef(0);
  const pendingCommandsRef = useRef(0);
  const generationRef = useRef(0);
  const pollActiveRef = useRef(false);
  const upnpPollActiveRef = useRef(false);
  const upnpPollSequenceRef = useRef(0);
  const commandTailRef = useRef<Promise<void>>(Promise.resolve());
  const holdConflictsUntilRef = useRef(0);
  const identityMissingUntilRef = useRef(0);
  const conflictRef = useRef<{ itemId: string; count: number } | null>(null);
  const metadataCacheRef = useRef<Record<string, CachedMetadata>>(readMetadataCache());
  const latestUpnpTelemetryRef = useRef<UpnpPlayerStateResponse | null>(null);
  const reconcileTimersRef = useRef<number[]>([]);
  const rolloverActionRef = useRef<RolloverAction | null>(null);
  const activeTargetKey = targetKey(target);
  const activeEndpointKey = deviceRequestKey(target as StableOliveTarget);
  const activeEndpointKeyRef = useRef(activeEndpointKey);
  activeEndpointKeyRef.current = activeEndpointKey;

  const playbackTargetIsCurrent = useCallback((
    generation: number,
    endpointKey: string,
  ) => generation === generationRef.current && endpointKey === activeEndpointKeyRef.current, []);

  const setSnapshot = useCallback((next: NowPlayingSnapshot | null) => {
    snapshotRef.current = next;
    setSnapshotState(next);
  }, []);

  const setQueue = useCallback((next: QueuedTrack[]) => {
    queueRef.current = next;
    setQueueState(next);
    writeQueue(target, next);
  }, [target]);

  const cachedMetadata = useCallback((itemId: string): MaestroTrackMetadata | null => {
    if (!itemId) return null;
    const entry = metadataCacheRef.current[cacheKey(target, itemId)];
    if (!entry || Date.now() - entry.cachedAt > METADATA_TTL_MS) return null;
    return entry.metadata;
  }, [target]);

  const rememberMetadata = useCallback((itemId: string, metadata: MaestroTrackMetadata | null) => {
    if (!itemId || !metadata?.title) return;
    metadataCacheRef.current[cacheKey(target, itemId)] = {
      metadata: mergeTrackMetadata(itemId, metadata),
      cachedAt: Date.now(),
    };
    try { localStorage.setItem(PLAYBACK_METADATA_STORAGE_KEY, JSON.stringify(metadataCacheRef.current)); }
    catch { /* Metadata caching is best effort. */ }
  }, [target]);

  const hydrateTrack = useCallback(async (track: PlaybackTrack): Promise<PlaybackTrack> => {
    try {
      const response = await appFetch("/api/library/item-metadata", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, itemId: track.itemId }),
      });
      if (!response.ok) return track;
      const metadata = await response.json() as MaestroTrackMetadata | null;
      if (!metadata) return track;
      const merged = mergeTrackMetadata(track.itemId, track.metadata, metadata);
      rememberMetadata(track.itemId, merged);
      return { ...track, metadata: merged };
    } catch { return track; }
  }, [target, rememberMetadata]);

  const scheduleRefresh = useCallback((refresh: () => Promise<void>) => {
    for (const delay of [150, 1_200, 3_000, 6_500]) {
      reconcileTimersRef.current.push(window.setTimeout(() => void refresh(), delay));
    }
  }, []);

  const applyObserved = useCallback((observed: NowPlayingSnapshot) => {
    if (observed.metadata) rememberMetadata(observed.itemId, observed.metadata);
    const current = snapshotRef.current;
    if (!ownsIdentityRef.current) {
      setSnapshot(observed);
      confirmedRef.current = { snapshot: observed, ownsIdentity: false, ownedItemId: "", context: contextRef.current };
      identityMissingUntilRef.current = 0;
      conflictRef.current = null;
      return;
    }

    const ownedItemId = ownedItemIdRef.current;
    const commandProtected = Date.now() < holdConflictsUntilRef.current || pendingCommandsRef.current > 0;
    if (
      current
      && !commandProtected
      && contextRef.current.some((track) => track.itemId === current.itemId)
      && observationIndicatesNaturalRollover(current, observed)
    ) {
      const nextTrack = inferredNaturalNext(contextRef.current, current, observed);
      if (nextTrack) {
        const observedDurationLooksNew = observed.durationSeconds !== null
          && observed.durationSeconds !== current.durationSeconds;
        const adopted: NowPlayingSnapshot = {
          ...snapshotForTrack(nextTrack, observed.sampledAt),
          transportState: observed.transportState === "unknown" ? "playing" : observed.transportState,
          positionSeconds: observed.positionSeconds ?? 0,
          durationSeconds: nextTrack.metadata.durationSeconds
            ?? (observedDurationLooksNew ? observed.durationSeconds : null),
        };
        setSnapshot(adopted);
        ownsIdentityRef.current = true;
        ownedItemIdRef.current = nextTrack.itemId;
        identityMissingUntilRef.current = 0;
        conflictRef.current = null;
        rememberMetadata(nextTrack.itemId, nextTrack.metadata);
        if (
          observed.identitySource === "device"
          && observed.itemId
          && observed.itemId !== nextTrack.itemId
        ) {
          rolloverActionRef.current = {
            kind: "play",
            track: nextTrack,
            context: [...contextRef.current],
          };
          setRolloverActionRevision((value) => value + 1);
        } else {
          confirmedRef.current = {
            snapshot: adopted,
            ownsIdentity: true,
            ownedItemId: nextTrack.itemId,
            context: contextRef.current,
          };
        }
        return;
      }
      const stopped = stoppedSnapshot(observed.sampledAt);
      setSnapshot(stopped);
      ownsIdentityRef.current = true;
      ownedItemIdRef.current = "";
      identityMissingUntilRef.current = 0;
      conflictRef.current = null;
      rolloverActionRef.current = { kind: "stop", context: [...contextRef.current] };
      setRolloverActionRevision((value) => value + 1);
      return;
    }
    if (observed.itemId === ownedItemId && current) {
      const merged = mergeMatchingObservation(current, observed);
      setSnapshot(merged);
      confirmedRef.current = { snapshot: merged, ownsIdentity: true, ownedItemId, context: contextRef.current };
      identityMissingUntilRef.current = 0;
      conflictRef.current = null;
      return;
    }
    if (ownedItemId && observed.identitySource !== "device" && observed.transportState !== "stopped" && current) {
      const merged = mergeMatchingObservation(current, {
        ...observed,
        itemId: current.itemId,
        metadata: null,
        identitySource: current.identitySource,
      });
      setSnapshot(merged);
      if (observed.identitySource === "command-fallback") {
        identityMissingUntilRef.current = 0;
        return;
      }
      if (commandProtected) return;
      if (!identityMissingUntilRef.current) {
        identityMissingUntilRef.current = observed.sampledAt + identitylessHoldMs(current, observed.sampledAt);
      }
      if (observed.sampledAt < identityMissingUntilRef.current) return;
      setSnapshot(observed);
      ownsIdentityRef.current = false;
      ownedItemIdRef.current = "";
      confirmedRef.current = { snapshot: observed, ownsIdentity: false, ownedItemId: "", context: contextRef.current };
      identityMissingUntilRef.current = 0;
      conflictRef.current = null;
      return;
    }
    if (!ownedItemId && observed.transportState === "stopped") {
      setSnapshot(observed);
      confirmedRef.current = { snapshot: observed, ownsIdentity: true, ownedItemId: "", context: contextRef.current };
      identityMissingUntilRef.current = 0;
      conflictRef.current = null;
      return;
    }
    if (commandProtected) return;

    const conflictItemId = observed.transportState === "stopped" ? "[stopped]" : observed.itemId;
    const previousConflict = conflictRef.current;
    conflictRef.current = previousConflict?.itemId === conflictItemId
      ? { itemId: conflictItemId, count: previousConflict.count + 1 }
      : { itemId: conflictItemId, count: 1 };
    const knownTrack = contextRef.current.find((track) => track.itemId === observed.itemId);
    const expectedNext = current ? adjacentTrack(contextRef.current, current.itemId, "next") : null;
    const projectedCurrent = projectPosition(current);
    const isExpectedNaturalAdvance = Boolean(
      knownTrack
      && expectedNext?.itemId === knownTrack.itemId
      && projectedCurrent?.durationSeconds !== null
      && projectedCurrent?.durationSeconds !== undefined
      && projectedCurrent.positionSeconds !== null
      && projectedCurrent.positionSeconds >= projectedCurrent.durationSeconds - 2,
    );
    const requiredObservations = observed.identitySource === "device" || isExpectedNaturalAdvance ? 1 : 2;
    if (conflictRef.current.count < requiredObservations) return;

    const adopted = knownTrack && observed.transportState !== "stopped"
      ? mergeMatchingObservation(snapshotForTrack(knownTrack), {
        ...observed,
        metadata: mergeTrackMetadata(knownTrack.itemId, knownTrack.metadata, observed.metadata),
      })
      : observed;
    setSnapshot(adopted);
    ownsIdentityRef.current = Boolean(knownTrack);
    ownedItemIdRef.current = knownTrack?.itemId ?? "";
    confirmedRef.current = {
      snapshot: adopted,
      ownsIdentity: ownsIdentityRef.current,
      ownedItemId: ownedItemIdRef.current,
      context: contextRef.current,
    };
    identityMissingUntilRef.current = 0;
    conflictRef.current = null;
  }, [rememberMetadata, setSnapshot]);

  const refreshNowPlaying = useCallback(async () => {
    if (!connected || !target.host || document.visibilityState !== "visible" || pollActiveRef.current) return;
    const generation = generationRef.current;
    const revision = revisionRef.current;
    pollActiveRef.current = true;
    try {
      const response = await appFetch("/api/now-playing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!response.ok) return;
      const incoming = await response.json() as Partial<NowPlayingSnapshot> & Pick<NowPlayingSnapshot, "itemId" | "metadata">;
      if (generation !== generationRef.current || revision < revisionRef.current) return;
      const legacyObservation = normalizeObservation(incoming, cachedMetadata(incoming.itemId));
      const upnp = latestUpnpTelemetryRef.current;
      const observed = upnp && Date.now() - upnp.sampledAt <= UPNP_TELEMETRY_TTL_MS
        ? reconcileUpnpPlaybackObservation(legacyObservation, upnp) ?? legacyObservation
        : legacyObservation;
      applyObserved(observed);
    } catch { /* Connection status and later polls handle temporary failures. */ }
    finally {
      if (generation === generationRef.current) pollActiveRef.current = false;
    }
  }, [applyObserved, cachedMetadata, connected, target]);

  const refreshUpnpPlayerState = useCallback(async (
    options: { includeRendering?: boolean; includeMedia?: boolean } = {},
  ) => {
    if (
      !connected
      || !target.host
      || isDemoTarget(target)
      || document.visibilityState !== "visible"
      || upnpPollActiveRef.current
    ) return;
    const generation = generationRef.current;
    const revision = revisionRef.current;
    upnpPollActiveRef.current = true;
    try {
      const response = await appFetch("/api/upnp/player-state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, ...options }),
      });
      if (!response.ok) return;
      const telemetry = await response.json() as UpnpPlayerStateResponse;
      if (generation !== generationRef.current || revision < revisionRef.current) return;
      latestUpnpTelemetryRef.current = telemetry.available ? telemetry : null;
      setLivePositionTelemetry(hasLivePositionTelemetry(telemetry));
      if (options.includeRendering !== false) {
        setRenderingTelemetry(renderingTelemetryFromPlayerState(telemetry));
      }
      const observed = reconcileUpnpPlaybackObservation(snapshotRef.current, telemetry);
      if (observed) applyObserved(observed);
    } catch {
      if (generation !== generationRef.current || revision < revisionRef.current) return;
      const previous = latestUpnpTelemetryRef.current;
      if (previous && Date.now() - previous.sampledAt > UPNP_TELEMETRY_TTL_MS) {
        latestUpnpTelemetryRef.current = null;
        setLivePositionTelemetry(false);
        setRenderingTelemetry(null);
      }
    } finally {
      if (generation === generationRef.current) upnpPollActiveRef.current = false;
    }
  }, [applyObserved, connected, target]);

  const refreshSystemPlayback = useCallback(async () => {
    if (!connected || !target.host || document.visibilityState !== "visible") return;
    const incoming = await readSystemPlayback(target);
    if (!incoming) return;
    const current = snapshotRef.current;
    if (current && incoming.sampledAt + 1_000 < current.sampledAt && incoming.itemId !== current.itemId) return;
    applyObserved(incoming);
  }, [applyObserved, connected, target]);

  const sendCommand = useCallback((command: PlaybackCommand): Promise<void> => {
    const generation = generationRef.current;
    const endpointKey = activeEndpointKey;
    const run = async () => {
      if (!playbackTargetIsCurrent(generation, endpointKey)) throw new Error("Playback target changed.");
      const response = await appFetch("/api/playback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, command }),
      });
      if (!response.ok) throw await responseError(response, "Playback command failed.");
      if (!playbackTargetIsCurrent(generation, endpointKey)) throw new Error("Playback target changed.");
    };
    const result = commandTailRef.current.then(run, run);
    commandTailRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [activeEndpointKey, playbackTargetIsCurrent, target]);

  const applyOptimisticCommand = useCallback(async (
    command: PlaybackCommand,
    desired: ConfirmedState,
    successStatus: string,
  ) => {
    const commandGeneration = generationRef.current;
    const commandEndpointKey = activeEndpointKey;
    if (!playbackTargetIsCurrent(commandGeneration, commandEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    const revision = ++revisionRef.current;
    pendingCommandsRef.current += 1;
    setPendingCommands(pendingCommandsRef.current);
    setSnapshot(desired.snapshot);
    ownsIdentityRef.current = desired.ownsIdentity;
    ownedItemIdRef.current = desired.ownedItemId;
    contextRef.current = desired.context;
    conflictRef.current = null;
    try {
      await sendCommand(command);
      if (!playbackTargetIsCurrent(commandGeneration, commandEndpointKey)) {
        throw new Error("Playback target changed.");
      }
      confirmedRef.current = desired;
      if (revision === revisionRef.current) {
        holdConflictsUntilRef.current = Date.now() + OBSERVATION_HOLD_MS;
        onStatus(successStatus);
        scheduleRefresh(refreshNowPlaying);
        scheduleRefresh(refreshUpnpPlayerState);
      }
    } catch (reason) {
      if (revision === revisionRef.current) {
        const confirmed = confirmedRef.current;
        setSnapshot(confirmed.snapshot);
        ownsIdentityRef.current = confirmed.ownsIdentity;
        ownedItemIdRef.current = confirmed.ownedItemId;
        contextRef.current = confirmed.context;
      }
      if (commandGeneration === generationRef.current) {
        onStatus(reason instanceof Error ? reason.message : "Playback command failed.");
      }
      throw reason;
    } finally {
      if (commandGeneration === generationRef.current) {
        pendingCommandsRef.current = Math.max(0, pendingCommandsRef.current - 1);
        setPendingCommands(pendingCommandsRef.current);
      }
    }
  }, [
    activeEndpointKey,
    onStatus,
    playbackTargetIsCurrent,
    refreshNowPlaying,
    refreshUpnpPlayerState,
    scheduleRefresh,
    sendCommand,
    setSnapshot,
  ]);

  useEffect(() => {
    if (!rolloverActionRevision) return;
    const action = rolloverActionRef.current;
    rolloverActionRef.current = null;
    if (!action) return;
    if (action.kind === "stop") {
      void applyOptimisticCommand(
        { action: "stop" },
        {
          snapshot: stoppedSnapshot(),
          ownsIdentity: true,
          ownedItemId: "",
          context: action.context,
        },
        "End of selection — playback stopped",
      ).catch(() => undefined);
      return;
    }
    void applyOptimisticCommand(
      {
        action: "play",
        itemId: action.track.itemId,
        ...(action.track.playbackIndex !== undefined ? { index: action.track.playbackIndex } : {}),
      },
      {
        snapshot: snapshotForTrack(action.track),
        ownsIdentity: true,
        ownedItemId: action.track.itemId,
        context: action.context,
      },
      `Continuing with ${action.track.metadata.title || "the next track"}`,
    ).catch(() => undefined);
  }, [applyOptimisticCommand, rolloverActionRevision]);

  const setRenderingValue = useCallback(async (value: { volume: number } | { muted: boolean }) => {
    if (!volumeControlEnabled) throw new Error("Volume control is not available for this Olive model.");
    const commandGeneration = generationRef.current;
    const commandEndpointKey = activeEndpointKey;
    if (!playbackTargetIsCurrent(commandGeneration, commandEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    pendingCommandsRef.current += 1;
    setPendingCommands(pendingCommandsRef.current);
    try {
      const response = await appFetch("/api/upnp/volume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, ...value }),
      });
      if (!playbackTargetIsCurrent(commandGeneration, commandEndpointKey)) {
        throw new Error("Playback target changed.");
      }
      if (!response.ok) {
        const error = await responseError(response, "Volume command failed.");
        if (!playbackTargetIsCurrent(commandGeneration, commandEndpointKey)) {
          throw new Error("Playback target changed.");
        }
        throw error;
      }
      const confirmed = await response.json() as { sampledAt?: number; volume?: number; muted?: boolean };
      if (!playbackTargetIsCurrent(commandGeneration, commandEndpointKey)) {
        throw new Error("Playback target changed.");
      }
      if (
        !Number.isFinite(confirmed.volume)
        || confirmed.volume! < 0
        || confirmed.volume! > 100
        || typeof confirmed.muted !== "boolean"
      ) {
        throw new Error("The Olive did not confirm its volume state.");
      }
      setRenderingTelemetry({
        volumePercent: confirmed.volume!,
        muted: confirmed.muted,
        sampledAt: Number.isFinite(confirmed.sampledAt) ? confirmed.sampledAt! : Date.now(),
      });
      onStatus("Olive volume updated");
    } catch (reason) {
      if (playbackTargetIsCurrent(commandGeneration, commandEndpointKey)) {
        onStatus(reason instanceof Error ? reason.message : "Volume command failed.");
        void refreshUpnpPlayerState({ includeRendering: true, includeMedia: false });
      }
      throw reason;
    } finally {
      if (commandGeneration === generationRef.current) {
        pendingCommandsRef.current = Math.max(0, pendingCommandsRef.current - 1);
        setPendingCommands(pendingCommandsRef.current);
      }
    }
  }, [
    activeEndpointKey,
    onStatus,
    playbackTargetIsCurrent,
    refreshUpnpPlayerState,
    target,
    volumeControlEnabled,
  ]);

  const setVolume = useCallback(async (level: number) => {
    if (!Number.isInteger(level) || level < 0 || level > 100) {
      throw new Error("Volume must be an integer between 0 and 100.");
    }
    await setRenderingValue({ volume: level });
  }, [setRenderingValue]);

  const setMuted = useCallback(async (muted: boolean) => {
    await setRenderingValue({ muted });
  }, [setRenderingValue]);

  const playPlaybackTrack = useCallback(async (track: PlaybackTrack, context: PlaybackTrack[]) => {
    const revisionBeforePlay = revisionRef.current + 1;
    const desired: ConfirmedState = {
      snapshot: snapshotForTrack(track),
      ownsIdentity: true,
      ownedItemId: track.itemId,
      context,
    };
    const hydration = hydrateTrack(track);
    const command: PlaybackCommand = {
      action: "play",
      itemId: track.itemId,
      ...(track.playbackIndex !== undefined ? { index: track.playbackIndex } : {}),
    };
    const commandPromise = applyOptimisticCommand(command, desired, `Playing ${track.metadata.title || "track"}`);
    void hydration.then((hydrated) => {
      if (revisionRef.current !== revisionBeforePlay || snapshotRef.current?.itemId !== hydrated.itemId) return;
      const current = snapshotRef.current;
      if (!current) return;
      const next = {
        ...current,
        metadata: mergeTrackMetadata(hydrated.itemId, current.metadata, hydrated.metadata),
        durationSeconds: hydrated.metadata.durationSeconds ?? current.durationSeconds,
      };
      desired.snapshot = next;
      desired.context = desired.context.map((item) => item.itemId === hydrated.itemId ? hydrated : item);
      setSnapshot(next);
      if (confirmedRef.current.snapshot?.itemId === hydrated.itemId) confirmedRef.current = { ...confirmedRef.current, snapshot: next };
      contextRef.current = contextRef.current.map((item) => item.itemId === hydrated.itemId ? hydrated : item);
    });
    await commandPromise;
  }, [applyOptimisticCommand, hydrateTrack, setSnapshot]);

  const playTrack = useCallback(async (node: MaestroTreeNode, nodes: MaestroTreeNode[] = [node]) => {
    const requestGeneration = generationRef.current;
    const requestEndpointKey = activeEndpointKey;
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    const playableNode = await resolveMaestroPlaybackNode(target, node);
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    const playbackId = maestroPlaybackId(playableNode);
    if (!playbackId || (isUpnpTreeNode(playableNode) && playableNode.userData.maestroId !== playbackId)) {
      throw new Error("This UPnP track does not yet have a verified Maestro playback mapping.");
    }
    const canonicalPlayableNode = isUpnpTreeNode(playableNode)
      ? { ...playableNode, id: playbackId }
      : playableNode;
    const contextNodes = nodes.map((item) => item === node ? canonicalPlayableNode : item);
    const context = contextNodes.map((item) => playbackTrackFromNode(item, cachedMetadata(item.id)));
    const track = context.find((item) => item.itemId === playbackId)
      ?? playbackTrackFromNode(canonicalPlayableNode, cachedMetadata(playbackId));
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    await playPlaybackTrack(track, context);
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
  }, [activeEndpointKey, cachedMetadata, playbackTargetIsCurrent, playPlaybackTrack, target]);

  const playQueuedTrack = useCallback(async (queued: QueuedTrack) => {
    const requestGeneration = generationRef.current;
    const requestEndpointKey = activeEndpointKey;
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    const currentQueue = queueRef.current;
    const playableNode = await resolveMaestroPlaybackNode(target, queuedTrackNode(queued));
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    const playbackId = maestroPlaybackId(playableNode);
    if (!playbackId || (isUpnpTreeNode(playableNode) && playableNode.userData.maestroId !== playbackId)) {
      throw new Error("This queued UPnP track does not yet have a verified Maestro playback mapping.");
    }
    const canonicalPlayableNode = isUpnpTreeNode(playableNode)
      ? { ...playableNode, id: playbackId }
      : playableNode;
    const track = playbackTrackFromNode(canonicalPlayableNode, cachedMetadata(playbackId));
    const context = currentQueue.map((item) => item.queueId === queued.queueId
      ? track
      : queuedTrackAsPlaybackTrack(item, cachedMetadata(item.itemId)));
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    await playPlaybackTrack(track, context);
    if (!playbackTargetIsCurrent(requestGeneration, requestEndpointKey)) {
      throw new Error("Playback target changed.");
    }
    setQueue(queueRef.current.filter((item) => item.queueId !== queued.queueId));
  }, [
    activeEndpointKey,
    cachedMetadata,
    playbackTargetIsCurrent,
    playPlaybackTrack,
    setQueue,
    target,
  ]);

  const seek = useCallback(async (positionSeconds: number) => {
    if (!seekControlEnabled) throw new Error("Seeking is not verified for this Olive.");
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) throw new Error("Seek position must be a non-negative number.");
    const current = snapshotRef.current;
    if (!current?.itemId) throw new Error("Choose a song before seeking.");
    const desiredSnapshot = {
      ...current,
      positionSeconds: Math.min(current.durationSeconds ?? positionSeconds, positionSeconds),
      sampledAt: Date.now(),
    };
    await applyOptimisticCommand(
      { action: "seek", positionSeconds },
      { snapshot: desiredSnapshot, ownsIdentity: ownsIdentityRef.current, ownedItemId: ownedItemIdRef.current, context: contextRef.current },
      `Jumped to ${Math.floor(positionSeconds / 60)}:${String(Math.floor(positionSeconds % 60)).padStart(2, "0")}`,
    );
    await refreshUpnpPlayerState();
  }, [applyOptimisticCommand, refreshUpnpPlayerState, seekControlEnabled]);

  const skipTrack = useCallback(async (direction: "previous" | "next") => {
    const currentItemId = snapshotRef.current?.itemId ?? "";
    const adjacent = adjacentTrack(contextRef.current, currentItemId, direction);
    if (adjacent) {
      await applyOptimisticCommand(
        {
          action: "play",
          itemId: adjacent.itemId,
          ...(adjacent.playbackIndex !== undefined ? { index: adjacent.playbackIndex } : {}),
        },
        {
          snapshot: snapshotForTrack(adjacent),
          ownsIdentity: true,
          ownedItemId: adjacent.itemId,
          context: contextRef.current,
        },
        `${direction === "next" ? "Playing next" : "Playing previous"}: ${adjacent.metadata.title || "track"}`,
      );
      return;
    }
    if (isPlaybackContextBoundary(contextRef.current, currentItemId, direction)) {
      if (direction === "next") {
        await applyOptimisticCommand(
          { action: "stop" },
          {
            snapshot: stoppedSnapshot(),
            ownsIdentity: true,
            ownedItemId: "",
            context: contextRef.current,
          },
          "End of selection — playback stopped",
        );
      } else {
        onStatus("Start of selection");
      }
      return;
    }
    const desired: ConfirmedState = {
      snapshot: {
        itemId: "",
        metadata: null,
        identitySource: "none",
        transportState: "playing",
        positionSeconds: null,
        durationSeconds: null,
        sampledAt: Date.now(),
      },
      ownsIdentity: false,
      ownedItemId: "",
      context: [],
    };
    await applyOptimisticCommand({ action: direction }, desired, `${direction === "next" ? "Next" : "Previous"} sent to server`);
  }, [applyOptimisticCommand, onStatus]);

  const control = useCallback(async (action: "pause" | "stop" | "previous" | "next") => {
    if (action === "next" && queueRef.current[0]) {
      await playQueuedTrack(queueRef.current[0]);
      return;
    }
    if (action === "next" || action === "previous") {
      await skipTrack(action);
      return;
    }
    if (action === "stop") {
      await applyOptimisticCommand(
        { action: "stop" },
        { snapshot: stoppedSnapshot(), ownsIdentity: true, ownedItemId: "", context: contextRef.current },
        "Playback stopped",
      );
      return;
    }
    const current = snapshotRef.current;
    const desiredState = current?.transportState === "playing" ? "paused" : "playing";
    const desiredSnapshot = current ? { ...projectPosition(current), transportState: desiredState, sampledAt: Date.now() } as NowPlayingSnapshot : current;
    await applyOptimisticCommand(
      { action: "pause" },
      { snapshot: desiredSnapshot, ownsIdentity: ownsIdentityRef.current, ownedItemId: ownedItemIdRef.current, context: contextRef.current },
      desiredState === "paused" ? "Playback paused" : "Playback resumed",
    );
  }, [applyOptimisticCommand, playQueuedTrack, skipTrack]);

  const enqueue = useCallback((node: MaestroTreeNode) => {
    const queued = queueFromNode(node);
    const metadata = playbackTrackFromNode(node, cachedMetadata(node.id)).metadata;
    setQueue([...queueRef.current, {
      ...queued,
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
      artworkPath: metadata.artworkPath,
    }]);
  }, [cachedMetadata, setQueue]);

  const moveQueueItem = useCallback((index: number, offset: number) => {
    const next = [...queueRef.current];
    const [item] = next.splice(index, 1);
    const destination = index + offset;
    if (!item || destination < 0 || destination > next.length) return;
    next.splice(destination, 0, item);
    setQueue(next);
  }, [setQueue]);

  const removeQueueItem = useCallback((queueId: string) => {
    setQueue(queueRef.current.filter((item) => item.queueId !== queueId));
  }, [setQueue]);

  const clearQueue = useCallback(() => setQueue([]), [setQueue]);

  useEffect(() => {
    generationRef.current += 1;
    revisionRef.current += 1;
    commandTailRef.current = Promise.resolve();
    pollActiveRef.current = false;
    upnpPollActiveRef.current = false;
    upnpPollSequenceRef.current = 0;
    pendingCommandsRef.current = 0;
    setPendingCommands(0);
    latestUpnpTelemetryRef.current = null;
    setLivePositionTelemetry(false);
    setRenderingTelemetry(isDemoTarget(target)
      ? { volumePercent: 55, muted: false, sampledAt: Date.now() }
      : null);
    ownsIdentityRef.current = false;
    ownedItemIdRef.current = "";
    contextRef.current = [];
    conflictRef.current = null;
    holdConflictsUntilRef.current = 0;
    identityMissingUntilRef.current = 0;
    confirmedRef.current = { snapshot: null, ownsIdentity: false, ownedItemId: "", context: [] };
    setSnapshot(null);
    const incomingQueue = readQueue(target);
    queueRef.current = incomingQueue;
    setQueueState(incomingQueue);
    reconcileTimersRef.current.forEach(window.clearTimeout);
    reconcileTimersRef.current = [];
    if (connected) {
      void refreshSystemPlayback();
      void refreshUpnpPlayerState();
      void refreshNowPlaying();
    }
  }, [activeEndpointKey, activeTargetKey, connected, refreshSystemPlayback]);

  useEffect(() => {
    if (!connected) return;
    const legacyPoll = window.setInterval(() => void refreshNowPlaying(), 3_000);
    const systemPoll = window.setInterval(() => void refreshSystemPlayback(), 4_000);
    const upnpPoll = window.setInterval(() => {
      upnpPollSequenceRef.current += 1;
      const includeSlowTelemetry = upnpPollSequenceRef.current % 4 === 0;
      void refreshUpnpPlayerState({
        includeRendering: includeSlowTelemetry,
        includeMedia: includeSlowTelemetry,
      });
    }, 1_500);
    const clock = window.setInterval(() => setTick(Date.now()), 500);
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void refreshUpnpPlayerState();
      void refreshNowPlaying();
      void refreshSystemPlayback();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(legacyPoll);
      window.clearInterval(systemPoll);
      window.clearInterval(upnpPoll);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connected, refreshNowPlaying, refreshSystemPlayback, refreshUpnpPlayerState]);

  useEffect(() => () => {
    reconcileTimersRef.current.forEach(window.clearTimeout);
    reconcileTimersRef.current = [];
  }, []);

  useEffect(() => {
    if (!isNativeApp) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeSystemPlaybackCommands(async (command) => {
      try {
        if (command.action === "seek") await seek(command.positionSeconds);
        else if (command.action === "toggle") await control("pause");
        else await control(command.action);
      } catch (reason) {
        onStatus(reason instanceof Error ? reason.message : "System playback command failed.");
      }
    }).then((remove) => {
      if (disposed) remove();
      else unsubscribe = remove;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [control, onStatus, seek]);

  useEffect(() => {
    if (!isNativeApp) return;
    if (!connected || isDemoTarget(target) || !snapshot?.itemId || snapshot.transportState === "stopped") {
      void clearSystemPlayback();
      return;
    }
    void updateSystemPlayback(target, snapshot);
  }, [connected, snapshot, target]);

  const nowPlaying = useMemo(() => projectPosition(snapshot, tick), [snapshot, tick]);
  const stateValue = useMemo<PlaybackStateValue>(() => ({
    connected,
    target,
    nowPlaying,
    commandPending: pendingCommands > 0,
    volumeControlEnabled,
    seekControlEnabled,
    livePositionTelemetry,
    renderingTelemetry,
    queue,
  }), [
    connected,
    livePositionTelemetry,
    nowPlaying,
    pendingCommands,
    queue,
    renderingTelemetry,
    seekControlEnabled,
    target,
    volumeControlEnabled,
  ]);
  const actionsValue = useMemo<PlaybackActionsValue>(() => ({
    playTrack,
    playQueuedTrack,
    control,
    seek,
    setVolume,
    setMuted,
    enqueue,
    moveQueueItem,
    removeQueueItem,
    clearQueue,
  }), [clearQueue, control, enqueue, moveQueueItem, playQueuedTrack, playTrack, removeQueueItem, seek, setMuted, setVolume]);

  return <PlaybackActionsContext.Provider value={actionsValue}>
    <PlaybackStateContext.Provider value={stateValue}>{children}</PlaybackStateContext.Provider>
  </PlaybackActionsContext.Provider>;
}

export function usePlaybackState(): PlaybackStateValue {
  const value = useContext(PlaybackStateContext);
  if (!value) throw new Error("usePlaybackState must be used inside PlaybackProvider.");
  return value;
}

export function usePlaybackActions(): PlaybackActionsValue {
  const value = useContext(PlaybackActionsContext);
  if (!value) throw new Error("usePlaybackActions must be used inside PlaybackProvider.");
  return value;
}
