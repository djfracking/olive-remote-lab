import { useEffect, useRef, useState } from "react";
import type { MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";

interface Props { connected: boolean; target: OliveDeviceTarget; onStatus: (status: string) => void }

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await appFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Playlist request failed.");
  return data;
}

export function PlaylistsView({ connected, target, onStatus }: Props) {
  const [playlists, setPlaylists] = useState<MaestroTree | null>(null);
  const [tracks, setTracks] = useState<MaestroTree | null>(null);
  const [active, setActive] = useState<MaestroTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState("");
  const loadedTarget = useRef("");

  async function loadPlaylists() {
    if (!connected) return;
    setLoading(true); setError(""); setTracks(null); setActive(null);
    try {
      const result = await post<MaestroTree>("/api/library/browse", { target, browse: { id: "playlists", type: "playlist" } });
      setPlaylists(result); onStatus(`${result.items.length} playlists loaded`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playlists unavailable."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const key = connected ? `${target.host}:${target.port}` : "";
    if (!key || loadedTarget.current === key) return;
    loadedTarget.current = key; void loadPlaylists();
  }, [connected, target.host, target.port]);

  async function openPlaylist(item: MaestroTreeNode) {
    setLoading(true); setError("");
    try {
      const result = await post<MaestroTree>("/api/library/browse", { target, browse: { id: item.id, type: "playlist", startIndex: 0, index: 0 } });
      setActive(item); setTracks(result); onStatus(`${item.title}: ${result.items.length} items loaded`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open playlist."); }
    finally { setLoading(false); }
  }

  async function play(item: MaestroTreeNode) {
    setPlayingId(item.id); setError("");
    try {
      const playbackIndex = item.userData.playbackIndex ? Number(item.userData.playbackIndex) : undefined;
      await post("/api/playback", { target, command: { action: "play", itemId: item.id, ...(playbackIndex !== undefined ? { index: playbackIndex } : {}) } });
      onStatus(`Playing ${item.title}`);
      window.dispatchEvent(new Event("olive-playback-changed"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  if (!connected) return <section className="card module-empty"><h2>Connect a server</h2><p>Choose a local device before reading playlists.</p></section>;
  const items = tracks?.items ?? playlists?.items ?? [];

  return <section className="module-stack">
    <div className="card module-toolbar"><div><span className="step">READ ONLY</span><div><h2>{active?.title ?? "Playlists"}</h2><p>Playlist editing stays locked until its write contract is verified.</p></div></div><div className="toolbar-actions">{active && <button className="secondary" onClick={() => { setActive(null); setTracks(null); }}>Back</button>}<button className="secondary" onClick={() => void loadPlaylists()} disabled={loading}>Refresh</button></div></div>
    {error && <div className="error-box">{error}</div>}
    <div className="card library-panel">{loading ? <div className="module-loading"><span className="spinner" />Reading playlists…</div> : items.length ? <div className="library-grid">{items.map((item) => <button key={item.id} onClick={() => active ? void play(item) : void openPlaylist(item)}><span className="library-icon">{active ? "▶" : "≡"}</span><span><strong>{item.title || "Untitled"}</strong><small>{active ? (playingId === item.id ? "Starting…" : "Play track") : `${item.childCount || ""} playlist items`}</small></span><i>›</i></button>)}</div> : <div className="empty">No playlists were returned by this server.</div>}</div>
  </section>;
}
