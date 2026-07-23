import { useCallback, useEffect, useRef, useState } from "react";
import type { MaestroBrowseRequest, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { LibraryArtwork, LibrarySkeleton } from "./LibraryArtwork";
import { readDeviceCache, writeDeviceCache } from "../deviceCache";
import { indexSearchTree } from "../searchIndex";
import { usePlaybackActions } from "../playback/PlaybackProvider";

interface LibraryViewProps {
  connected: boolean;
  target: OliveDeviceTarget;
  onStatus: (status: string) => void;
  onRegisterBack?: (handler: (() => void) | null) => void;
}

interface Breadcrumb { title: string; tree: MaestroTree }

const ALPHABET = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

function artistInitial(title: string) {
  const first = title.trim().charAt(0).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

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

export function LibraryView({ connected, target, onStatus, onRegisterBack }: LibraryViewProps) {
  const [tree, setTree] = useState<MaestroTree | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [activeNode, setActiveNode] = useState<MaestroTreeNode | null>(null);
  const [playingId, setPlayingId] = useState("");
  const autoLoadedTarget = useRef("");
  const { playTrack: playCanonicalTrack, enqueue } = usePlaybackActions();

  async function loadRoot() {
    if (!connected) return;
    setLoading(true); setError("");
    const resource = "library:navigation";
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached) {
      setTree(cached); setBreadcrumbs([]); setActiveNode(null); setPage(0); setLoading(false);
    }
    try {
      const result = await post<MaestroTree>("/api/library/navigation", target);
      setTree(result); setBreadcrumbs([]); setActiveNode(null); setPage(0);
      void writeDeviceCache(target, resource, result);
      void indexSearchTree(target, result);
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
      setError("");
      await playTrack(node);
      return;
    }
    const pageSize = type === "track" && node.id === "tracks" ? 64 : 21;
    setLoading(true); setError("");
    const resource = `library:browse:${type}:${node.id}:${requestedPage}`;
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached) {
      if (requestedPage === 0) setBreadcrumbs((trail) => tree ? [...trail, { title: node.title, tree }] : trail);
      setTree(cached); setActiveNode(node); setPage(requestedPage); setLoading(false);
    }
    try {
      const result = await post<MaestroTree>("/api/library/browse", {
        target,
        browse: { id: node.id, type, startIndex: requestedPage * pageSize, index: requestedPage },
      });
      if (requestedPage === 0 && !cached) setBreadcrumbs((trail) => tree ? [...trail, { title: node.title, tree }] : trail);
      setTree(result); setActiveNode(node); setPage(requestedPage);
      void writeDeviceCache(target, resource, result);
      void indexSearchTree(target, result);
      onStatus(`${node.title}: ${result.items.length} items loaded`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open this section."); }
    finally { setLoading(false); }
  }

  const goBack = useCallback(() => {
    setBreadcrumbs((trail) => {
      const previous = trail.at(-1);
      if (previous) setTree(previous.tree);
      return previous ? trail.slice(0, -1) : trail;
    });
    setActiveNode(null); setPage(0); setError("");
  }, []);

  useEffect(() => {
    onRegisterBack?.(breadcrumbs.length ? goBack : null);
    return () => onRegisterBack?.(null);
  }, [breadcrumbs.length, goBack, onRegisterBack]);

  async function playTrack(track: MaestroTreeNode) {
    setPlayingId(track.id); setError("");
    try {
      onStatus(`Starting ${track.title}…`);
      const context = (tree?.items ?? []).filter((item) => browseType(item) === "track" && item.id !== "tracks");
      await playCanonicalTrack(track, context.length ? context : [track]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;

  const total = tree?.totalItems ?? null;
  const activePageSize = activeNode && browseType(activeNode) === "track" && activeNode.id === "tracks" ? 64 : 21;
  const canNext = total !== null && (page + 1) * activePageSize < total;
  const isArtistIndex = activeNode?.id === "artists" && browseType(activeNode) === "artists";
  const artistGroups = isArtistIndex && tree ? ALPHABET.map((letter) => ({
    letter,
    items: tree.items.filter((item) => artistInitial(item.title) === letter),
  })).filter((group) => group.items.length > 0) : [];
  const availableArtistLetters = new Set(artistGroups.map((group) => group.letter));

  function jumpToArtistLetter(letter: string) {
    document.getElementById(`artist-section-${letter === "#" ? "other" : letter}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return <section className="module-stack">
    <div className="content-toolbar">
      {breadcrumbs.length > 0 ? <div className="library-path"><button onClick={() => void loadRoot()}>Library</button>{breadcrumbs.map((crumb, index) => <span key={`${crumb.title}-${index}`}>/ {crumb.title}</span>)}</div> : <span />}
      <div className="toolbar-actions">{breadcrumbs.length > 0 && <button className="secondary" onClick={goBack}>Back</button>}<button className="secondary" onClick={() => void loadRoot()} disabled={loading}>Refresh</button></div>
    </div>
    {error && <div className="error-box">{error}</div>}
    <div className="card library-panel" aria-busy={loading}>
      {loading ? <LibrarySkeleton count={tree?.items.length ? Math.min(tree.items.length, 15) : 12} /> : tree?.items.length ? isArtistIndex ? <div className="artist-browser">
        <div className="artist-sections">{artistGroups.map((group) => <section className="artist-section" id={`artist-section-${group.letter === "#" ? "other" : group.letter}`} key={group.letter} aria-labelledby={`artist-heading-${group.letter}`}><h2 id={`artist-heading-${group.letter}`}>{group.letter}</h2><div className="library-grid">{group.items.map((item) => <button key={item.id} onClick={() => void openNode(item)}><LibraryArtwork target={target} item={item} fallback="♪" /><span><strong>{item.title || "Untitled"}</strong></span><i>›</i></button>)}</div></section>)}</div>
        <nav className="artist-index" aria-label="Jump to artist letter">{ALPHABET.map((letter) => <button key={letter} disabled={!availableArtistLetters.has(letter)} aria-label={`Jump to artists beginning with ${letter}`} onClick={() => jumpToArtistLetter(letter)}>{letter}</button>)}</nav>
      </div> : <div className="library-grid">{tree.items.map((item) => <div className="library-item" key={item.id}><button onClick={() => void openNode(item)}><LibraryArtwork target={target} item={item} fallback={browseType(item) === "track" ? "▶" : "♪"} /><span><strong>{item.title || "Untitled"}</strong>{playingId === item.id && <small>Starting…</small>}</span><i>›</i></button>{browseType(item) === "track" && item.id !== "tracks" && <button className="queue-add" onClick={() => { enqueue(item); onStatus(`${item.title} added to queue`); }} aria-label={`Add ${item.title} to queue`}>+</button>}</div>)}</div> : <div className="empty">This section is empty.</div>}
      {total !== null && <div className="pagination"><span>{total.toLocaleString()} items · Page {page + 1}</span><div><button className="secondary" disabled={loading || page === 0 || !activeNode} onClick={() => activeNode && void openNode(activeNode, page - 1)}>Previous</button><button className="secondary" disabled={loading || !canNext || !activeNode} onClick={() => activeNode && void openNode(activeNode, page + 1)}>Next</button></div></div>}
    </div>
  </section>;
}
