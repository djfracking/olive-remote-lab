import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./Icons";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";

interface Props {
  compact?: boolean;
  onError?: (message: string) => void;
}

export function VolumeControl({ compact = false, onError }: Props) {
  const {
    connected,
    commandPending,
    target,
    volumeControlEnabled,
    renderingTelemetry,
  } = usePlaybackState();
  const { setVolume, setMuted } = usePlaybackActions();
  const [draftVolume, setDraftVolume] = useState<number | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const commitActive = useRef(false);
  const pointerActive = useRef(false);

  const confirmedVolume = renderingTelemetry?.volumePercent ?? null;
  const confirmedMuted = renderingTelemetry?.muted ?? null;
  const shownVolume = draftVolume ?? confirmedVolume;

  useEffect(() => {
    pointerActive.current = false;
    setDraftVolume(null);
  }, [target.host, target.port]);

  useEffect(() => {
    if (!pointerActive.current && !commitActive.current) setDraftVolume(null);
  }, [confirmedVolume]);

  if (!volumeControlEnabled) return null;

  async function commitVolume(value: number) {
    const level = Math.min(100, Math.max(0, Math.round(value)));
    if (
      commitActive.current
      || commandPending
      || !connected
      || confirmedVolume === null
    ) return;
    setDraftVolume(level);
    if (level === Math.round(confirmedVolume)) {
      setDraftVolume(null);
      return;
    }
    commitActive.current = true;
    setAdjusting(true);
    onError?.("");
    try {
      await setVolume(level);
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : "Volume command failed.");
    } finally {
      commitActive.current = false;
      setAdjusting(false);
      setDraftVolume(null);
    }
  }

  async function commitMute() {
    if (
      commitActive.current
      || commandPending
      || !connected
      || confirmedMuted === null
    ) return;
    commitActive.current = true;
    onError?.("");
    try {
      await setMuted(!confirmedMuted);
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : "Mute command failed.");
    } finally {
      commitActive.current = false;
    }
  }

  const confirmedLabel = confirmedVolume === null
    ? "Waiting for the Olive's volume reading"
    : `${Math.round(confirmedVolume)}%${confirmedMuted ? ", muted" : ""}`;
  const sliderDisabled = !connected || commandPending || adjusting || confirmedVolume === null;
  return <div
    className={`volume-control ${compact ? "mini-volume" : "hero-volume"} ${confirmedVolume === null ? "" : "has-confirmed-volume"}`}
    role="group"
    aria-label={`Olive volume, ${confirmedLabel}`}
  >
    <button
      className={`volume-mute ${confirmedMuted ? "muted" : ""}`}
      disabled={!connected || commandPending || confirmedMuted === null}
      onClick={() => void commitMute()}
      aria-label={confirmedMuted === null ? "Mute state unavailable" : confirmedMuted ? "Unmute Olive" : "Mute Olive"}
      aria-pressed={confirmedMuted === null ? undefined : confirmedMuted}
    >
      <Icon name="speaker" />
    </button>
    <input
      className="volume-slider"
      type="range"
      min="0"
      max="100"
      step="1"
      value={shownVolume ?? 0}
      disabled={sliderDisabled}
      onInput={(event) => setDraftVolume(Number(event.currentTarget.value))}
      onChange={(event) => {
        const level = Number(event.currentTarget.value);
        setDraftVolume(level);
        if (!pointerActive.current) void commitVolume(level);
      }}
      onPointerDown={() => { pointerActive.current = true; }}
      onPointerUp={(event) => {
        pointerActive.current = false;
        void commitVolume(Number(event.currentTarget.value));
      }}
      onPointerCancel={() => {
        pointerActive.current = false;
        setDraftVolume(null);
      }}
      aria-label="Olive volume"
      aria-valuetext={shownVolume === null ? "Volume reading unavailable" : `${Math.round(shownVolume)} percent`}
      title={confirmedLabel}
      style={{
        "--volume-fill-start": "0%",
        "--volume-fill-end": `${shownVolume ?? 0}%`,
      } as CSSProperties}
    />
    <output className="volume-reading" aria-live="polite">
      {shownVolume === null ? "—" : `${Math.round(shownVolume)}%`}
    </output>
  </div>;
}
