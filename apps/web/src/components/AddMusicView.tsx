import { useState } from "react";
import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { isDemoTarget } from "../demoOlive";

export function AddMusicView({ connected, target }: { connected: boolean; target: OliveDeviceTarget }) {
  const [copied, setCopied] = useState(false);
  const macAddress = `smb://${target.host || "OLIVE-IP"}`;
  const windowsAddress = `\\\\${target.host || "OLIVE-IP"}`;

  async function copy(value: string) {
    await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  }

  if (isDemoTarget(target)) return <section className="card module-empty"><h2>Demo library</h2><p>Demo Mode uses fictional music stored inside the app. Connect a real Olive to see local import instructions.</p></section>;

  return <section className="module-stack">
    <div className="card add-music-intro"><p>Copy music into your Olive’s <strong>Import</strong> folder. Choose the device you are using:</p></div>
    <div className="import-grid">
      <article className="card"><span className="platform-mark">⌘</span><h3>Mac</h3><p>Finder → Go → Connect to Server, then enter:</p><button className="copy-address" onClick={() => void copy(macAddress)} disabled={!connected}><code>{macAddress}</code><span>{copied ? "Copied" : "Copy"}</span></button><small>Open the Import folder and drag in FLAC, WAV, MP3 or AAC files.</small></article>
      <article className="card"><span className="platform-mark">⊞</span><h3>Windows</h3><p>Press Windows + R, then enter:</p><button className="copy-address" onClick={() => void copy(windowsAddress)} disabled={!connected}><code>{windowsAddress}</code><span>{copied ? "Copied" : "Copy"}</span></button><small>Open the Import folder and copy your music into it.</small></article>
      <article className="card"><span className="platform-mark">▣</span><h3>iPad or iPhone</h3><p>Files → Browse → ··· → Connect to Server.</p><button className="copy-address" onClick={() => void copy(target.host)} disabled={!connected}><code>{target.host || "OLIVE-IP"}</code><span>{copied ? "Copied" : "Copy"}</span></button><small>If the legacy SMB share is not accepted by iPadOS, use a Mac or PC for the transfer.</small></article>
    </div>
  </section>;
}
