import { useState } from "react";
import { APP_VERSION } from "../version";
import { deviceSelectionKey, type StableOliveTarget } from "../deviceIdentity";

export interface SavedOlive extends StableOliveTarget { name: string }
export type OliveAvailability = "online" | "offline" | "checking" | "unknown";

function key(device: StableOliveTarget): string { return deviceSelectionKey(device); }

interface SettingsViewProps {
  target: StableOliveTarget;
  savedDevices: SavedOlive[];
  connected: boolean;
  availability: Record<string, OliveAvailability>;
  onSelect: (key: string) => void;
  onRename: (key: string, name: string) => void;
  onForget: (key: string) => void;
  onOpenLab: () => void;
  onExportDiagnostics: () => Promise<void>;
}

export function SettingsView({ target, savedDevices, connected, availability, onSelect, onRename, onForget, onOpenLab, onExportDiagnostics }: SettingsViewProps) {
  const [editingKey, setEditingKey] = useState("");
  const [draftName, setDraftName] = useState("");

  function forget(device: SavedOlive) {
    if (window.confirm(`Forget ${device.name}? You can find it again later.`)) onForget(key(device));
  }

  function startRename(device: SavedOlive) {
    setEditingKey(key(device));
    setDraftName(device.name);
  }

  function saveRename() {
    if (!draftName.trim()) return;
    onRename(editingKey, draftName);
    setEditingKey("");
  }

  return <section className="module-stack">
    <div className="settings-grid">
      <div className="card preference-card server-preference"><h2>Music servers</h2>{savedDevices.length ? <div className="saved-server-list">{savedDevices.map((device) => { const deviceKey = key(device); const active = deviceKey === key(target); const state = availability[deviceKey] ?? "unknown"; const statusLabel = state === "online" ? "Online" : state === "offline" ? "Offline" : state === "checking" ? "Checking…" : "Not checked"; return <div className={`saved-server-row ${active ? "active" : ""}`} key={deviceKey}>{editingKey === deviceKey ? <form className="saved-server-rename" onSubmit={(event) => { event.preventDefault(); saveRename(); }}><label><span className="sr-only">Olive name</span><input autoFocus maxLength={50} value={draftName} onChange={(event) => setDraftName(event.target.value)} /></label><button type="submit" disabled={!draftName.trim()}>Save</button><button type="button" onClick={() => setEditingKey("")}>Cancel</button></form> : <><button className="saved-server-select" onClick={() => onSelect(deviceKey)}><span><strong>{device.name}</strong><small>{device.host}</small></span><b className={`server-status ${state}`}>{statusLabel}{active && connected ? " · Active" : ""}</b></button><button className="rename-server" onClick={() => startRename(device)} aria-label={`Rename ${device.name}`}>Rename</button><button className="forget-server" onClick={() => forget(device)} aria-label={`Forget ${device.name}`}>Forget</button></>}</div>; })}</div> : <><strong className="setting-value">No Olive connected</strong><small>Make sure your Olive and this device are connected to the same home network.</small></>}<button className="secondary add-server" onClick={onOpenLab}>{savedDevices.length ? "Find another Olive" : "Find My Olive"}</button></div>
      <div className="card preference-card about-card"><h2>About &amp; support</h2><strong className="setting-value">Olive Remote {APP_VERSION}</strong><small>Independent software for compatible legacy music servers.</small><div className="support-links"><a href="https://olive-remote-lab.web.app/support" target="_blank" rel="noreferrer">Support</a><a href="https://olive-remote-lab.web.app/privacy" target="_blank" rel="noreferrer">Privacy policy</a><a href="https://github.com/djfracking/olive-remote-lab/issues" target="_blank" rel="noreferrer">Report a problem</a></div><button className="secondary" onClick={() => void onExportDiagnostics()}>Export redacted diagnostics</button></div>
    </div>
    <details className="card advanced-settings"><summary>Connection troubleshooting</summary><p>Reconnect your Olive, find another server, or enter its local address manually.</p><button className="secondary" onClick={onOpenLab}>Open connection help</button></details>
  </section>;
}
