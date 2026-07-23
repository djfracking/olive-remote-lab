import { useState } from "react";
import { artworkUrl } from "../artwork";
import { Icon } from "./Icons";
import { PlaybackScrubber } from "./PlaybackScrubber";
import { QueuePanel } from "./QueuePanel";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";
import { RetryingArtwork } from "./RetryingArtwork";
import { VolumeControl } from "./VolumeControl";

interface Props {
  expanded: boolean;
  onOpen: () => void;
  onToggle: () => void;
}

export function MiniPlayer({ expanded, onOpen, onToggle }: Props) {
  const [queueOpen, setQueueOpen] = useState(false);
  const { connected, target, nowPlaying, commandPending } = usePlaybackState();
  const { control } = usePlaybackActions();
  const track = nowPlaying?.metadata;
  const art = artworkUrl(target, track?.artworkPath ?? "");
  const playing = nowPlaying?.transportState === "playing";

  return <aside className={`mini-player ${expanded ? "expanded" : ""}`} aria-label="Current playback">
    <button className="mini-track" onClick={onOpen} aria-label="Open Now Playing">
      <span className="mini-art"><RetryingArtwork src={art} alt="" fallback="♪" /></span>
      <span className="mini-copy"><strong>{track?.title || (connected ? "Choose a song" : "Finding your Olive…")}</strong>{(track?.artist || track?.album) && <small>{track.artist || track.album}</small>}</span>
    </button>
    <div className="mini-center">
      <div className="mini-controls">
        <button disabled={!connected || commandPending} onClick={() => void control("previous").catch(() => undefined)} aria-label="Previous track"><Icon name="previous" /></button>
        <button className="primary-play" disabled={!connected || commandPending} onClick={() => void control("pause").catch(() => undefined)} aria-label={playing ? "Pause" : "Resume playback"}><Icon name={playing ? "pause" : "play"} /></button>
        <button disabled={!connected || commandPending} onClick={() => void control("next").catch(() => undefined)} aria-label="Next track"><Icon name="next" /></button>
        <button disabled={!connected || commandPending} onClick={() => void control("stop").catch(() => undefined)} aria-label="Stop playback"><Icon name="stop" /></button>
      </div>
      <PlaybackScrubber className="mini-progress" />
    </div>
    <VolumeControl compact />
    <button className="mini-queue" onClick={() => setQueueOpen(true)} aria-label="Open play queue">≡</button>
    <button className="mini-open" onClick={onToggle} aria-label={expanded ? "Collapse Now Playing" : "Expand Now Playing"}><Icon name={expanded ? "collapse" : "expand"} /></button>
    <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
  </aside>;
}
