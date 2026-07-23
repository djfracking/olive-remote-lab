import { useCallback, useEffect, useRef, useState } from "react";
import type { MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { LibraryArtwork } from "./LibraryArtwork";
import { readDeviceCache, writeDeviceCache } from "../deviceCache";
import { usePlaybackActions } from "../playback/PlaybackProvider";

interface Props { connected: boolean; target: OliveDeviceTarget; onStatus: (status: string) => void; onRegisterBack?: (handler: (() => void) | null) => void }

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await appFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Playlist request failed.");
  return data;
}

export function PlaylistsView({ connected, target, onStatus, onRegisterBack }: Props) {
  const [playlists, setPlaylists] = useState<MaestroTree | null>(null);
  const [tracks, setTracks] = useState<MaestroTree | null>(null);
  const [active, setActive] = useState<MaestroTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState("");
  const loadedTarget = useRef("");
  const { playTrack } = usePlaybackActions();

  async function loadPlaylists() {
    if (!connected) return;
    setLoading(true); setError(""); setTracks(null); setActive(null);
    const resource = "library:playlists";
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached) { setPlaylists(cached); setLoading(false); }
    try {
      const result = await post<MaestroTree>("/api/library/browse", { target, browse: { id: "playlists", type: "playlist" } });
      void writeDeviceCache(target, resource, result);
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
    const resource = `library:playlist:${item.id}`;
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached) { setActive(item); setTracks(cached); setLoading(false); }
    try {
      const result = await post<MaestroTree>("/api/library/browse", { target, browse: { id: item.id, type: "playlist", startIndex: 0, index: 0 } });
      void writeDeviceCache(target, resource, result);
      setActive(item); setTracks(result); onStatus(`${item.title}: ${result.items.length} items loaded`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open playlist."); }
    finally { setLoading(false); }
  }

  async function play(item: MaestroTreeNode) {
    setPlayingId(item.id); setError("");
    try {
      await playTrack(item, tracks?.items ?? [item]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  const goBack = useCallback(() => { setActive(null); setTracks(null); setError(""); }, []);

  useEffect(() => {
    onRegisterBack?.(active ? goBack : null);
    return () => onRegisterBack?.(null);
  }, [active, goBack, onRegisterBack]);

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;
  const items = tracks?.items ?? playlists?.items ?? [];

  return <section className="module-stack">
    <div className="content-toolbar">{active ? <h2>{active.title}</h2> : <span />}<div className="toolbar-actions">{active && <button className="secondary" onClick={goBack}>Back</button>}<button className="secondary" onClick={() => void loadPlaylists()} disabled={loading}>Refresh</button></div></div>
    {error && <div className="error-box">{error}</div>}
    <div className="card library-panel">{loading ? <div className="module-loading"><span className="spinner" />Loading…</div> : items.length ? <div className="library-grid">{items.map((item) => <button key={item.id} onClick={() => active ? void play(item) : void openPlaylist(item)}><LibraryArtwork target={target} item={item} fallback={active ? "▶" : "≡"} /><span><strong>{item.title || "Untitled"}</strong>{active ? playingId === item.id && <small>Starting…</small> : (item.childCount ?? 0) > 0 && <small>{item.childCount} tracks</small>}</span><i>›</i></button>)}</div> : <div className="empty">No playlists found.</div>}</div>
  </section>;
}
