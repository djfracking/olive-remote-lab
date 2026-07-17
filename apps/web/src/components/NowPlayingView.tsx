import { useEffect, useState } from "react";
import type { MaestroTrackMetadata, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { artworkUrl } from "../artwork";

interface NowPlayingViewProps {
  connected: boolean;
  target: OliveDeviceTarget;
  onStatus: (status: string) => void;
}

interface NowPlayingResponse { itemId: string; metadata: MaestroTrackMetadata | null }

export function NowPlayingView({ connected, target, onStatus }: NowPlayingViewProps) {
  const [nowPlaying, setNowPlaying] = useState<NowPlayingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [commandPending, setCommandPending] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  async function refresh() {
    if (!connected || document.visibilityState !== "visible") return;
    setLoading(true); setError("");
    try {
      const response = await appFetch("/api/now-playing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target) });
      const data = await response.json() as NowPlayingResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Now Playing unavailable.");
      setNowPlaying(data); setImageFailed(false); onStatus(data.itemId ? "Now Playing updated" : "The server is idle");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Now Playing unavailable."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!connected) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 20_000);
    const handlePlaybackChange = () => window.setTimeout(() => void refresh(), 350);
    window.addEventListener("olive-playback-changed", handlePlaybackChange);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener("olive-playback-changed", handlePlaybackChange); };
  }, [connected, target.host, target.port]);

  if (!connected) return <section className="card module-empty"><h2>Connect a server</h2><p>Choose a local device in Explorer to see what is playing.</p></section>;
  const track = nowPlaying?.metadata;
  const art = artworkUrl(target, track?.artworkPath ?? "");

  async function control(action: "pause" | "stop" | "previous" | "next") {
    setCommandPending(true); setError("");
    try {
      const response = await appFetch("/api/playback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, command: { action } }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Playback command failed.");
      onStatus(`${action[0]?.toUpperCase()}${action.slice(1)} sent to server`);
      window.dispatchEvent(new Event("olive-playback-changed"));
      window.setTimeout(() => void refresh(), 500);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback command failed."); }
    finally { setCommandPending(false); }
  }

  return <section className="now-playing-layout">
    <div className="card now-playing-card">
      <div className="now-art">{art && !imageFailed ? <img src={art} alt={track?.album ? `${track.album} artwork` : "Album artwork"} onError={() => setImageFailed(true)} /> : <span>♪</span>}</div>
      <div className="now-copy"><span className="eyebrow">NOW PLAYING · LIVE FROM SERVER</span><h2>{track?.title || (nowPlaying?.itemId ? "Track detected" : "Nothing playing")}</h2><p>{track?.artist || "—"}</p><small>{track?.album || "The server has not returned full metadata yet."}</small>
        <div className="track-facts"><span>Genre<strong>{track?.genre || "Unknown"}</strong></span><span>Rating<strong>{track?.rating !== null && track?.rating !== undefined ? `${track.rating}/5` : "—"}</strong></span><span>Plays<strong>{track?.playCount ?? "—"}</strong></span></div>
      </div>
      <button className="secondary refresh-now" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
    </div>
    {error && <div className="error-box">{error}</div>}
    <div className="card controls-locked"><span className="step">DEVICE CONTROLS</span><h3>Server transport</h3><p>Previous, play/pause, stop and next use the exact control requests exposed by the original device interface.</p><div className="transport-preview"><button disabled={commandPending} onClick={() => void control("previous")} aria-label="Previous">‹‹</button><button disabled={commandPending} onClick={() => void control("stop")} aria-label="Stop">■</button><button disabled={commandPending} onClick={() => void control("pause")} aria-label="Play or pause">Ⅱ</button><button disabled={commandPending} onClick={() => void control("next")} aria-label="Next">››</button></div></div>
  </section>;
}
