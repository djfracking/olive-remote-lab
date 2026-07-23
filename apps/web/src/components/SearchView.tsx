import { useCallback, useEffect, useRef, useState } from "react";
import type { LibrarySearchScope, MaestroBrowseRequest, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { LibraryArtwork, LibrarySkeleton } from "./LibraryArtwork";
import { indexSearchTree, scopeForItem, SEARCH_INDEX_UPDATED_EVENT, searchLocalIndex, type SearchDocument } from "../searchIndex";
import { readDeviceCache, writeDeviceCache } from "../deviceCache";
import { usePlaybackActions } from "../playback/PlaybackProvider";
import { libraryCatalogIsReady } from "../libraryCatalog";

interface SearchViewProps { connected: boolean; target: OliveDeviceTarget; onStatus: (status: string) => void; onRegisterBack?: (handler: (() => void) | null) => void }
interface SearchResult { key: string; scope: LibrarySearchScope; item: MaestroTreeNode }
interface SearchBreadcrumb { title: string; results: SearchResult[] }
const SCOPES: LibrarySearchScope[] = ["tracks", "artists", "albums", "playlists", "genres"];

function browseType(item: MaestroTreeNode, scope: LibrarySearchScope): MaestroBrowseRequest["type"] {
  const type = item.userData.type?.toLowerCase();
  if (type === "albumname") return "albumname";
  if (type === "artist" || type === "artists" || type === "interpreter") return "artists";
  if (type === "album" || type === "compilation") return "compilation";
  if (type === "playlist") return "playlist";
  if (type === "genre") return "genre";
  if (type === "track" || type === "tracks") return "track";
  if (scope === "tracks") return "track";
  if (scope === "artists") return "artists";
  if (scope === "genres") return "genre";
  if (scope === "playlists") return "playlist";
  return "compilation";
}

function mergeResults(local: SearchDocument[], remote: SearchResult[]): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const document of local) merged.set(document.key, { key: document.key, scope: document.scope, item: document.item });
  for (const result of remote) merged.set(result.key, result);
  return [...merged.values()];
}

export function SearchView({ connected, target, onStatus, onRegisterBack }: SearchViewProps) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState("");
  const [breadcrumbs, setBreadcrumbs] = useState<SearchBreadcrumb[]>([]);
  const [activeTitle, setActiveTitle] = useState("");
  const [indexRevision, setIndexRevision] = useState(0);
  const searchRevision = useRef(0);
  const { playTrack, enqueue } = usePlaybackActions();

  useEffect(() => {
    const key = `${target.host.trim().toLowerCase()}:${target.port}`;
    const refresh = (event: Event) => {
      if (!loading && (event as CustomEvent<{ target?: string }>).detail?.target === key) setIndexRevision((value) => value + 1);
    };
    window.addEventListener(SEARCH_INDEX_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(SEARCH_INDEX_UPDATED_EVENT, refresh);
  }, [loading, target.host, target.port]);

  useEffect(() => {
    const query = term.trim();
    const revision = ++searchRevision.current;
    setLoading(false);
    if (!query) { setResults([]); setSearched(false); return; }
    const timer = window.setTimeout(() => {
      void searchLocalIndex(target, query).then((matches) => {
        if (searchRevision.current !== revision) return;
        setResults(mergeResults(matches, []));
        setSearched(matches.length > 0);
      });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [target.host, target.port, term, indexRevision]);

  async function search() {
    const query = term.trim();
    if (!connected || !query) return;
    const revision = ++searchRevision.current;
    setLoading(true); setError(""); setBreadcrumbs([]); setActiveTitle(""); setSearched(true);
    try {
      const local = await searchLocalIndex(target, query);
      if (searchRevision.current !== revision) return;
      let remote: SearchResult[] = [];
      let merged = mergeResults(local, remote);
      setResults(merged);

      if (await libraryCatalogIsReady(target)) {
        if (searchRevision.current !== revision) return;
        setSearched(true);
        onStatus(`${merged.length} local matches across your library`);
        return;
      }

      const cachedTrees = await Promise.all(SCOPES.map((scope) => readDeviceCache<MaestroTree>(target, `library:search:${scope}:${query.toLowerCase()}`)));
      if (searchRevision.current !== revision) return;
      remote = cachedTrees.flatMap((tree, index) => {
        const scope = SCOPES[index]!;
        return tree?.items.map((item) => ({ key: `${scope}:${item.id}`, scope, item } satisfies SearchResult)) ?? [];
      });
      merged = mergeResults(local, remote);
      setResults(merged);

      let failures = 0;
      for (const scope of SCOPES) {
        if (searchRevision.current !== revision) return;
        try {
          onStatus(`Searching ${scope}…`);
          const response = await appFetch("/api/library/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, term: query, scope }) });
          const data = await response.json() as MaestroTree & { error?: string };
          if (!response.ok) throw new Error(data.error ?? `${scope} search failed.`);
          if (searchRevision.current !== revision) return;
          void writeDeviceCache(target, `library:search:${scope}:${query.toLowerCase()}`, data);
          void indexSearchTree(target, data, scope);
          remote = [
            ...remote.filter((result) => result.scope !== scope),
            ...data.items.map((item) => ({ key: `${scope}:${item.id}`, scope, item } satisfies SearchResult)),
          ];
          merged = mergeResults(local, remote);
          setResults(merged);
        } catch {
          failures += 1;
        }
      }
      if (searchRevision.current !== revision) return;
      if (failures === 0) {
        merged = remote;
        setResults(merged);
      }
      if (failures === SCOPES.length && !merged.length) setError("Your Olive could not complete this search.");
      onStatus(`${merged.length} matches across your library`);
    } finally {
      if (searchRevision.current === revision) setLoading(false);
    }
  }

  async function openItem(result: SearchResult) {
    const { item, scope } = result;
    const type = browseType(item, scope);
    if (type === "track" && item.id !== "tracks") { await play(item); return; }
    setLoading(true); setError("");
    try {
      const response = await appFetch("/api/library/browse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, browse: { id: item.id, type, startIndex: 0, index: 0 } }) });
      const data = await response.json() as MaestroTree & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not open this result.");
      void indexSearchTree(target, data);
      setBreadcrumbs((trail) => [...trail, { title: activeTitle || "Search results", results }]);
      setActiveTitle(item.title || "Search result");
      setResults(data.items.map((child) => { const childScope = scopeForItem(child, scope); return { key: `${childScope}:${child.id}`, scope: childScope, item: child }; }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open this result."); }
    finally { setLoading(false); }
  }

  const goBack = useCallback(() => {
    setBreadcrumbs((trail) => {
      const previous = trail.at(-1);
      if (!previous) return trail;
      setResults(previous.results);
      setActiveTitle(previous.title === "Search results" ? "" : previous.title);
      return trail.slice(0, -1);
    });
    setError("");
  }, []);

  useEffect(() => {
    onRegisterBack?.(breadcrumbs.length ? goBack : null);
    return () => onRegisterBack?.(null);
  }, [breadcrumbs.length, goBack, onRegisterBack]);

  async function play(item: MaestroTreeNode) {
    setPlayingId(item.id); setError("");
    try {
      const context = results.filter((result) => result.scope === "tracks").map((result) => result.item);
      await playTrack(item, context.length ? context : [item]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;
  return <section className="module-stack">
    <div className="card search-hero"><form onSubmit={(event) => { event.preventDefault(); void search(); }}><input autoFocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Artists, songs, albums and playlists" aria-label="Search your music library" /><button disabled={loading || !term.trim()}>{loading ? "Searching…" : "Search"}</button></form></div>
    {error && <div className="error-box">{error}</div>}
    <div className="card search-results" aria-busy={loading}>
      {results.length > 0 && <div className="search-results-toolbar"><h2 className="results-count">{activeTitle || `${results.length} results`}</h2>{breadcrumbs.length > 0 && <button className="secondary" onClick={goBack}>Back</button>}</div>}
      {loading && !results.length ? <LibrarySkeleton count={9} /> : results.length ? <div className="library-grid">{results.map((result) => <div className="library-item" key={result.key}><button onClick={() => void openItem(result)}><LibraryArtwork target={target} item={result.item} fallback={result.scope === "tracks" ? "▶" : "♪"} /><span><strong>{result.item.title || "Untitled"}</strong><small>{playingId === result.item.id ? "Starting…" : result.scope.slice(0, -1)}</small></span><i>›</i></button>{result.scope === "tracks" && <button className="queue-add" onClick={() => { enqueue(result.item); onStatus(`${result.item.title} added to queue`); }} aria-label={`Add ${result.item.title} to queue`}>+</button>}</div>)}</div> : searched ? <div className="empty">No matches found.</div> : <div className="empty">Search everything on your Olive.</div>}
    </div>
  </section>;
}
