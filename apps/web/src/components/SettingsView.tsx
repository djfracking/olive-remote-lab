import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { useI18n, type Locale } from "../i18n";

export interface SavedOlive extends OliveDeviceTarget { name: string }

function key(device: OliveDeviceTarget): string { return `${device.host}:${device.port}`; }

export function SettingsView({ target, savedDevices, connected, onSelect, onOpenLab }: { target: OliveDeviceTarget; savedDevices: SavedOlive[]; connected: boolean; onSelect: (key: string) => void; onOpenLab: () => void }) {
  const { locale, setLocale } = useI18n();
  return <section className="module-stack">
    <div className="settings-grid">
      <div className="card preference-card server-preference"><h2>Music servers</h2>{savedDevices.length ? <div className="saved-server-list">{savedDevices.map((device) => { const active = key(device) === key(target); return <button className={active ? "active" : ""} onClick={() => onSelect(key(device))} key={key(device)}><span><strong>{device.name}</strong><small>{device.host}</small></span><b>{active ? connected ? "Active" : "Selected" : "Use"}</b></button>; })}</div> : <><strong className="setting-value">No Olive connected</strong><small>Make sure your Olive and this device are connected to the same home network.</small></>}<button className="secondary add-server" onClick={onOpenLab}>{savedDevices.length ? "Find another Olive" : "Find My Olive"}</button></div>
      <div className="card preference-card"><h2>Language</h2><select value={locale} onChange={(event) => setLocale(event.target.value as Locale)} aria-label="Interface language"><option value="en">English</option><option value="fr">Français</option><option value="de">Deutsch</option><option value="es">Español</option></select></div>
    </div>
    <details className="card advanced-settings"><summary>Connection troubleshooting</summary><p>Reconnect your Olive, enter its address manually, or open advanced diagnostic tools.</p><button className="secondary" onClick={onOpenLab}>Open connection help</button></details>
  </section>;
}
