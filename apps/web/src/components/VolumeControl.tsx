import { Icon } from "./Icons";
import { usePlaybackActions, usePlaybackState } from "../playback/PlaybackProvider";

interface Props {
  compact?: boolean;
  onError?: (message: string) => void;
}

export function VolumeControl({ compact = false, onError }: Props) {
  const { connected, commandPending, volumeControlEnabled } = usePlaybackState();
  const { volume } = usePlaybackActions();
  if (!volumeControlEnabled) return null;

  async function run(action: "volumeDown" | "mute" | "volumeUp") {
    onError?.("");
    try { await volume(action); }
    catch (reason) { onError?.(reason instanceof Error ? reason.message : "Volume command failed."); }
  }

  return <div className={`volume-control ${compact ? "mini-volume" : "hero-volume"}`} aria-label="Olive volume controls">
    {!compact && <span>Volume</span>}
    <button disabled={!connected || commandPending} onClick={() => void run("volumeDown")} aria-label="Volume down">−</button>
    <button className="volume-mute" disabled={!connected || commandPending} onClick={() => void run("mute")} aria-label="Mute or unmute"><Icon name="speaker" /></button>
    <button disabled={!connected || commandPending} onClick={() => void run("volumeUp")} aria-label="Volume up">+</button>
  </div>;
}
