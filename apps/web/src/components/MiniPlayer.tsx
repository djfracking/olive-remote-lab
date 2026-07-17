import { useEffect, useState } from "react";
import type { NowPlayingSnapshot, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { artworkUrl } from "../artwork";
import { Icon } from "./Icons";
import { announceTrackChanging } from "../playbackEvents";

interface Props {
  connected: boolean;
  target: OliveDeviceTarget;
  nowPlaying: NowPlayingSnapshot | null;
  expanded: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onStatus: (status: string) => void;
}

function formatTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--:--";
  const seconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MiniPlayer({ connected, target, nowPlaying, expanded, onOpen, onToggle, onStatus }: Props) {
  const [pending, setPending] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const track = nowPlaying?.metadata;
  const art = artworkUrl(target, track?.artworkPath ?? "");
  const position = nowPlaying?.positionSeconds ?? null;
  const duration = nowPlaying?.durationSeconds ?? track?.durationSeconds ?? null;
  const progress = position !== null && duration !== null && duration > 0 ? Math.min(100, Math.max(0, position / duration * 100)) : 0;
  const playing = nowPlaying?.transportState === "playing";

  useEffect(() => setImageFailed(false), [art]);

  async function control(action: "previous" | "pause" | "stop" | "next") {
    setPending(true);
    try {
      if (action === "previous" || action === "next") announceTrackChanging(nowPlaying?.itemId ?? "");
      const response = await appFetch("/api/playback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, command: { action } }) });
      if (!response.ok) throw new Error("Playback command failed.");
      onStatus(`${action[0]?.toUpperCase()}${action.slice(1)} sent to server`);
      window.dispatchEvent(new Event("olive-playback-changed"));
    } catch (reason) { onStatus(reason instanceof Error ? reason.message : "Playback command failed."); }
    finally { setPending(false); }
  }

  return <aside className="mini-player" aria-label="Current playback">
    <button className="mini-track" onClick={onOpen} aria-label="Open Now Playing">
      <span className="mini-art">{art && !imageFailed ? <img src={art} alt="" onError={() => setImageFailed(true)} /> : "♪"}</span>
      <span className="mini-copy"><strong>{track?.title || (playing ? "Playing" : connected ? "Nothing playing" : "Finding your Olive…")}</strong>{(track?.artist || track?.album) && <small>{track.artist || track.album}</small>}</span>
    </button>
    <div className="mini-center">
      <div className="mini-controls">
        <button disabled={!connected || pending} onClick={() => void control("previous")} aria-label="Previous track"><Icon name="previous" /></button>
        <button className="primary-play" disabled={!connected || pending} onClick={() => void control("pause")} aria-label={playing ? "Pause" : "Resume playback"}><Icon name={playing ? "pause" : "play"} /></button>
        <button disabled={!connected || pending} onClick={() => void control("next")} aria-label="Next track"><Icon name="next" /></button>
        <button disabled={!connected || pending} onClick={() => void control("stop")} aria-label="Stop playback"><Icon name="stop" /></button>
      </div>
      <div className={`mini-progress ${position === null || duration === null ? "indeterminate" : ""}`} aria-label={`Playback position ${formatTime(position)} of ${formatTime(duration)}`}>
        <span>{formatTime(position)}</span><i><b style={{ width: `${progress}%` }} /></i><span>{formatTime(duration)}</span>
      </div>
    </div>
    <button className="mini-open" onClick={onToggle} aria-label={expanded ? "Collapse Now Playing" : "Expand Now Playing"}><Icon name={expanded ? "collapse" : "expand"} /></button>
  </aside>;
}
