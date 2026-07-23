import { artworkUrl } from "../artwork";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";

interface Props { open: boolean; onClose: () => void }

export function QueuePanel({ open, onClose }: Props) {
  const { target, nowPlaying, queue: tracks, commandPending } = usePlaybackState();
  const { playQueuedTrack, moveQueueItem, removeQueueItem, clearQueue } = usePlaybackActions();
  async function play(track: (typeof tracks)[number]) {
    try { await playQueuedTrack(track); onClose(); }
    catch { /* The playback controller reports and rolls back failures. */ }
  }
  if (!open) return null;
  const current = nowPlaying?.metadata;
  return <><button className="queue-backdrop" aria-label="Close queue" onClick={onClose} /><aside className="queue-panel" aria-label="Play queue">
    <div className="queue-header"><div><small>PLAY QUEUE</small><h2>Next up</h2></div><button className="queue-close" onClick={onClose} aria-label="Close queue">×</button></div>
    {current && <section className="queue-current"><small>Now playing</small><div><span className="queue-art">{current.artworkPath ? <img src={artworkUrl(target, current.artworkPath)} alt="" /> : "♪"}</span><p><strong>{current.title}</strong><small>{current.artist || current.album}</small></p></div></section>}
    <div className="queue-list">{tracks.map((track, index) => <article key={track.queueId}><button className="queue-track" disabled={commandPending} onClick={() => void play(track)}><span className="queue-number">{index + 1}</span><span className="queue-art">{track.artworkPath ? <img src={artworkUrl(target, track.artworkPath)} alt="" /> : "♪"}</span><span><strong>{track.title}</strong><small>{track.artist || track.album || "Track"}</small></span></button><div className="queue-actions"><button disabled={index === 0} onClick={() => moveQueueItem(index, -1)} aria-label={`Move ${track.title} up`}>↑</button><button disabled={index === tracks.length - 1} onClick={() => moveQueueItem(index, 1)} aria-label={`Move ${track.title} down`}>↓</button><button onClick={() => removeQueueItem(track.queueId)} aria-label={`Remove ${track.title}`}>×</button></div></article>)}</div>
    {!tracks.length && <div className="queue-empty"><strong>Your queue is empty</strong><p>Add songs from Library or Search.</p></div>}
    {tracks.length > 0 && <button className="queue-clear" onClick={clearQueue}>Clear queue</button>}
  </aside></>;
}
