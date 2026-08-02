import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { artworkUrl } from "../artwork";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";
import { RetryingArtwork } from "./RetryingArtwork";

interface Props { open: boolean; onClose: () => void }

export function queueArtworkSource(target: OliveDeviceTarget, artworkPath: string): string {
  return artworkUrl(target, artworkPath);
}

function QueueArtwork({
  target,
  artworkPath,
  alt,
}: {
  target: OliveDeviceTarget;
  artworkPath: string;
  alt: string;
}) {
  const source = queueArtworkSource(target, artworkPath);
  return <span className="queue-art">
    {source
      ? <RetryingArtwork src={source} alt={alt} loading="lazy" decoding="async" fallback="♪" />
      : "♪"}
  </span>;
}

export function QueuePanel({ open, onClose }: Props) {
  const { target, nowPlaying, queue: tracks, commandPending } = usePlaybackState();
  const { playQueuedTrack, moveQueueItem, removeQueueItem, clearQueue } = usePlaybackActions();
  async function play(track: (typeof tracks)[number]) {
    try { await playQueuedTrack(track); onClose(); }
    catch { /* The playback controller reports and rolls back failures. */ }
  }
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onClose]);

  if (!open) return null;
  const current = nowPlaying?.metadata;
  return createPortal(<div className="queue-layer"><button className="queue-backdrop" aria-label="Close queue" onClick={onClose} /><aside className="queue-panel" role="dialog" aria-modal="true" aria-label="Play queue">
    <div className="queue-header"><div><small>PLAY QUEUE</small><h2>Next up</h2></div><button className="queue-close" onClick={onClose} aria-label="Close queue">×</button></div>
    {current && <section className="queue-current"><small>Now playing</small><div><QueueArtwork target={target} artworkPath={current.artworkPath} alt="" /><p><strong>{current.title}</strong><small>{current.artist || current.album}</small></p></div></section>}
    <div className="queue-list">{tracks.map((track, index) => <article key={track.queueId}><button className="queue-track" disabled={commandPending} onClick={() => void play(track)}><span className="queue-number">{index + 1}</span><QueueArtwork target={target} artworkPath={track.artworkPath} alt="" /><span><strong>{track.title}</strong><small>{track.artist || track.album || "Track"}</small></span></button><div className="queue-actions"><button disabled={index === 0} onClick={() => moveQueueItem(index, -1)} aria-label={`Move ${track.title} up`}>↑</button><button disabled={index === tracks.length - 1} onClick={() => moveQueueItem(index, 1)} aria-label={`Move ${track.title} down`}>↓</button><button onClick={() => removeQueueItem(track.queueId)} aria-label={`Remove ${track.title}`}>×</button></div></article>)}</div>
    {!tracks.length && <div className="queue-empty"><strong>Your queue is empty</strong><p>Add songs from Library or Search.</p></div>}
    {tracks.length > 0 && <button className="queue-clear" onClick={clearQueue}>Clear queue</button>}
  </aside></div>, document.body);
}
