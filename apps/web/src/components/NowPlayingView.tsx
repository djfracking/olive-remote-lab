import { useState } from "react";
import { artworkUrl } from "../artwork";
import { Icon } from "./Icons";
import { PlaybackScrubber } from "./PlaybackScrubber";
import { QueuePanel } from "./QueuePanel";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";
import { RetryingArtwork } from "./RetryingArtwork";
import { VolumeControl } from "./VolumeControl";

export function NowPlayingView() {
  const [error, setError] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const { connected, target, nowPlaying, commandPending } = usePlaybackState();
  const { control } = usePlaybackActions();

  const track = nowPlaying?.metadata;
  const art = artworkUrl(target, track?.artworkPath ?? "");
  const playing = nowPlaying?.transportState === "playing";

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;

  async function runControl(action: "pause" | "stop" | "previous" | "next") {
    setError("");
    try { await control(action); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Playback command failed."); }
  }

  return <section className="now-playing-layout">
    <div className="card now-playing-card">
      <div className="now-art"><RetryingArtwork src={art} alt={track?.album ? `${track.album} artwork` : "Album artwork"} fallback={<span>♪</span>} /></div>
      <div className="now-copy"><h2>{track?.title || "Choose a song"}</h2>{track?.artist && <p>{track.artist}</p>}{track?.album && <small>{track.album}</small>}
        <div className="hero-transport" aria-label="Playback controls"><button disabled={commandPending} onClick={() => void runControl("previous")} aria-label="Previous"><Icon name="previous" /></button><button className="hero-play" disabled={commandPending} onClick={() => void runControl("pause")} aria-label={playing ? "Pause" : "Resume playback"}><Icon name={playing ? "pause" : "play"} /></button><button disabled={commandPending} onClick={() => void runControl("next")} aria-label="Next"><Icon name="next" /></button><button disabled={commandPending} onClick={() => void runControl("stop")} aria-label="Stop"><Icon name="stop" /></button><button onClick={() => setQueueOpen(true)} aria-label="Open play queue">≡</button></div>
        <PlaybackScrubber className="hero-progress" />
        <VolumeControl onError={setError} />
      </div>
    </div>
    {error && <div className="error-box">{error}</div>}<QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
  </section>;
}
