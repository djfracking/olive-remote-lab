import { useEffect, useRef, useState } from "react";
import type { MaestroBrowseRequest, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";

interface LibraryViewProps {
  connected: boolean;
  target: OliveDeviceTarget;
  onStatus: (status: string) => void;
}

interface Breadcrumb { title: string; tree: MaestroTree }

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await appFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Library request failed.");
  return data;
}

function browseType(node: MaestroTreeNode): MaestroBrowseRequest["type"] | null {
  const type = node.userData.type?.toLowerCase();
  if (type === "albumname") return "albumname";
  if (type === "artist" || type === "artists" || type === "interpreter") return "artists";
  if (type === "album" || type === "compilation") return "compilation";
  if (type === "playlist") return "playlist";
  if (type === "genre") return "genre";
  if (type === "track" || type === "tracks") return "track";
  return null;
}

export function LibraryView({ connected, target, onStatus }: LibraryViewProps) {
  const [tree, setTree] = useState<MaestroTree | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [activeNode, setActiveNode] = useState<MaestroTreeNode | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<MaestroTreeNode | null>(null);
  const [playing, setPlaying] = useState(false);
  const autoLoadedTarget = useRef("");

  async function loadRoot() {
    if (!connected) return;
    setLoading(true); setError("");
    try {
      const result = await post<MaestroTree>("/api/library/navigation", target);
      setTree(result); setBreadcrumbs([]); setActiveNode(null); setPage(0);
      onStatus(`${result.items.length} library sections available`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Library unavailable."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const key = connected ? `${target.host}:${target.port}` : "";
    if (!key || autoLoadedTarget.current === key) return;
    autoLoadedTarget.current = key;
    void loadRoot();
  }, [connected, target.host, target.port]);

  async function openNode(node: MaestroTreeNode, requestedPage = 0) {
    const type = browseType(node);
    if (!type) { setError(`“${node.title}” uses an unverified browse mode.`); return; }
    if (type === "track" && node.id !== "tracks") {
      setSelectedTrack(node); setError("");
      await playTrack(node);
      return;
    }
    const pageSize = type === "track" && node.id === "tracks" ? 64 : 21;
    setLoading(true); setError("");
    try {
      const result = await post<MaestroTree>("/api/library/browse", {
        target,
        browse: { id: node.id, type, startIndex: requestedPage * pageSize, index: requestedPage },
      });
      if (requestedPage === 0) setBreadcrumbs((trail) => tree ? [...trail, { title: node.title, tree }] : trail);
      setTree(result); setActiveNode(node); setPage(requestedPage);
      onStatus(`${node.title}: ${result.items.length} items loaded`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open this section."); }
    finally { setLoading(false); }
  }

  function goBack() {
    const previous = breadcrumbs[breadcrumbs.length - 1];
    if (!previous) { void loadRoot(); return; }
    setTree(previous.tree); setBreadcrumbs((trail) => trail.slice(0, -1)); setActiveNode(null); setPage(0); setError("");
  }

  async function playTrack(track: MaestroTreeNode) {
    if (selectedTrack?.id === track.id && !playing) {
      onStatus(`${track.title} is already selected`);
      return;
    }
    setPlaying(true); setError("");
    try {
      onStatus(`Starting ${track.title}…`);
      const playbackIndex = track.userData.playbackIndex ? Number(track.userData.playbackIndex) : undefined;
      const command = { action: "play" as const, itemId: track.id, ...(playbackIndex !== undefined ? { index: playbackIndex } : {}) };
      const response = await appFetch("/api/playback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, command }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Playback failed.");
      onStatus(`Playing ${track.title}`);
      window.dispatchEvent(new Event("olive-playback-changed"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlaying(false); }
  }

  if (!connected) return <section className="card module-empty"><h2>Connect a server</h2><p>Choose a local device in Explorer before opening its library.</p></section>;

  const total = tree?.totalItems ?? null;
  const activePageSize = activeNode && browseType(activeNode) === "track" && activeNode.id === "tracks" ? 64 : 21;
  const canNext = total !== null && (page + 1) * activePageSize < total;

  return <section className="module-stack">
    <div className="card module-toolbar">
      <div><span className="step">LIVE</span><div><h2>Music Library</h2><p>Read directly from {target.host}</p></div></div>
      <div className="toolbar-actions"><button className="secondary" onClick={goBack} disabled={!breadcrumbs.length}>Back</button><button className="secondary" onClick={() => void loadRoot()} disabled={loading}>Refresh</button></div>
    </div>
    {error && <div className="error-box">{error}</div>}
    <div className="library-path"><button onClick={() => void loadRoot()}>Library</button>{breadcrumbs.map((crumb) => <span key={`${crumb.title}-${breadcrumbs.indexOf(crumb)}`}>/ {crumb.title}</span>)}{activeNode && <span>/ {activeNode.title}</span>}</div>
    <div className="card library-panel">
      {loading ? <div className="module-loading"><span className="spinner" />Reading server…</div> : tree?.items.length ? <div className="library-grid">{tree.items.map((item) => <button key={item.id} onClick={() => void openNode(item)}><span className="library-icon">♪</span><span><strong>{item.title || "Untitled"}</strong><small>{item.userData.type ?? (item.childCount ? "container" : "item")}</small></span><i>›</i></button>)}</div> : <div className="empty">This section is empty.</div>}
      {selectedTrack && <div className="selected-track"><div><span>{playing ? "Starting on server" : "Now selected"}</span><strong>{selectedTrack.title}</strong></div><button disabled>{playing ? "Starting…" : "Playing"}</button></div>}
      {total !== null && <div className="pagination"><span>{total.toLocaleString()} items · Page {page + 1}</span><div><button className="secondary" disabled={loading || page === 0 || !activeNode} onClick={() => activeNode && void openNode(activeNode, page - 1)}>Previous</button><button className="secondary" disabled={loading || !canNext || !activeNode} onClick={() => activeNode && void openNode(activeNode, page + 1)}>Next</button></div></div>}
    </div>
  </section>;
}
