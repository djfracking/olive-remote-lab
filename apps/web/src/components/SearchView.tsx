import { useState } from "react";
import type { LibrarySearchScope, MaestroBrowseRequest, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { LibraryArtwork, LibrarySkeleton } from "./LibraryArtwork";
import { announceTrackStarting } from "../playbackEvents";
import { readDeviceCache, writeDeviceCache } from "../deviceCache";

interface SearchViewProps { connected: boolean; target: OliveDeviceTarget; onStatus: (status: string) => void }
interface SearchBreadcrumb { title: string; tree: MaestroTree }

function browseType(node: MaestroTreeNode, fallback: LibrarySearchScope): MaestroBrowseRequest["type"] {
  const type = node.userData.type?.toLowerCase();
  if (type === "albumname") return "albumname";
  if (type === "artist" || type === "artists" || type === "interpreter") return "artists";
  if (type === "album" || type === "compilation") return "compilation";
  if (type === "playlist") return "playlist";
  if (type === "genre") return "genre";
  if (type === "track" || type === "tracks") return "track";
  const fallbackTypes: Record<LibrarySearchScope, MaestroBrowseRequest["type"]> = { albums: "compilation", artists: "artists", genres: "genre", tracks: "track", playlists: "playlist" };
  return fallbackTypes[fallback];
}

export function SearchView({ connected, target, onStatus }: SearchViewProps) {
  const [term, setTerm] = useState("");
  const [scope, setScope] = useState<LibrarySearchScope>("albums");
  const [results, setResults] = useState<MaestroTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState("");
  const [breadcrumbs, setBreadcrumbs] = useState<SearchBreadcrumb[]>([]);
  const [activeTitle, setActiveTitle] = useState("");

  async function search() {
    if (!connected || !term.trim()) return;
    setLoading(true); setError(""); setBreadcrumbs([]); setActiveTitle("");
    const resource = `library:search:${scope}:${term.trim().toLowerCase()}`;
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached) { setResults(cached); setLoading(false); }
    try {
      const response = await appFetch("/api/library/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, term, scope }) });
      const data = await response.json() as MaestroTree & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Search failed.");
      void writeDeviceCache(target, resource, data);
      setResults(data); onStatus(`${data.items.length} ${scope} matches`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Search failed."); }
    finally { setLoading(false); }
  }

  async function openItem(item: MaestroTreeNode) {
    const type = browseType(item, scope);
    if (type === "track" && item.id !== "tracks") { await play(item); return; }
    if (!results) return;
    setLoading(true); setError("");
    const resource = `library:search-browse:${type}:${item.id}`;
    let next = await readDeviceCache<MaestroTree>(target, resource);
    try {
      const response = await appFetch("/api/library/browse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, browse: { id: item.id, type, startIndex: 0, index: 0 } }) });
      const data = await response.json() as MaestroTree & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not open this result.");
      next = data;
      void writeDeviceCache(target, resource, data);
    } catch (reason) {
      if (!next) { setError(reason instanceof Error ? reason.message : "Could not open this result."); setLoading(false); return; }
    }
    setBreadcrumbs((trail) => [...trail, { title: activeTitle || "Search results", tree: results }]);
    setActiveTitle(item.title || "Search result");
    setResults(next);
    onStatus(`${item.title}: ${next.items.length} items loaded`);
    setLoading(false);
  }

  function goBack() {
    const previous = breadcrumbs[breadcrumbs.length - 1];
    if (!previous) return;
    setResults(previous.tree); setActiveTitle(previous.title === "Search results" ? "" : previous.title);
    setBreadcrumbs((trail) => trail.slice(0, -1)); setError("");
  }

  async function play(item: MaestroTreeNode) {
    setPlayingId(item.id); setError("");
    try {
      const playbackIndex = item.userData.playbackIndex ? Number(item.userData.playbackIndex) : undefined;
      const command = { action: "play" as const, itemId: item.id, ...(playbackIndex !== undefined ? { index: playbackIndex } : {}) };
      announceTrackStarting(item);
      const response = await appFetch("/api/playback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, command }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Playback failed.");
      onStatus(`Playing ${item.title}`);
      window.dispatchEvent(new Event("olive-playback-changed"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;

  return <section className="module-stack">
    <div className="card search-hero"><form onSubmit={(event) => { event.preventDefault(); void search(); }}><select value={scope} onChange={(event) => { setScope(event.target.value as LibrarySearchScope); setResults(null); setBreadcrumbs([]); setActiveTitle(""); setError(""); }} aria-label="Search scope"><option value="albums">Albums</option><option value="artists">Artists</option><option value="genres">Genres</option><option value="tracks">Tracks</option><option value="playlists">Playlists</option></select><input value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Search your music library" aria-label="Search text" /><button disabled={loading || !term.trim()}>{loading ? "Searching…" : "Search"}</button></form></div>
    {error && <div className="error-box">{error}</div>}
    <div className="card search-results" aria-busy={loading}>
      {results && results.items.length > 0 && <div className="search-results-toolbar"><h2 className="results-count">{activeTitle || `${results.items.length} results`}</h2>{breadcrumbs.length > 0 && <button className="secondary" onClick={goBack}>Back</button>}</div>}
      {loading && !results ? <LibrarySkeleton count={9} /> : results ? results.items.length ? <div className="library-grid">{results.items.map((item) => { const type = browseType(item, scope); return <button key={item.id} onClick={() => void openItem(item)}><LibraryArtwork target={target} item={item} fallback={type === "track" ? "▶" : "♪"} /><span><strong>{item.title || "Untitled"}</strong>{playingId === item.id && <small>Starting…</small>}</span><i>›</i></button>; })}</div> : <div className="empty">No matches found.</div> : <div className="empty">Enter a name above to search your music.</div>}
    </div>
  </section>;
}
