import { useEffect, useState } from "react";
import type { MaestroTrackMetadata, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { artworkUrl } from "../artwork";

interface NowPlayingResponse { itemId: string; metadata: MaestroTrackMetadata | null }
interface Props { connected: boolean; enabled: boolean; target: OliveDeviceTarget; onOpen: () => void; onStatus: (status: string) => void }

export function MiniPlayer({ connected, enabled, target, onOpen, onStatus }: Props) {
  const [nowPlaying, setNowPlaying] = useState<NowPlayingResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  async function refresh() {
    if (!connected || !enabled || document.visibilityState !== "visible") { if (!connected) setNowPlaying(null); return; }
    try {
      const response = await appFetch("/api/now-playing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target) });
      if (response.ok) { setNowPlaying(await response.json() as NowPlayingResponse); setImageFailed(false); }
    } catch { /* The global connection indicator reports device failures. */ }
  }

  useEffect(() => {
    void refresh();
    if (!connected || !enabled) return;
    const timer = window.setInterval(() => void refresh(), 30_000);
    const handlePlaybackChange = () => window.setTimeout(() => void refresh(), 350);
    window.addEventListener("olive-playback-changed", handlePlaybackChange);
    return () => { window.clearInterval(timer); window.removeEventListener("olive-playback-changed", handlePlaybackChange); };
  }, [connected, enabled, target.host, target.port]);

  async function control(action: "previous" | "pause" | "stop" | "next") {
    setPending(true);
    try {
      const response = await appFetch("/api/playback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, command: { action } }) });
      if (!response.ok) throw new Error("Playback command failed.");
      onStatus(`${action[0]?.toUpperCase()}${action.slice(1)} sent to server`);
      window.dispatchEvent(new Event("olive-playback-changed"));
      window.setTimeout(() => void refresh(), 500);
    } catch (reason) { onStatus(reason instanceof Error ? reason.message : "Playback command failed."); }
    finally { setPending(false); }
  }

  const track = nowPlaying?.metadata;
  const art = artworkUrl(target, track?.artworkPath ?? "");

  return <aside className="mini-player" aria-label="Current playback">
    <button className="mini-track" onClick={onOpen} aria-label="Open Now Playing">
      <span className="mini-art">{art && !imageFailed ? <img src={art} alt="" onError={() => setImageFailed(true)} /> : "♪"}</span>
      <span className="mini-copy"><strong>{track?.title || (connected ? "Nothing playing" : "Finding your Olive…")}</strong><small>{track?.artist || track?.album || (connected ? "Olive music server" : "Automatic local connection")}</small></span>
    </button>
    <div className="mini-controls">
      <button disabled={!connected || pending} onClick={() => void control("previous")} aria-label="Previous track">‹‹</button>
      <button disabled={!connected || pending} onClick={() => void control("stop")} aria-label="Stop playback">■</button>
      <button disabled={!connected || pending} onClick={() => void control("pause")} aria-label="Play or pause">Ⅱ</button>
      <button disabled={!connected || pending} onClick={() => void control("next")} aria-label="Next track">››</button>
    </div>
    <button className="mini-open" onClick={onOpen} aria-label="Expand Now Playing">⌃</button>
  </aside>;
}
