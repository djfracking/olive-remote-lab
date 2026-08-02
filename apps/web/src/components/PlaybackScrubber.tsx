import { useEffect, useRef, useState } from "react";
import { isDemoTarget } from "../demoOlive";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";
import { playbackProgress } from "../playback/playbackState";

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
  const {
    connected,
    target,
    nowPlaying,
    commandPending,
    seekControlEnabled,
    livePositionTelemetry,
  } = usePlaybackState();
  const { seek } = usePlaybackActions();
  const itemId = nowPlaying?.itemId ?? "";
  const position = nowPlaying?.positionSeconds ?? null;
  const duration = nowPlaying?.durationSeconds ?? nowPlaying?.metadata?.durationSeconds ?? null;

  useEffect(() => {
    setDragPosition(null);
  }, [itemId]);

  const progress = playbackProgress(dragPosition ?? position, duration);
  const shownPosition = progress?.positionSeconds ?? dragPosition ?? position;
  const telemetryReady = livePositionTelemetry || isDemoTarget(target);
  const canSeek = connected && seekControlEnabled && telemetryReady && !commandPending && progress !== null;

  async function commitSeek(value: number) {
    if (!canSeek || seeking.current) return;
    seeking.current = true;
    setDragPosition(null);
    try {
      await seek(value);
    } catch { /* The playback controller reports and rolls back failures. */ }
    finally { seeking.current = false; }
  }

  const progressLabel = `Playback position ${formatTime(shownPosition)} of ${formatTime(duration)}`;
  const modeLabel = !seekControlEnabled
    ? "Live playback progress. Seeking is not verified for this Olive."
    : telemetryReady
      ? "Drag the playback position to seek."
      : "Live playback progress is temporarily unavailable, so seeking is paused.";

  return <div
    className={`${className} ${progress ? "determinate" : "indeterminate"} ${canSeek ? "scrubbable" : "read-only"}`}
    aria-label={progressLabel}
    title={modeLabel}
  >
    <div><span>{formatTime(shownPosition)}</span><span>{formatTime(duration)}</span></div>
    <span className="scrub-rail">
      <i
        role="progressbar"
        aria-label="Live playback progress"
        aria-valuemin={0}
        aria-valuemax={progress?.durationSeconds}
        aria-valuenow={progress?.positionSeconds}
        aria-valuetext={progressLabel}
      ><b style={{ width: `${progress?.percent ?? 0}%` }} /></i>
      {canSeek && <input type="range" min="0" max={progress.durationSeconds} step="1" value={progress.positionSeconds}
        aria-label="Seek through track" aria-valuetext={progressLabel}
        onPointerDown={() => setDragPosition(shownPosition ?? 0)}
        onInput={(event) => setDragPosition(Number(event.currentTarget.value))}
        onChange={(event) => setDragPosition(Number(event.currentTarget.value))}
        onPointerUp={(event) => void commitSeek(Number(event.currentTarget.value))}
        onPointerCancel={() => setDragPosition(null)}
        onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) void commitSeek(Number(event.currentTarget.value)); }} />}
    </span>
    <span className="sr-only">{modeLabel}</span>
  </div>;
}
