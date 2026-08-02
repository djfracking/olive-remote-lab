import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { SettingsView, type OliveAvailability, type SavedOlive } from "./components/SettingsView";
import { AddMusicView } from "./components/AddMusicView";
import { MiniPlayer } from "./components/MiniPlayer";
import { Icon } from "./components/Icons";
import { useI18n } from "./i18n";
import { appFetch, getLocalNetworkStatus, isNativeAndroid, isNativeApp, openLocalNetworkSettings, type LocalNetworkStatus } from "./nativeApi";
import { DEMO_TARGET, isDemoTarget } from "./demoOlive";
import { adoptDeviceCacheIdentity, clearDeviceCache } from "./deviceCache";
import {
  deviceRequestKey,
  deviceSelectionKey,
  devicesReferToSameOlive,
  mergeStableOliveTarget,
  upsertSavedDevice,
  withCanonicalDeviceIdentity,
  type StableOliveTarget,
} from "./deviceIdentity";
import { adoptDeviceLocalStorage } from "./deviceStorageMigration";
import { PlaybackProvider } from "./playback/PlaybackProvider";
import { LibraryCatalogSync } from "./components/LibraryCatalogSync";

type Section = "Home" | "Library" | "Search" | "Playlists" | "Add Music" | "Lab" | "Settings";
interface Device extends StableOliveTarget {}
interface Candidate {
  address: string;
  port: number;
  name: string;
  deviceId?: string;
  udn?: string;
  usn?: string;
  model?: string;
  manufacturer?: string;
  description?: string;
  descriptionUrl?: string;
  descriptionUrls?: string[];
  source: string;
  confidence: string;
  evidence: string[];
  services?: StableOliveTarget["services"];
  serviceTypes?: string[];
  approvedServiceDeviceIds?: string[];
}
interface DiscoveryResult { candidates: Candidate[]; subnet?: string; ssdpResponses: number }
interface HistoryItem { id: string; timestamp: string; method: HttpMethod; path: string; status?: number; durationMs?: number }

const DEVICE_KEY = "remote-lab-confirmed-device";
const DEVICES_KEY = "olive-remote-saved-devices";
const HISTORY_KEY = "remote-lab-request-history";
const sections = ["Home", "Library", "Search", "Playlists", "Add Music", "Settings"] as const satisfies readonly Section[];
const navIcons = { Home: "home", Library: "library", Search: "search", Playlists: "playlists", "Add Music": "add", Settings: "settings" } as const;

function readStored<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}

function storedDevice(value: unknown): Device | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const host = typeof record.host === "string" ? record.host.trim() : "";
  const port = Number(record.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const stringField = (key: string) => typeof record[key] === "string" && record[key] ? String(record[key]) : undefined;
  const stringsField = (key: string) => Array.isArray(record[key])
    ? (record[key] as unknown[]).filter((entry): entry is string => typeof entry === "string" && Boolean(entry))
    : undefined;
  const services = Array.isArray(record.services)
    ? record.services.filter((entry) =>
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as Record<string, unknown>).serviceType === "string") as unknown as StableOliveTarget["services"]
    : undefined;
  const deviceId = stringField("deviceId");
  const udn = stringField("udn");
  const usn = stringField("usn");
  const descriptionUrl = stringField("descriptionUrl");
  const descriptionUrls = stringsField("descriptionUrls");
  const serviceTypes = stringsField("serviceTypes");
  const approvedServiceDeviceIds = stringsField("approvedServiceDeviceIds");
  return {
    host,
    port,
    ...(deviceId ? { deviceId } : {}),
    ...(udn ? { udn } : {}),
    ...(usn ? { usn } : {}),
    ...(descriptionUrl ? { descriptionUrl } : {}),
    ...(descriptionUrls?.length ? { descriptionUrls } : {}),
    ...(services?.length ? { services } : {}),
    ...(serviceTypes?.length ? { serviceTypes } : {}),
    ...(approvedServiceDeviceIds?.length ? { approvedServiceDeviceIds } : {}),
  };
}

function storedSavedDevices(): SavedOlive[] {
  const raw = readStored<unknown>(DEVICES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const device = storedDevice(entry);
    if (!device) return [];
    const name = typeof (entry as Record<string, unknown>).name === "string"
      ? String((entry as Record<string, unknown>).name).trim()
      : "";
    return [{ ...device, name: name || `Olive · ${deviceSuffix(device.host)}` }];
  });
}

function deviceKey(device: StableOliveTarget): string { return deviceSelectionKey(device); }

function candidateDevice(candidate: Candidate): Device {
  const descriptionUrl = candidate.descriptionUrl ?? candidate.description;
  return withCanonicalDeviceIdentity({
    host: candidate.address,
    port: candidate.port,
    ...(candidate.deviceId ? { deviceId: candidate.deviceId } : {}),
    ...(candidate.udn ? { udn: candidate.udn } : {}),
    ...(candidate.usn ? { usn: candidate.usn } : {}),
    ...(descriptionUrl ? { descriptionUrl } : {}),
    ...(candidate.descriptionUrls?.length ? { descriptionUrls: candidate.descriptionUrls } : {}),
    ...(candidate.services?.length ? { services: candidate.services } : {}),
    ...(candidate.serviceTypes?.length ? { serviceTypes: candidate.serviceTypes } : {}),
    ...(candidate.approvedServiceDeviceIds?.length ? { approvedServiceDeviceIds: candidate.approvedServiceDeviceIds } : {}),
  });
}

function deviceSuffix(host: string): string {
  const parts = host.split(".");
  return parts.length === 4 ? parts[3] ?? host : host;
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
  const initialDevice = storedDevice(readStored<unknown>(DEVICE_KEY, null)) ?? { host: "", port: 80 };
  const initialSavedDevices = storedSavedDevices();
  const [section, setSection] = useState<Section>(initialDevice.host || initialSavedDevices.length ? "Home" : "Lab");
  const [host, setHost] = useState(initialDevice.host);
  const [port, setPort] = useState(initialDevice.port);
  const [deviceDetails, setDeviceDetails] = useState<Device>(initialDevice);
  const [connected, setConnected] = useState(false);
  const [connectingKey, setConnectingKey] = useState("");
  const [deviceAvailability, setDeviceAvailability] = useState<Record<string, OliveAvailability>>({});
  const [modelProfile, setModelProfile] = useState<OliveModelCapabilities | null>(null);
  const [savedDevices, setSavedDevices] = useState<SavedOlive[]>(() => {
    if (initialSavedDevices.length) return initialSavedDevices;
    return initialDevice.host ? [{ ...initialDevice, name: `Olive · ${deviceSuffix(initialDevice.host)}` }] : [];
  });
  const [status, setStatus] = useState(initialDevice.host ? "Connecting…" : "Not connected");
  const [probes, setProbes] = useState<EndpointProbe[]>([]);
  const [probing, setProbing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [networkState, setNetworkState] = useState<LocalNetworkStatus | null>(null);
  const [searchAttempted, setSearchAttempted] = useState(false);
  const [connectionProblem, setConnectionProblem] = useState("");
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [path, setPath] = useState("/");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState("");
  const [headers, setHeaders] = useState("");
  const [result, setResult] = useState<TransportResponse | null>(null);
  const [requestError, setRequestError] = useState("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => readStored<HistoryItem[]>(HISTORY_KEY, []));
  const [sectionHistoryDepth, setSectionHistoryDepth] = useState(0);
  const [hasContentBack, setHasContentBack] = useState(false);
  const automaticAttempted = useRef(false);
  const identifyAttempt = useRef(0);
  const identifyRequestKey = useRef("");
  const endpointReconciliationActive = useRef(false);
  const lastNetworkAddress = useRef("");
  const sectionHistory = useRef<Section[]>([]);
  const contentBackHandler = useRef<(() => void) | null>(null);

  const target = useMemo<Device>(() => ({
    ...deviceDetails,
    host: host.trim(),
    port: Number(port),
  }), [deviceDetails, host, port]);
  const demoActive = isDemoTarget(target);

  function setCurrentDevice(device: Device): void {
    setHost(device.host);
    setPort(device.port);
    setDeviceDetails(device);
  }

  function clearCurrentDevice(): void {
    setHost("");
    setPort(80);
    setDeviceDetails({ host: "", port: 80 });
  }

  function invalidateIdentifyAttempts(): void {
    identifyAttempt.current += 1;
    identifyRequestKey.current = "";
    setConnectingKey("");
  }

  const registerContentBack = useCallback((handler: (() => void) | null) => {
    contentBackHandler.current = handler;
    setHasContentBack(Boolean(handler));
  }, []);

  const navigate = useCallback((next: Section) => {
    if (section === next) return;
    sectionHistory.current = [...sectionHistory.current, section].slice(-30);
    setSectionHistoryDepth(sectionHistory.current.length);
    setSection(next);
  }, [section]);

  const replaceSection = useCallback((next: Section) => {
    contentBackHandler.current = null;
    setHasContentBack(false);
    sectionHistory.current = [];
    setSectionHistoryDepth(0);
    setSection(next);
  }, []);

  const goBack = useCallback(() => {
    if (contentBackHandler.current) {
      contentBackHandler.current();
      return;
    }
    const previous = sectionHistory.current.pop();
    setSectionHistoryDepth(sectionHistory.current.length);
    if (previous) setSection(previous);
  }, []);

  const refreshLocalNetwork = useCallback(async () => {
    const incoming = await getLocalNetworkStatus();
    if (!incoming) return null;
    const previous = lastNetworkAddress.current;
    lastNetworkAddress.current = incoming.localAddress;
    setNetworkState(incoming);
    if (connected && !demoActive && previous && incoming.localAddress && previous !== incoming.localAddress) {
      invalidateIdentifyAttempts();
      setConnected(false);
      setConnectionProblem("Your network changed. Rejoin the Wi-Fi used by your Olive, then reconnect.");
      setDiscovery({ candidates: [], ssdpResponses: 0 });
      replaceSection("Lab");
      setStatus("Home network changed");
    }
    return incoming;
  }, [connected, demoActive, replaceSection]);

  useEffect(() => localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 40))), [history]);
  useEffect(() => localStorage.setItem(DEVICES_KEY, JSON.stringify(savedDevices)), [savedDevices]);

  useEffect(() => {
    if (automaticAttempted.current) return;
    automaticAttempted.current = true;
    if (!initialDevice.host && !savedDevices.length) return;
    void autoConnect();
  }, []);

  useEffect(() => {
    if (section !== "Lab" && !connected) return;
    void refreshLocalNetwork();
    const refresh = () => { if (document.visibilityState === "visible") void refreshLocalNetwork(); };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, [section, connected, refreshLocalNetwork]);

  useEffect(() => {
    if (connected || discovering || connectingKey || !target.host) return;
    const retry = window.setInterval(() => {
      void identifyDevice(target);
    }, 10_000);
    return () => window.clearInterval(retry);
  }, [connected, discovering, connectingKey, target]);

  useEffect(() => {
    if (!connected || demoActive || !target.host) return;
    let active = true;
    const reconcileEndpoint = async () => {
      if (endpointReconciliationActive.current) return;
      endpointReconciliationActive.current = true;
      try {
        const data = await api<DiscoveryResult>("/api/discover", { method: "POST", body: "{}" });
        if (!active) return;
        const match = data.candidates
          .map(candidateDevice)
          .find((candidate) => devicesReferToSameOlive(candidate, target));
        if (!match) return;
        const refreshed = withCanonicalDeviceIdentity(mergeStableOliveTarget(target, match));
        if (deviceRequestKey(refreshed) === deviceRequestKey(target)) return;
        setCurrentDevice(refreshed);
        localStorage.setItem(DEVICE_KEY, JSON.stringify(refreshed));
        setSavedDevices((items) => {
          const existing = items.find((item) => devicesReferToSameOlive(item, refreshed));
          return upsertSavedDevice(items, {
            ...refreshed,
            name: existing?.name ?? `Olive · ${deviceSuffix(refreshed.host)}`,
          });
        });
        setStatus(`Olive reconnected · ${refreshed.host}`);
      } catch {
        // Playback and catalog retries remain active while SSDP is temporarily
        // unavailable. The next visibility/interval pass tries again.
      } finally {
        endpointReconciliationActive.current = false;
      }
    };
    const interval = window.setInterval(() => void reconcileEndpoint(), 60_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void reconcileEndpoint();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
    };
  }, [
    connected,
    demoActive,
    deviceSelectionKey(target),
    deviceRequestKey(target),
  ]);

  async function autoConnect() {
    const savedDevice = initialDevice.host && ![80, 8163].includes(initialDevice.port)
      ? { ...initialDevice, port: 80 }
      : initialDevice;
    const choices = [savedDevice, ...savedDevices].filter((device, index, all) =>
      device.host && all.findIndex((candidate) => devicesReferToSameOlive(candidate, device)) === index);
    for (const device of choices) {
      const previousAttempt = identifyAttempt.current;
      if (await identifyDevice(device)) return;
      if (identifyAttempt.current !== previousAttempt + 1) return;
    }
    await findDevice(true);
  }

  async function enrichDeviceFromDiscovery(device: Device): Promise<Device> {
    if (isDemoTarget(device)) return device;
    try {
      const data = await api<DiscoveryResult>("/api/discover", { method: "POST", body: "{}" });
      const candidates = data.candidates.map(candidateDevice);
      const match = candidates.find((candidate) => devicesReferToSameOlive(candidate, device));
      if (match) return withCanonicalDeviceIdentity(mergeStableOliveTarget(device, match));
      const endpointReplacement = candidates.find((candidate) =>
        candidate.host.trim().toLowerCase() === device.host.trim().toLowerCase()
        && candidate.port === device.port);
      if (endpointReplacement?.deviceId && device.deviceId) {
        throw new Error("A different Olive is now using this saved network address. Choose it separately in Find My Olive.");
      }
      return device;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("A different Olive is now using")) throw error;
      return device;
    }
  }

  async function identifyDevice(device: Device, suggestedName?: string): Promise<boolean> {
    const attempt = identifyAttempt.current + 1;
    const requestKey = deviceRequestKey(device);
    identifyAttempt.current = attempt;
    identifyRequestKey.current = requestKey;
    const selectionKey = deviceKey(device);
    setConnectingKey(selectionKey);
    setDeviceAvailability((items) => ({ ...items, [selectionKey]: "checking" }));
    const isCurrentAttempt = () =>
      identifyAttempt.current === attempt
      && identifyRequestKey.current === requestKey;
    try {
      const profile = await api<OliveModelCapabilities>("/api/device/identify", { method: "POST", body: JSON.stringify(device) });
      if (!isCurrentAttempt()) return false;
      const identified = withCanonicalDeviceIdentity(await enrichDeviceFromDiscovery(device));
      if (!isCurrentAttempt()) return false;
      const adoptionSources: StableOliveTarget[] = [
        initialDevice,
        target,
        ...savedDevices,
      ];
      await adoptDeviceCacheIdentity(identified, adoptionSources);
      if (!isCurrentAttempt()) return false;
      adoptDeviceLocalStorage(identified, adoptionSources);
      if (!isCurrentAttempt()) return false;
      setCurrentDevice(identified);
      setConnected(true); setModelProfile(profile); setStatus(`${profile.displayName} ${t("connected").toLowerCase()} · ${identified.host}`);
      setDeviceAvailability((items) => ({ ...items, [selectionKey]: "online", [deviceKey(identified)]: "online" }));
      localStorage.setItem(DEVICE_KEY, JSON.stringify(identified));
      setSavedDevices((items) => {
        const existing = items.find((item) => devicesReferToSameOlive(item, identified));
        const baseName = suggestedName?.trim() || profile.displayName || "Olive";
        const saved: SavedOlive = {
          ...identified,
          name: isDemoTarget(identified) ? "Preview Library" : existing?.name ?? `${baseName} · ${deviceSuffix(identified.host)}`,
        };
        return upsertSavedDevice(items, saved);
      });
      if (section === "Lab") replaceSection("Home");
      return true;
    } catch (error) {
      if (!isCurrentAttempt()) return false;
      setConnected(false); setModelProfile(null); setStatus("Looking for your Olive…");
      setDeviceAvailability((items) => ({ ...items, [selectionKey]: "offline" }));
      setConnectionProblem(error instanceof Error ? error.message : "Your Olive was found, but its controller did not answer.");
      return false;
    } finally {
      if (isCurrentAttempt()) setConnectingKey("");
    }
  }

  function confirmDevice(device = target, suggestedName?: string) {
    if (!device.host || device.port < 1 || device.port > 65535) { setStatus("Enter a valid local IP and port."); return; }
    setConnectionProblem("");
    setCurrentDevice(device); setConnected(false);
    localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    setStatus(`Identifying ${device.host}:${device.port}…`);
    void identifyDevice(device, suggestedName);
  }

  function switchDevice(key: string) {
    const device = savedDevices.find((item) => deviceKey(item) === key);
    if (!device || (deviceKey(target) === key && connected)) return;
    setConnected(false); setCurrentDevice(device); setStatus(`Connecting to ${device.name}…`);
    localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
    void identifyDevice(device);
  }

  function forgetDevice(key: string) {
    const device = savedDevices.find((item) => deviceKey(item) === key);
    if (!device) return;
    setSavedDevices((items) => items.filter((item) => deviceKey(item) !== key));
    void clearDeviceCache(device);
    if (deviceKey(target) !== key) return;
    invalidateIdentifyAttempts();
    setConnected(false); clearCurrentDevice(); setModelProfile(null);
    localStorage.removeItem(DEVICE_KEY);
    setStatus("Olive forgotten"); replaceSection("Lab");
  }

  function renameDevice(key: string, nextName: string) {
    const name = nextName.trim().slice(0, 50);
    if (!name) return;
    setSavedDevices((items) => items.map((item) => deviceKey(item) === key ? { ...item, name } : item));
  }

  function startDemo() {
    setConnectionProblem("");
    setDiscovery(null);
    confirmDevice(DEMO_TARGET, "Preview Library");
  }

  function exitDemo() {
    invalidateIdentifyAttempts();
    setConnected(false); clearCurrentDevice(); setModelProfile(null);
    setSavedDevices((items) => items.filter((item) => !isDemoTarget(item)));
    localStorage.removeItem(DEVICE_KEY);
    setStatus("Not connected"); replaceSection("Lab");
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
    invalidateIdentifyAttempts();
    setSearchAttempted(true); setConnectionProblem(""); setDiscovering(true); setDiscovery(null); setStatus("Searching for your Olive…");
    try {
      const localNetwork = await refreshLocalNetwork();
      if (localNetwork && !localNetwork.localAddress) {
        setDiscovery({ candidates: [], ssdpResponses: 0 });
        setConnectionProblem(localNetwork.vpnActive ? "A VPN is active and may be hiding your home network." : "This device is not connected to a usable home network.");
        setStatus("Join your home Wi-Fi");
        return;
      }
      const data = await api<DiscoveryResult>("/api/discover", { method: "POST", body: "{}" });
      setDiscovery(data);
      setDeviceAvailability((items) => {
        const next = { ...items };
        for (const saved of savedDevices) {
          if (data.candidates.some((candidate) => devicesReferToSameOlive(saved, candidateDevice(candidate)))) {
            next[deviceKey(saved)] = "online";
          }
        }
        return next;
      });
      if ((autoSelect || data.candidates.length === 1) && data.candidates[0]) {
        const candidate = data.candidates[0];
        confirmDevice(candidateDevice(candidate), candidate.name);
      } else {
        if (!data.candidates.length) setConnectionProblem(localNetwork?.vpnActive ? "A VPN is active and may be blocking discovery." : "Your Olive did not answer on this local network.");
        setStatus(data.candidates.length ? `Found ${data.candidates.length} candidate${data.candidates.length === 1 ? "" : "s"}` : "No candidate found. Manual entry remains available.");
      }
    } catch { setDiscovery({ candidates: [], ssdpResponses: 0 }); setConnectionProblem("Local Network access may be turned off, or this device is not on the same network as your Olive."); setStatus("Could not find your Olive."); }
    finally { setDiscovering(false); }
  }

  async function openNetworkSettings() {
    if (!await openLocalNetworkSettings()) setStatus("Open this device’s Settings and join your home Wi-Fi.");
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
    link.download = `olive-remote-diagnostics-${Date.now()}.json`; link.click(); URL.revokeObjectURL(link.href);
    setStatus("Redacted diagnostics exported.");
  }

  const parsed = result ? parseResponseBody(result.body, result.headers["content-type"] ?? "") : null;
  const sectionLabel: Record<Section, string> = { Home: t("home"), Library: t("library"), Search: t("search"), Playlists: t("playlists"), "Add Music": t("addMusic"), Lab: "Find My Olive", Settings: t("settings") };

  return <PlaybackProvider
    connected={connected}
    target={target}
    volumeControlEnabled={demoActive || modelProfile?.model === "o4hd"}
    seekControlEnabled={demoActive || modelProfile?.seekControl === "verified"}
    onStatus={setStatus}
  ><div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark" src="/icon.svg" alt="" /><div><strong>Olive Remote</strong></div></div>
      <nav>{sections.map((item) => <button className={section === item ? "active" : ""} aria-current={section === item ? "page" : undefined} onClick={() => navigate(item)} key={item}><Icon name={navIcons[item]} />{sectionLabel[item]}</button>)}</nav>
    </aside>

    <main>
      <header><div className="header-leading">{(hasContentBack || sectionHistoryDepth > 0) && <button className="app-back" onClick={goBack} aria-label="Back"><Icon name="back" /><span>Back</span></button>}<h1>{sectionLabel[section]}</h1></div>{savedDevices.length > 1 ? <label className={`device-switcher ${connected ? "online" : ""}`}><i /><span className="sr-only">Active Olive</span><select value={deviceKey(target)} onChange={(event) => switchDevice(event.target.value)} aria-label="Active Olive">{savedDevices.map((device) => { const availability = deviceAvailability[deviceKey(device)] ?? "unknown"; const mark = availability === "online" ? "●" : availability === "checking" ? "◌" : "○"; const label = availability === "online" ? "Online" : availability === "checking" ? "Checking" : availability === "offline" ? "Offline" : "Not checked"; return <option key={deviceKey(device)} value={deviceKey(device)}>{mark} {device.name} — {label}</option>; })}</select></label> : section !== "Settings" && <div className={`connection-pill ${connected ? "online" : ""}`}><i />{connected ? t("connected") : status}</div>}</header>
      {demoActive && <div className="demo-banner" role="status"><span><strong>Preview library</strong> · fictional content</span><button onClick={exitDemo}>Use my Olive</button></div>}
      <LibraryCatalogSync connected={connected} target={target} />

      {section === "Home" ? <NowPlayingView />
        : section === "Library" ? <LibraryView connected={connected} target={target} onStatus={setStatus} onRegisterBack={registerContentBack} />
        : section === "Search" ? <SearchView connected={connected} target={target} onStatus={setStatus} onRegisterBack={registerContentBack} />
        : section === "Playlists" ? <PlaylistsView connected={connected} target={target} onStatus={setStatus} onRegisterBack={registerContentBack} />
        : section === "Add Music" ? <AddMusicView connected={connected} target={target} />
        : section === "Settings" ? <SettingsView target={target} savedDevices={savedDevices} connected={connected} availability={deviceAvailability} onSelect={switchDevice} onRename={renameDevice} onForget={forgetDevice} onOpenLab={() => navigate("Lab")} onExportDiagnostics={exportDiagnostics} />
        : section !== "Lab" ? null : <>
        <section className="card find-olive-card">
          <div className="find-olive-copy"><span className="connection-eyebrow">LOCAL CONNECTION</span><h2>Find your Olive</h2><p>Olive Remote connects directly to your music server at home. No account or internet connection is required.</p></div>
          <div className="connection-checklist" aria-label="Before searching">
            <div><span>1</span><p><strong>Turn on your Olive</strong><small>Connect it to your home router with Wi-Fi or an Ethernet cable.</small></p></div>
            <div><span>2</span><p><strong>Use the same Wi-Fi</strong><small>Connect this phone or tablet to that router’s main Wi-Fi network.</small></p></div>
          </div>
          <div className="setup-status" aria-live="polite">
            <div className={networkState?.localAddress ? "ready" : ""}><i /> <span><strong>{networkState?.localAddress ? "Home network detected" : isNativeApp ? "Checking your home network" : "Ready to search this network"}</strong>{networkState?.localAddress && <small>{networkState.localAddress}</small>}</span></div>
            <div className={searchAttempted ? "ready" : ""}><i /> <span><strong>Local Network access</strong><small>{searchAttempted ? "Network search checked" : isNativeAndroid ? "No location permission is used." : isNativeApp ? "When asked, tap Allow so Olive Remote can find your server." : "Access stays on this local network."}</small></span></div>
          </div>
          <button onClick={() => void findDevice(false)} disabled={discovering} className="discover-button primary-discovery">{discovering && <span className="spinner" />}{discovering ? "Looking for your Olive…" : "Find My Olive"}</button>
          <button onClick={startDemo} disabled={discovering} className="demo-entry">Preview without a server</button>
          <small className="connection-hint">Guest Wi-Fi, a VPN, or cellular-only service can prevent discovery.</small>
        </section>

        {discovery && <section className="card results-card"><div className="section-heading"><div><h2>{discovery.candidates.length ? "Choose your Olive" : "Connection help"}</h2></div></div>
          {discovery.candidates.length === 0 ? <div className="connection-help"><strong>{connectionProblem || "We couldn’t find your Olive yet."}</strong><p>Check that it is awake and connected to the same home router, then try again. Turn off guest Wi-Fi or a VPN while connecting.</p><div className="connection-help-actions"><button onClick={() => void findDevice(false)} disabled={discovering}>Try Again</button>{isNativeApp && <button className="secondary" onClick={() => void openNetworkSettings()}>{networkState?.settingsLabel ?? "Open Settings"}</button>}</div></div> : <div className="candidate-list">{discovery.candidates.map((candidate) => { const candidateKey = deviceKey(candidateDevice(candidate)); const connecting = connectingKey === candidateKey; return <article key={candidateKey}><div><strong>{candidate.name}</strong><small>Olive found at {candidate.address}</small></div><button onClick={() => confirmDevice(candidateDevice(candidate), candidate.name)} disabled={Boolean(connectingKey)} aria-busy={connecting}>{connecting && <span className="spinner" />}{connecting ? "Connecting…" : "Connect"}</button></article>; })}</div>}
        </section>}

        <details className="card manual-connection"><summary>Enter the Olive address manually</summary><p>If automatic discovery does not work, find the IP address in your Olive’s network settings. On most models, open <strong>Settings → Network</strong> on the Olive display.</p><div className="address-row"><label><span>IP address or .local name</span><input value={host} onChange={(event) => { const nextHost = event.target.value; setHost(nextHost); setDeviceDetails({ host: nextHost, port }); setConnected(false); }} placeholder="192.168.1.42" /></label><label className="port"><span>Port</span><input type="number" min="1" max="65535" value={port} onChange={(event) => { const nextPort = Number(event.target.value); setPort(nextPort); setDeviceDetails({ host, port: nextPort }); }} /></label><button onClick={() => confirmDevice()} disabled={!host || Boolean(connectingKey)} aria-busy={Boolean(connectingKey)}>{connectingKey && <span className="spinner" />}{connectingKey ? "Connecting…" : "Connect"}</button></div></details>

        {!isNativeApp && import.meta.env.DEV && <details className="advanced-protocol"><summary>Advanced diagnostics</summary><div>

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
        </div></details>}
      </>}
    </main>
    {connected && section !== "Lab" && <MiniPlayer expanded={section === "Home"} onOpen={() => navigate("Home")} onToggle={() => navigate(section === "Home" ? "Library" : "Home")} />}
  </div></PlaybackProvider>;
}
