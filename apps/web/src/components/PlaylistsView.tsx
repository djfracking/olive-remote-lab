import { useCallback, useEffect, useRef, useState } from "react";
import type { MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { LibraryArtwork } from "./LibraryArtwork";
import { readDeviceCache, writeDeviceCache } from "../deviceCache";
import { usePlaybackActions } from "../playback/PlaybackProvider";
import { deviceRequestKey, type StableOliveTarget } from "../deviceIdentity";
import { resolveMaestroPlaybackNode } from "../playbackIdentity";
import {
  UPNP_CATALOG_ROOTS,
  isUpnpTreeNode,
  targetSupportsContentDirectory,
  upnpPageToTree,
  type UpnpCatalogPage,
} from "../upnpCatalog";

interface Props { connected: boolean; target: OliveDeviceTarget; onStatus: (status: string) => void; onRegisterBack?: (handler: (() => void) | null) => void }

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await appFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Playlist request failed.");
  return data;
}

export function shouldApplyPlaylistOperation(
  expectedRevision: number,
  currentRevision: number,
  expectedRequestKey: string,
  currentRequestKey: string,
): boolean {
  return expectedRevision === currentRevision
    && expectedRequestKey === currentRequestKey;
}

export function PlaylistsView({ connected, target, onStatus, onRegisterBack }: Props) {
  const [playlists, setPlaylists] = useState<MaestroTree | null>(null);
  const [tracks, setTracks] = useState<MaestroTree | null>(null);
  const [active, setActive] = useState<MaestroTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState("");
  const loadedTarget = useRef("");
  const operationRevision = useRef(0);
  const { playTrack } = usePlaybackActions();
  const targetRequestKey = deviceRequestKey(target as StableOliveTarget);
  const targetRequestKeyRef = useRef(targetRequestKey);
  targetRequestKeyRef.current = targetRequestKey;

  function operationIsCurrent(revision: number, expectedRequestKey: string): boolean {
    return shouldApplyPlaylistOperation(
      revision,
      operationRevision.current,
      expectedRequestKey,
      targetRequestKeyRef.current,
    );
  }

  async function loadPlaylists() {
    if (!connected) return;
    const revision = ++operationRevision.current;
    const expectedRequestKey = targetRequestKey;
    setLoading(true); setError(""); setTracks(null); setActive(null);
    const useUpnp = targetSupportsContentDirectory(target as StableOliveTarget);
    const resource = `library:playlists:${useUpnp ? "upnp" : "maestro"}`;
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached && operationIsCurrent(revision, expectedRequestKey)) {
      setPlaylists(cached);
      setLoading(false);
    }
    try {
      const result = useUpnp
        ? upnpPageToTree(
          target as StableOliveTarget,
          await post<UpnpCatalogPage>("/api/upnp/browse", {
            target,
            objectId: UPNP_CATALOG_ROOTS.playlists,
            startingIndex: 0,
            requestedCount: 64,
          }),
          "playlists",
        )
        : await post<MaestroTree>("/api/library/browse", { target, browse: { id: "playlists", type: "playlist" } });
      if (!operationIsCurrent(revision, expectedRequestKey)) return;
      void writeDeviceCache(target, resource, result);
      setPlaylists(result); onStatus(`${result.items.length} playlists loaded`);
    } catch (reason) {
      if (operationIsCurrent(revision, expectedRequestKey)) {
        setError(reason instanceof Error ? reason.message : "Playlists unavailable.");
      }
    } finally {
      if (operationIsCurrent(revision, expectedRequestKey)) setLoading(false);
    }
  }

  useEffect(() => {
    const key = connected
      ? `${targetRequestKey}|${targetSupportsContentDirectory(target as StableOliveTarget) ? "upnp" : "maestro"}`
      : "";
    if (!key) {
      loadedTarget.current = "";
      ++operationRevision.current;
      return;
    }
    if (loadedTarget.current === key) return;
    loadedTarget.current = key; void loadPlaylists();
    return () => {
      ++operationRevision.current;
      if (loadedTarget.current === key) loadedTarget.current = "";
    };
  }, [connected, targetRequestKey]);

  async function openPlaylist(item: MaestroTreeNode) {
    const revision = ++operationRevision.current;
    const expectedRequestKey = targetRequestKey;
    setLoading(true); setError("");
    const upnp = isUpnpTreeNode(item);
    const resource = `library:playlist:${upnp ? "upnp" : "maestro"}:${item.userData.upnpId ?? item.id}`;
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached && operationIsCurrent(revision, expectedRequestKey)) {
      setActive(item); setTracks(cached); setLoading(false);
    }
    try {
      const result = upnp
        ? upnpPageToTree(
          target as StableOliveTarget,
          await post<UpnpCatalogPage>("/api/upnp/browse", {
            target,
            objectId: item.userData.upnpId || item.id,
            startingIndex: 0,
            requestedCount: 64,
          }),
          "tracks",
        )
        : await post<MaestroTree>("/api/library/browse", { target, browse: { id: item.id, type: "playlist", startIndex: 0, index: 0 } });
      if (!operationIsCurrent(revision, expectedRequestKey)) return;
      void writeDeviceCache(target, resource, result);
      setActive(item); setTracks(result); onStatus(`${item.title}: ${result.items.length} items loaded`);
    } catch (reason) {
      if (operationIsCurrent(revision, expectedRequestKey)) {
        setError(reason instanceof Error ? reason.message : "Could not open playlist.");
      }
    } finally {
      if (operationIsCurrent(revision, expectedRequestKey)) setLoading(false);
    }
  }

  async function play(item: MaestroTreeNode) {
    setPlayingId(item.id); setError("");
    try {
      const playable = await resolveMaestroPlaybackNode(target, item);
      await playTrack(playable, isUpnpTreeNode(item) ? [playable] : tracks?.items ?? [playable]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  const goBack = useCallback(() => {
    ++operationRevision.current;
    setLoading(false);
    setActive(null);
    setTracks(null);
    setError("");
  }, []);

  useEffect(() => {
    onRegisterBack?.(active ? goBack : null);
    return () => onRegisterBack?.(null);
  }, [active, goBack, onRegisterBack]);

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;
  const items = tracks?.items ?? playlists?.items ?? [];

  return <section className="module-stack">
    <div className="content-toolbar">{active ? <h2>{active.title}</h2> : <span />}<div className="toolbar-actions">{active && <button className="secondary" onClick={goBack}>Back</button>}<button className="secondary" onClick={() => void loadPlaylists()} disabled={loading}>Refresh</button></div></div>
    {error && <div className="error-box">{error}</div>}
    <div className="card library-panel">{loading ? <div className="module-loading"><span className="spinner" />Loading…</div> : items.length ? <div className="library-grid">{items.map((item) => <button key={`${item.userData.source ?? "maestro"}:${item.userData.upnpId ?? item.id}`} onClick={() => active ? void play(item) : void openPlaylist(item)}><LibraryArtwork target={target} item={item} fallback={active ? "▶" : "≡"} /><span><strong>{item.title || "Untitled"}</strong>{active ? playingId === item.id && <small>Starting…</small> : (item.childCount ?? 0) > 0 && <small>{item.childCount} tracks</small>}</span><i>›</i></button>)}</div> : <div className="empty">No playlists found.</div>}</div>
  </section>;
}
