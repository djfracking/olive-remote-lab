import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { NowPlayingSnapshot, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { artworkUrl } from "./artwork";
import { isNativeAndroid, isNativeApp } from "./nativeApi";

interface NativePlaybackSnapshot {
  target: OliveDeviceTarget;
  itemId: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string;
  state: NowPlayingSnapshot["transportState"];
  positionSeconds: number | null;
  durationSeconds: number | null;
  sampledAt: number;
}

interface OlivePlaybackPlugin {
  update(options: NativePlaybackSnapshot): Promise<void>;
  clear(): Promise<void>;
  acknowledge(options: { id: string }): Promise<void>;
  current(): Promise<NativePlaybackSnapshot & { host: string; port: number }>;
  addListener(
    eventName: "command",
    listener: (command: SystemPlaybackCommand) => void,
  ): Promise<PluginListenerHandle>;
}

export async function readSystemPlayback(target: OliveDeviceTarget): Promise<NowPlayingSnapshot | null> {
  if (!OlivePlayback || !isNativeAndroid) return null;
  try {
    const current = await OlivePlayback.current();
    if (
      current.host.trim().toLowerCase() !== target.host.trim().toLowerCase()
      || current.port !== target.port
      || !current.itemId
      || !current.title
    ) return null;
    const state = current.state === "playing" || current.state === "paused" || current.state === "stopped"
      ? current.state
      : "unknown";
    const positionSeconds = typeof current.positionSeconds === "number" && current.positionSeconds >= 0
      ? current.positionSeconds
      : null;
    const durationSeconds = typeof current.durationSeconds === "number" && current.durationSeconds > 0
      ? current.durationSeconds
      : null;
    return {
      itemId: current.itemId,
      metadata: {
        id: current.itemId,
        title: current.title,
        artist: current.artist,
        album: current.album,
        genre: "",
        artworkPath: current.artworkUrl,
        durationSeconds,
        playCount: null,
        rating: null,
        raw: { source: "android-media-session" },
      },
      identitySource: "device",
      transportState: state,
      positionSeconds,
      durationSeconds,
      sampledAt: current.sampledAt > 0 ? current.sampledAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export type SystemPlaybackCommand =
  | { id: string; action: "toggle" | "previous" | "next" | "stop" }
  | { id: string; action: "seek"; positionSeconds: number };

const OlivePlayback = isNativeApp ? registerPlugin<OlivePlaybackPlugin>("OlivePlayback") : null;

export async function updateSystemPlayback(target: OliveDeviceTarget, snapshot: NowPlayingSnapshot): Promise<void> {
  if (!OlivePlayback || !snapshot.itemId || snapshot.transportState === "stopped") return;
  const metadata = snapshot.metadata;
  try {
    await OlivePlayback.update({
      target,
      itemId: snapshot.itemId,
      title: metadata?.title || "Playing on Olive",
      artist: metadata?.artist || "",
      album: metadata?.album || "",
      artworkUrl: artworkUrl(target, metadata?.artworkPath ?? ""),
      state: snapshot.transportState,
      positionSeconds: snapshot.positionSeconds,
      durationSeconds: snapshot.durationSeconds ?? metadata?.durationSeconds ?? null,
      sampledAt: snapshot.sampledAt,
    });
  } catch {
    // System controls are an enhancement; in-app playback must remain available.
  }
}

export async function clearSystemPlayback(): Promise<void> {
  if (!OlivePlayback) return;
  try { await OlivePlayback.clear(); } catch { /* The native session may already be gone. */ }
}

export async function subscribeSystemPlaybackCommands(
  handler: (command: SystemPlaybackCommand) => Promise<void> | void,
): Promise<() => void> {
  if (!OlivePlayback) return () => undefined;
  const listener = await OlivePlayback.addListener("command", (command) => {
    void (async () => {
      // Acknowledge before doing network work so native never issues a duplicate fallback command.
      try { await OlivePlayback.acknowledge({ id: command.id }); } catch { /* Native fallback remains available. */ }
      await handler(command);
    })();
  });
  return () => { void listener.remove(); };
}
