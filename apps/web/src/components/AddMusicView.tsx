import { useState } from "react";
import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";

export function AddMusicView({ connected, target }: { connected: boolean; target: OliveDeviceTarget }) {
  const [copied, setCopied] = useState(false);
  const macAddress = `smb://${target.host || "OLIVE-IP"}`;
  const windowsAddress = `\\\\${target.host || "OLIVE-IP"}`;

  async function copy(value: string) {
    await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1800);
  }

  return <section className="module-stack">
    <div className="card add-music-hero"><span className="step">LOCAL IMPORT</span><h2>Add music to your server</h2><p>The verified Olive workflow uses the server’s network <strong>Import</strong> folder. Files stay on your LAN and the server indexes them automatically.</p>{!connected && <div className="error-box">Connect an Olive first so the correct network address can be shown.</div>}</div>
    <div className="import-grid">
      <article className="card"><span className="platform-mark">⌘</span><h3>Mac</h3><p>Finder → Go → Connect to Server, then enter:</p><button className="copy-address" onClick={() => void copy(macAddress)} disabled={!connected}><code>{macAddress}</code><span>{copied ? "Copied" : "Copy"}</span></button><small>Open the Import folder and drag in FLAC, WAV, MP3 or AAC files.</small></article>
      <article className="card"><span className="platform-mark">⊞</span><h3>Windows</h3><p>Press Windows + R, then enter:</p><button className="copy-address" onClick={() => void copy(windowsAddress)} disabled={!connected}><code>{windowsAddress}</code><span>{copied ? "Copied" : "Copy"}</span></button><small>Open the Import folder and copy your music into it.</small></article>
      <article className="card"><span className="platform-mark">▣</span><h3>iPad or iPhone</h3><p>Files → Browse → ··· → Connect to Server.</p><button className="copy-address" onClick={() => void copy(target.host)} disabled={!connected}><code>{target.host || "OLIVE-IP"}</code><span>{copied ? "Copied" : "Copy"}</span></button><small>If the legacy SMB share is not accepted by iPadOS, use a Mac or PC for the transfer.</small></article>
    </div>
    <div className="card import-note"><span className="evidence-badge shared-firmware-marker">MODEL DEPENDENT</span><p>Browser upload is intentionally unavailable. The older servers import through SMB or USB, and share compatibility must be checked on each firmware family.</p></div>
  </section>;
}
