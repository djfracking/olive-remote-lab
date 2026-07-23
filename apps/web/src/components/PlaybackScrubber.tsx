import { useEffect, useRef, useState } from "react";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";

interface Props {
  className: "hero-progress" | "mini-progress";
}

function formatTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--:--";
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function PlaybackScrubber({ className }: Props) {
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const seeking = useRef(false);
  const { connected, nowPlaying, commandPending } = usePlaybackState();
  const { seek } = usePlaybackActions();
  const itemId = nowPlaying?.itemId ?? "";
  const position = nowPlaying?.positionSeconds ?? null;
  const duration = nowPlaying?.durationSeconds ?? nowPlaying?.metadata?.durationSeconds ?? null;

  useEffect(() => {
    setDragPosition(null);
  }, [itemId]);

  const canSeek = connected && !commandPending && position !== null && duration !== null && duration > 0;
  const shownPosition = dragPosition ?? position;
  const progress = shownPosition !== null && duration !== null && duration > 0
    ? Math.min(100, Math.max(0, shownPosition / duration * 100)) : 0;

  async function commitSeek(value: number) {
    if (!canSeek || seeking.current) return;
    seeking.current = true;
    setDragPosition(null);
    try {
      await seek(value);
    } catch { /* The playback controller reports and rolls back failures. */ }
    finally { seeking.current = false; }
  }

  return <div className={`${className} ${canSeek ? "scrubbable" : "indeterminate"}`} aria-label={`Playback position ${formatTime(shownPosition)} of ${formatTime(duration)}`}>
    <div><span>{formatTime(shownPosition)}</span><span>{formatTime(duration)}</span></div>
    <span className="scrub-rail">
      <i><b style={{ width: `${progress}%` }} /></i>
      {canSeek && <input type="range" min="0" max={duration!} step="1" value={shownPosition ?? 0}
        aria-label="Seek through track" aria-valuetext={`${formatTime(shownPosition)} of ${formatTime(duration)}`}
        onPointerDown={() => setDragPosition(shownPosition ?? 0)}
        onInput={(event) => setDragPosition(Number(event.currentTarget.value))}
        onChange={(event) => setDragPosition(Number(event.currentTarget.value))}
        onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))}
        onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void commitSeek(Number(event.currentTarget.value)); }} />}
    </span>
  </div>;
}
