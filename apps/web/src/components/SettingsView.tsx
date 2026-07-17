import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { APP_VERSION } from "../version";

export interface SavedOlive extends OliveDeviceTarget { name: string }

function key(device: OliveDeviceTarget): string { return `${device.host}:${device.port}`; }

interface SettingsViewProps {
  target: OliveDeviceTarget;
  savedDevices: SavedOlive[];
  connected: boolean;
  onSelect: (key: string) => void;
  onForget: (key: string) => void;
  onOpenLab: () => void;
  onExportDiagnostics: () => Promise<void>;
}

export function SettingsView({ target, savedDevices, connected, onSelect, onForget, onOpenLab, onExportDiagnostics }: SettingsViewProps) {
  function forget(device: SavedOlive) {
    if (window.confirm(`Forget ${device.name}? You can find it again later.`)) onForget(key(device));
  }

  return <section className="module-stack">
    <div className="settings-grid">
      <div className="card preference-card server-preference"><h2>Music servers</h2>{savedDevices.length ? <div className="saved-server-list">{savedDevices.map((device) => { const active = key(device) === key(target); return <div className={`saved-server-row ${active ? "active" : ""}`} key={key(device)}><button className="saved-server-select" onClick={() => onSelect(key(device))}><span><strong>{device.name}</strong><small>{device.host}</small></span><b>{active ? connected ? "Active" : "Selected" : "Use"}</b></button><button className="forget-server" onClick={() => forget(device)} aria-label={`Forget ${device.name}`}>Forget</button></div>; })}</div> : <><strong className="setting-value">No Olive connected</strong><small>Make sure your Olive and this device are connected to the same home network.</small></>}<button className="secondary add-server" onClick={onOpenLab}>{savedDevices.length ? "Find another Olive" : "Find My Olive"}</button></div>
      <div className="card preference-card about-card"><h2>About &amp; support</h2><strong className="setting-value">Olive Remote {APP_VERSION}</strong><small>Independent software for compatible legacy music servers.</small><div className="support-links"><a href="https://olive-remote-lab.web.app/support" target="_blank" rel="noreferrer">Support</a><a href="https://olive-remote-lab.web.app/privacy" target="_blank" rel="noreferrer">Privacy policy</a><a href="https://github.com/djfracking/olive-remote-lab/issues" target="_blank" rel="noreferrer">Report a problem</a></div><button className="secondary" onClick={() => void onExportDiagnostics()}>Export redacted diagnostics</button></div>
    </div>
    <details className="card advanced-settings"><summary>Connection troubleshooting</summary><p>Reconnect your Olive, find another server, or enter its local address manually.</p><button className="secondary" onClick={onOpenLab}>Open connection help</button></details>
  </section>;
}
