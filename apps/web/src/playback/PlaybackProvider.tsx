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
  subscribeSystemPlaybackCommands,
  updateSystemPlayback,
} from "../systemPlayback";
import {
  queueFromNode,
  readQueue,
  writeQueue,
  type QueuedTrack,
} from "../playbackQueue";
import {
  adjacentTrack,
  mergeMatchingObservation,
  mergeTrackMetadata,
  normalizeObservation,
  playbackTrackFromNode,
  projectPosition,
  snapshotForTrack,
  stoppedSnapshot,
  type PlaybackTrack,
} from "./playbackState";

const METADATA_CACHE_KEY = "olive-playback-metadata-v2";
const METADATA_TTL_MS = 24 * 60 * 60 * 1_000;
const OBSERVATION_HOLD_MS = 6_000;

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

interface PlaybackStateValue {
  connected: boolean;
  target: OliveDeviceTarget;
  nowPlaying: NowPlayingSnapshot | null;
  commandPending: boolean;
  volumeControlEnabled: boolean;
  queue: QueuedTrack[];
}

interface PlaybackActionsValue {
  playTrack: (node: MaestroTreeNode, context?: MaestroTreeNode[]) => Promise<void>;
  playQueuedTrack: (track: QueuedTrack) => Promise<void>;
  control: (action: "pause" | "stop" | "previous" | "next") => Promise<void>;
  seek: (positionSeconds: number) => Promise<void>;
  volume: (action: "volumeDown" | "mute" | "volumeUp") => Promise<void>;
  enqueue: (node: MaestroTreeNode) => void;
  moveQueueItem: (index: number, offset: number) => void;
  removeQueueItem: (queueId: string) => void;
  clearQueue: () => void;
}

const PlaybackStateContext = createContext<PlaybackStateValue | null>(null);
const PlaybackActionsContext = createContext<PlaybackActionsValue | null>(null);

function targetKey(target: OliveDeviceTarget): string {
  return `${target.host.trim().toLowerCase()}:${target.port}`;
}

function cacheKey(target: OliveDeviceTarget, itemId: string): string {
  return `${targetKey(target)}:${itemId}`;
}

function readMetadataCache(): Record<string, CachedMetadata> {
  try {
    const parsed = JSON.parse(localStorage.getItem(METADATA_CACHE_KEY) ?? "{}") as Record<string, CachedMetadata>;
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
  onStatus,
  children,
}: {
  connected: boolean;
  target: OliveDeviceTarget;
  volumeControlEnabled: boolean;
  onStatus: (status: string) => void;
  children: ReactNode;
}) {
  const [snapshot, setSnapshotState] = useState<NowPlayingSnapshot | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [pendingCommands, setPendingCommands] = useState(0);
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
  const commandTailRef = useRef<Promise<void>>(Promise.resolve());
  const holdConflictsUntilRef = useRef(0);
  const conflictRef = useRef<{ itemId: string; count: number } | null>(null);
  const metadataCacheRef = useRef<Record<string, CachedMetadata>>(readMetadataCache());
  const reconcileTimersRef = useRef<number[]>([]);
  const activeTargetKey = targetKey(target);

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
    try { localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(metadataCacheRef.current)); }
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

  const refreshNowPlaying = useCallback(async () => {
    if (!connected || !target.host || document.visibilityState !== "visible" || pollActiveRef.current) return;
    const generation = generationRef.current;
    const revision = revisionRef.current;
    const requestedTargetKey = activeTargetKey;
    pollActiveRef.current = true;
    try {
      const response = await appFetch("/api/now-playing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      if (!response.ok) return;
      const incoming = await response.json() as Partial<NowPlayingSnapshot> & Pick<NowPlayingSnapshot, "itemId" | "metadata">;
      if (generation !== generationRef.current || revision < revisionRef.current || requestedTargetKey !== activeTargetKey) return;
      const observed = normalizeObservation(incoming, cachedMetadata(incoming.itemId));
      if (observed.metadata) rememberMetadata(observed.itemId, observed.metadata);

      const current = snapshotRef.current;
      if (!ownsIdentityRef.current) {
        setSnapshot(observed);
        confirmedRef.current = { snapshot: observed, ownsIdentity: false, ownedItemId: "", context: contextRef.current };
        conflictRef.current = null;
        return;
      }

      const ownedItemId = ownedItemIdRef.current;
      if (observed.itemId === ownedItemId && current) {
        const merged = mergeMatchingObservation(current, observed);
        setSnapshot(merged);
        confirmedRef.current = { snapshot: merged, ownsIdentity: true, ownedItemId, context: contextRef.current };
        conflictRef.current = null;
        return;
      }
      if (ownedItemId && !observed.itemId && observed.transportState !== "stopped" && current) {
        const projected = projectPosition(current) ?? current;
        const merged = {
          ...projected,
          transportState: observed.transportState === "unknown" ? current.transportState : observed.transportState,
          positionSeconds: observed.positionSeconds ?? projected.positionSeconds,
          durationSeconds: observed.durationSeconds ?? current.durationSeconds,
          sampledAt: Date.now(),
        };
        setSnapshot(merged);
        return;
      }
      if (!ownedItemId && observed.transportState === "stopped") {
        setSnapshot(observed);
        confirmedRef.current = { snapshot: observed, ownsIdentity: true, ownedItemId: "", context: contextRef.current };
        conflictRef.current = null;
        return;
      }
      if (Date.now() < holdConflictsUntilRef.current || pendingCommandsRef.current > 0) return;

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
      if (conflictRef.current.count < (isExpectedNaturalAdvance ? 1 : 2)) return;

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
      conflictRef.current = null;
    } catch { /* Connection status and later polls handle temporary failures. */ }
    finally {
      if (generation === generationRef.current) pollActiveRef.current = false;
    }
  }, [activeTargetKey, cachedMetadata, connected, rememberMetadata, setSnapshot, target]);

  const sendCommand = useCallback((command: PlaybackCommand): Promise<void> => {
    const generation = generationRef.current;
    const run = async () => {
      if (generation !== generationRef.current) throw new Error("Playback target changed.");
      const response = await appFetch("/api/playback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, command }),
      });
      if (!response.ok) throw await responseError(response, "Playback command failed.");
      if (generation !== generationRef.current) throw new Error("Playback target changed.");
    };
    const result = commandTailRef.current.then(run, run);
    commandTailRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, [target]);

  const applyOptimisticCommand = useCallback(async (
    command: PlaybackCommand,
    desired: ConfirmedState,
    successStatus: string,
  ) => {
    const commandGeneration = generationRef.current;
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
      confirmedRef.current = desired;
      if (revision === revisionRef.current) {
        holdConflictsUntilRef.current = Date.now() + OBSERVATION_HOLD_MS;
        onStatus(successStatus);
        scheduleRefresh(refreshNowPlaying);
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
  }, [onStatus, refreshNowPlaying, scheduleRefresh, sendCommand, setSnapshot]);

  const volume = useCallback(async (action: "volumeDown" | "mute" | "volumeUp") => {
    if (!volumeControlEnabled) throw new Error("Volume control is not available for this Olive model.");
    const commandGeneration = generationRef.current;
    pendingCommandsRef.current += 1;
    setPendingCommands(pendingCommandsRef.current);
    try {
      await sendCommand({ action });
      onStatus(action === "volumeDown" ? "Volume lowered" : action === "volumeUp" ? "Volume raised" : "Mute toggled");
    } catch (reason) {
      if (commandGeneration === generationRef.current) onStatus(reason instanceof Error ? reason.message : "Volume command failed.");
      throw reason;
    } finally {
      if (commandGeneration === generationRef.current) {
        pendingCommandsRef.current = Math.max(0, pendingCommandsRef.current - 1);
        setPendingCommands(pendingCommandsRef.current);
      }
    }
  }, [onStatus, sendCommand, volumeControlEnabled]);

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
    const context = nodes.map((item) => playbackTrackFromNode(item, cachedMetadata(item.id)));
    const track = context.find((item) => item.itemId === node.id) ?? playbackTrackFromNode(node, cachedMetadata(node.id));
    await playPlaybackTrack(track, context);
  }, [cachedMetadata, playPlaybackTrack]);

  const playQueuedTrack = useCallback(async (queued: QueuedTrack) => {
    const currentQueue = queueRef.current;
    const context = currentQueue.map((item) => queuedTrackAsPlaybackTrack(item, cachedMetadata(item.itemId)));
    const track = context.find((item) => item.itemId === queued.itemId) ?? queuedTrackAsPlaybackTrack(queued, cachedMetadata(queued.itemId));
    await playPlaybackTrack(track, context);
    setQueue(queueRef.current.filter((item) => item.queueId !== queued.queueId));
  }, [cachedMetadata, playPlaybackTrack, setQueue]);

  const seek = useCallback(async (positionSeconds: number) => {
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
  }, [applyOptimisticCommand]);

  const skipTrack = useCallback(async (direction: "previous" | "next") => {
    const currentItemId = snapshotRef.current?.itemId ?? "";
    const adjacent = adjacentTrack(contextRef.current, currentItemId, direction);
    if (adjacent) {
      await applyOptimisticCommand(
        { action: direction },
        {
          snapshot: snapshotForTrack(adjacent),
          ownsIdentity: true,
          ownedItemId: adjacent.itemId,
          context: contextRef.current,
        },
        `${direction === "next" ? "Next" : "Previous"} sent to server`,
      );
      return;
    }
    const desired: ConfirmedState = {
      snapshot: {
        itemId: "",
        metadata: null,
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
  }, [applyOptimisticCommand]);

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
    pendingCommandsRef.current = 0;
    setPendingCommands(0);
    ownsIdentityRef.current = false;
    ownedItemIdRef.current = "";
    contextRef.current = [];
    conflictRef.current = null;
    holdConflictsUntilRef.current = 0;
    confirmedRef.current = { snapshot: null, ownsIdentity: false, ownedItemId: "", context: [] };
    setSnapshot(null);
    const incomingQueue = readQueue(target);
    queueRef.current = incomingQueue;
    setQueueState(incomingQueue);
    reconcileTimersRef.current.forEach(window.clearTimeout);
    reconcileTimersRef.current = [];
    if (connected) void refreshNowPlaying();
  }, [activeTargetKey, connected]);

  useEffect(() => {
    if (!connected) return;
    const poll = window.setInterval(() => void refreshNowPlaying(), 5_000);
    const clock = window.setInterval(() => setTick(Date.now()), 1_000);
    const handleVisibility = () => { if (document.visibilityState === "visible") void refreshNowPlaying(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [connected, refreshNowPlaying]);

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
    queue,
  }), [connected, nowPlaying, pendingCommands, queue, target, volumeControlEnabled]);
  const actionsValue = useMemo<PlaybackActionsValue>(() => ({
    playTrack,
    playQueuedTrack,
    control,
    seek,
    volume,
    enqueue,
    moveQueueItem,
    removeQueueItem,
    clearQueue,
  }), [clearQueue, control, enqueue, moveQueueItem, playQueuedTrack, playTrack, removeQueueItem, seek, volume]);

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
