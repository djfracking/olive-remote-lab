import { useEffect, useState } from "react";
import type { NowPlayingSnapshot, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { artworkUrl } from "../artwork";
import { Icon } from "./Icons";
import { announceTrackChanging } from "../playbackEvents";

interface NowPlayingViewProps {
  connected: boolean;
  target: OliveDeviceTarget;
  nowPlaying: NowPlayingSnapshot | null;
  onStatus: (status: string) => void;
}

function formatTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--:--";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function NowPlayingView({ connected, target, nowPlaying, onStatus }: NowPlayingViewProps) {
  const [error, setError] = useState("");
  const [commandPending, setCommandPending] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const track = nowPlaying?.metadata;
  const art = artworkUrl(target, track?.artworkPath ?? "");
  const position = nowPlaying?.positionSeconds ?? null;
  const duration = nowPlaying?.durationSeconds ?? track?.durationSeconds ?? null;
  const progress = position !== null && duration !== null && duration > 0 ? Math.min(100, Math.max(0, position / duration * 100)) : 0;
  const playing = nowPlaying?.transportState === "playing";

  useEffect(() => setImageFailed(false), [art]);

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;

  async function control(action: "pause" | "stop" | "previous" | "next") {
    setCommandPending(true); setError("");
    try {
      if (action === "previous" || action === "next") announceTrackChanging(nowPlaying?.itemId ?? "");
      const response = await appFetch("/api/playback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, command: { action } }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Playback command failed.");
      onStatus(`${action[0]?.toUpperCase()}${action.slice(1)} sent to server`);
      window.dispatchEvent(new Event("olive-playback-changed"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback command failed."); }
    finally { setCommandPending(false); }
  }

  return <section className="now-playing-layout">
    <div className="card now-playing-card">
      <div className="now-art">{art && !imageFailed ? <img src={art} alt={track?.album ? `${track.album} artwork` : "Album artwork"} onError={() => setImageFailed(true)} /> : <span>♪</span>}</div>
      <div className="now-copy"><h2>{track?.title || (playing ? "Playing" : "Nothing playing")}</h2>{track?.artist && <p>{track.artist}</p>}{track?.album && <small>{track.album}</small>}
        <div className="hero-transport" aria-label="Playback controls"><button disabled={commandPending} onClick={() => void control("previous")} aria-label="Previous"><Icon name="previous" /></button><button className="hero-play" disabled={commandPending} onClick={() => void control("pause")} aria-label={playing ? "Pause" : "Resume playback"}><Icon name={playing ? "pause" : "play"} /></button><button disabled={commandPending} onClick={() => void control("next")} aria-label="Next"><Icon name="next" /></button><button disabled={commandPending} onClick={() => void control("stop")} aria-label="Stop"><Icon name="stop" /></button></div>
        <div className={`hero-progress ${position === null || duration === null ? "indeterminate" : ""}`} aria-label={`Playback position ${formatTime(position)} of ${formatTime(duration)}`}><div><span>{formatTime(position)}</span><span>{formatTime(duration)}</span></div><i><b style={{ width: `${progress}%` }} /></i></div>
      </div>
    </div>
    {error && <div className="error-box">{error}</div>}
  </section>;
}
