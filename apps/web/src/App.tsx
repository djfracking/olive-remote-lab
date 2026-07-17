import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseResponseBody,
  type EndpointProbe,
  type HttpMethod,
  type OliveModelCapabilities,
  type TransportResponse,
} from "@olive-remote-lab/olive-client";
import { LibraryView } from "./components/LibraryView";
import { NowPlayingView } from "./components/NowPlayingView";
import { SearchView } from "./components/SearchView";
import { PlaylistsView } from "./components/PlaylistsView";
import { SettingsView } from "./components/SettingsView";
import { AddMusicView } from "./components/AddMusicView";
import { MiniPlayer } from "./components/MiniPlayer";
import { useI18n } from "./i18n";
import { appFetch } from "./nativeApi";

type Section = "Home" | "Library" | "Search" | "Playlists" | "Add Music" | "Lab" | "Settings";
interface Device { host: string; port: number }
interface Candidate { address: string; port: number; name: string; model?: string; manufacturer?: string; source: string; confidence: string; evidence: string[]; services?: string[] }
interface DiscoveryResult { candidates: Candidate[]; subnet?: string; ssdpResponses: number }
interface HistoryItem { id: string; timestamp: string; method: HttpMethod; path: string; status?: number; durationMs?: number }

const DEVICE_KEY = "remote-lab-confirmed-device";
const HISTORY_KEY = "remote-lab-request-history";
const sections: Section[] = ["Home", "Library", "Search", "Playlists", "Add Music"];
const navIcons: Record<Section, string> = { Home: "▶", Library: "▦", Search: "⌕", Playlists: "≡", "Add Music": "+", Lab: "⌁", Settings: "⚙" };

function readStored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await appFetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

function parsePairs(value: string): Record<string, string> {
  return Object.fromEntries(value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const equals = line.indexOf("=");
    return equals < 0 ? [line, ""] : [line.slice(0, equals).trim(), line.slice(equals + 1).trim()];
  }));
}

export function App() {
  const { t } = useI18n();
  const initialDevice = readStored<Device>(DEVICE_KEY, { host: "", port: 80 });
  const [section, setSection] = useState<Section>("Home");
  const [host, setHost] = useState(initialDevice.host);
  const [port, setPort] = useState(initialDevice.port);
  const [connected, setConnected] = useState(Boolean(initialDevice.host));
  const [modelProfile, setModelProfile] = useState<OliveModelCapabilities | null>(null);
  const [status, setStatus] = useState(initialDevice.host ? "Saved device loaded" : "No device selected");
  const [probes, setProbes] = useState<EndpointProbe[]>([]);
  const [probing, setProbing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [path, setPath] = useState("/");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState("");
  const [headers, setHeaders] = useState("");
  const [result, setResult] = useState<TransportResponse | null>(null);
  const [requestError, setRequestError] = useState("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => readStored<HistoryItem[]>(HISTORY_KEY, []));
  const automaticAttempted = useRef(false);

  const target = useMemo(() => ({ host: host.trim(), port: Number(port) }), [host, port]);

  useEffect(() => localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 40))), [history]);

  useEffect(() => {
    if (automaticAttempted.current) return;
    automaticAttempted.current = true;
    void autoConnect();
  }, []);

  useEffect(() => {
    if (connected || discovering || !target.host) return;
    const retry = window.setInterval(() => {
      void identifyDevice({ host: target.host, port: target.port });
    }, 10_000);
    return () => window.clearInterval(retry);
  }, [connected, discovering, target.host, target.port]);

  async function autoConnect() {
    const savedDevice = initialDevice.host && ![80, 8163].includes(initialDevice.port)
      ? { ...initialDevice, port: 80 }
      : initialDevice;
    if (savedDevice.host && await identifyDevice(savedDevice)) return;
    await findDevice(true);
  }

  async function identifyDevice(device: Device): Promise<boolean> {
    try {
      const profile = await api<OliveModelCapabilities>("/api/device/identify", { method: "POST", body: JSON.stringify(device) });
      setHost(device.host); setPort(device.port); setConnected(true); setModelProfile(profile); setStatus(`${profile.displayName} ${t("connected").toLowerCase()} · ${device.host}`);
      localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
      return true;
    } catch {
      setConnected(false); setModelProfile(null); setStatus(`Could not reach ${device.host}; looking for a server…`);
      return false;
    }
  }

  function confirmDevice(device = target) {
    if (!device.host || device.port < 1 || device.port > 65535) { setStatus("Enter a valid local IP and port."); return; }
    setHost(device.host); setPort(device.port); setConnected(true);
    localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    setStatus(`Identifying ${device.host}:${device.port}…`);
    void identifyDevice(device);
  }

  async function runProbe() {
    confirmDevice(); setProbing(true); setStatus("Testing six known web surfaces…");
    try {
      const data = await api<EndpointProbe[]>("/api/probe", { method: "POST", body: JSON.stringify(target) });
      setProbes(data);
      const reachable = data.filter((item) => item.status > 0).length;
      setStatus(reachable ? `${reachable} of 6 endpoints responded` : "Device is offline or did not respond");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Endpoint test failed"); }
    finally { setProbing(false); }
  }

  async function findDevice(autoSelect = false) {
    setDiscovering(true); setDiscovery(null); setStatus("Searching SSDP, then the active private /24 if needed…");
    try {
      const data = await api<DiscoveryResult>("/api/discover", { method: "POST", body: "{}" });
      setDiscovery(data);
      if (autoSelect && data.candidates[0]) {
        const candidate = data.candidates[0];
        confirmDevice({ host: candidate.address, port: candidate.port });
      } else {
        setStatus(data.candidates.length ? `Found ${data.candidates.length} candidate${data.candidates.length === 1 ? "" : "s"}` : "No candidate found. Manual entry remains available.");
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : "Discovery failed"); }
    finally { setDiscovering(false); }
  }

  async function sendRequest() {
    if (!connected) confirmDevice();
    setSending(true); setRequestError(""); setResult(null);
    try {
      const data = await api<TransportResponse>("/api/request", { method: "POST", body: JSON.stringify({ target, method, path, query: parsePairs(query), form: parsePairs(form), headers: parsePairs(headers) }) });
      setResult(data);
      setHistory((items) => [{ id: crypto.randomUUID(), timestamp: new Date().toISOString(), method, path, status: data.status, durationMs: data.durationMs }, ...items].slice(0, 40));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      setRequestError(message); setHistory((items) => [{ id: crypto.randomUUID(), timestamp: new Date().toISOString(), method, path }, ...items].slice(0, 40));
    } finally { setSending(false); }
  }

  async function exportDiagnostics() {
    const response = await appFetch("/api/logs/export");
    if (!response.ok) { setStatus("Could not export diagnostics."); return; }
    const blob = await response.blob();
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
    link.download = `olive-remote-lab-diagnostics-${Date.now()}.json`; link.click(); URL.revokeObjectURL(link.href);
    setStatus("Redacted diagnostics exported.");
  }

  const parsed = result ? parseResponseBody(result.body, result.headers["content-type"] ?? "") : null;
  const sectionLabel: Record<Section, string> = { Home: t("home"), Library: t("library"), Search: t("search"), Playlists: t("playlists"), "Add Music": t("addMusic"), Lab: t("lab"), Settings: t("settings") };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">RL</span><div><strong>Olive Remote Lab</strong><small>Simple local remote</small></div></div>
      <nav>{sections.map((item) => <button className={section === item ? "active" : ""} onClick={() => setSection(item)} key={item}><span>{navIcons[item]}</span>{sectionLabel[item]}</button>)}</nav>
      <button className={`settings-link ${section === "Settings" ? "active" : ""}`} onClick={() => setSection("Settings")} aria-label={t("settings")}>⚙ <span>{t("settings")}</span></button>
      <div className="privacy-note"><span className="privacy-dot" />{t("localOnly")}<small>{modelProfile?.displayName ?? "No model confirmed"} · {t("noCloud")}</small></div>
    </aside>

    <main>
      <header><div><p className="eyebrow">OLIVE REMOTE LAB</p><h1>{sectionLabel[section]}</h1></div><div className={`connection-pill ${connected ? "online" : ""}`}><i />{status}</div></header>

      {section === "Home" ? <NowPlayingView connected={connected} target={target} onStatus={setStatus} />
        : section === "Library" ? <LibraryView connected={connected} target={target} onStatus={setStatus} />
        : section === "Search" ? <SearchView connected={connected} target={target} onStatus={setStatus} />
        : section === "Playlists" ? <PlaylistsView connected={connected} target={target} onStatus={setStatus} />
        : section === "Add Music" ? <AddMusicView connected={connected} target={target} />
        : section === "Settings" ? <SettingsView target={target} model={modelProfile} onOpenLab={() => setSection("Lab")} />
        : section !== "Lab" ? null : <>
        <section className="connection-grid">
          <div className="card connection-card">
            <div className="section-heading"><div><span className="step">01</span><h2>Connect a device</h2></div><span className="tag">MANUAL</span></div>
            <p>Enter the server’s private LAN address. It never leaves this computer.</p>
            <div className="address-row"><label><span>IP address or .local name</span><input value={host} onChange={(event) => { setHost(event.target.value); setConnected(false); }} placeholder="192.168.1.42" /></label><label className="port"><span>Port</span><input type="number" min="1" max="65535" value={port} onChange={(event) => setPort(Number(event.target.value))} /></label><button onClick={() => confirmDevice()} disabled={!host}>Connect</button></div>
          </div>
          <div className="card discovery-card">
            <div className="section-heading"><div><span className="step">AUTO</span><h2>Find my Olive</h2></div><span className="tag experimental">DISCOVERY</span></div>
            <p>Checks UPnP first. If empty, scans only this machine’s private /24 on ports 80 and 8163.</p>
            <button onClick={() => void findDevice(false)} disabled={discovering} className="discover-button">{discovering ? <span className="spinner" /> : "⌁"}{discovering ? "Searching local network…" : "Find my Olive"}</button>
          </div>
        </section>

        {discovery && <section className="card results-card"><div className="section-heading"><div><span className="step">FOUND</span><h2>Discovery candidates</h2></div><span className="tag">{discovery.ssdpResponses} SSDP RESPONSES{discovery.subnet ? ` · ${discovery.subnet}` : ""}</span></div>
          {discovery.candidates.length === 0 ? <div className="empty">No matching device was identified. Check that the server is awake, then use manual IP entry.</div> : <div className="candidate-list">{discovery.candidates.map((candidate) => <article key={`${candidate.address}:${candidate.port}`}><div><strong>{candidate.name}</strong><code>{candidate.address}:{candidate.port}</code><small>{candidate.manufacturer} {candidate.model} · {candidate.source} · {candidate.confidence} confidence</small><ul>{candidate.evidence.map((item) => <li key={item}>{item}</li>)}</ul></div><button onClick={() => confirmDevice({ host: candidate.address, port: candidate.port })}>Use device</button></article>)}</div>}
        </section>}

        <section className="card results-card">
          <div className="section-heading"><div><span className="step">02</span><h2>Endpoint tester</h2></div><button onClick={runProbe} disabled={probing || !host} className="secondary">{probing ? "Testing…" : "Test known paths"}</button></div>
          {!probes.length ? <div className="empty">Connect a device, then test the six requested HTTP surfaces.</div> : <div className="table-wrap"><table><thead><tr><th>URL</th><th>Status</th><th>Type</th><th>Time</th><th>Response preview / error</th></tr></thead><tbody>{probes.map((probe, index) => <tr key={`${probe.url}-${index}`}><td><code>{probe.url}</code></td><td><span className={`status-code ${probe.status > 0 && probe.status < 500 ? "good" : "bad"}`}>{probe.status || "ERR"}</span></td><td>{probe.contentType}</td><td>{probe.durationMs ? `${probe.durationMs} ms` : "—"}</td><td><pre>{probe.error ?? probe.preview ?? "Empty response"}</pre></td></tr>)}</tbody></table></div>}
        </section>

        <section className="card request-card">
          <div className="section-heading"><div><span className="step">03</span><h2>Request explorer</h2></div><span className="tag experimental">EXPERIMENTAL · USER-SPECIFIED</span></div>
          <div className="request-line"><select value={method} onChange={(event) => setMethod(event.target.value as HttpMethod)}><option>GET</option><option>POST</option></select><div className="url-prefix">http://{host || "device"}:{port}</div><input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/path" /><button onClick={sendRequest} disabled={sending || !host}>{sending ? "Sending…" : "Send request"}</button></div>
          <div className="field-grid"><label><span>Query parameters <em>one key=value per line</em></span><textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder={"cmd=status\nzone=1"} /></label><label><span>Form fields <em>POST only</em></span><textarea value={form} onChange={(event) => setForm(event.target.value)} placeholder={"key=value"} /></label><label><span>Request headers</span><textarea value={headers} onChange={(event) => setHeaders(event.target.value)} placeholder={"Accept=application/json"} /></label></div>
          {requestError && <div className="error-box">{requestError}</div>}
          {result && <div className="response-panel"><div className="response-meta"><strong>{result.status} {result.statusText}</strong><span>{result.durationMs} ms</span><span>{parsed?.kind.toUpperCase()}</span></div><details><summary>Response headers</summary><pre>{JSON.stringify(result.headers, null, 2)}</pre></details><pre className="response-body">{parsed?.formatted}</pre></div>}
        </section>

        <section className="bottom-grid"><div className="card history-card"><div className="section-heading"><div><span className="step">04</span><h2>Local request history</h2></div><button className="text-button" onClick={() => setHistory([])}>Clear</button></div>{history.length ? history.map((item) => <button key={item.id} className="history-item" onClick={() => { setMethod(item.method); setPath(item.path); }}><code>{item.method}</code><span>{item.path}</span><small>{item.status ?? "ERR"} · {item.durationMs ?? "—"} ms</small></button>) : <div className="empty compact">Requests made here will appear locally.</div>}</div>
          <div className="card log-card"><div className="section-heading"><div><span className="step">05</span><h2>Protocol logging</h2></div><span className="tag">REDACTED EXPORT</span></div><p>The proxy records request timing, status, errors, and short response previews for this session. Export removes likely names, library metadata, and email addresses.</p><button onClick={exportDiagnostics} className="secondary">Export diagnostics JSON</button></div></section>
      </>}
      <footer>Olive Remote Lab · Local diagnostic software · No data leaves your network</footer>
    </main>
    <MiniPlayer connected={connected} enabled={section !== "Home"} target={target} onOpen={() => setSection("Home")} onStatus={setStatus} />
  </div>;
}
