import { useCallback, useEffect, useRef, useState } from "react";
import type { LibrarySearchScope, MaestroBrowseRequest, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { LibraryArtwork, LibrarySkeleton } from "./LibraryArtwork";
import { indexSearchTree, scopeForItem, SEARCH_INDEX_UPDATED_EVENT, searchLocalIndex, type SearchDocument } from "../searchIndex";
import { readDeviceCache, writeDeviceCache } from "../deviceCache";
import { deviceCacheNamespace, deviceRequestKey, type StableOliveTarget } from "../deviceIdentity";
import { usePlaybackActions } from "../playback/PlaybackProvider";
import { LIBRARY_SEARCH_SCOPES, missingLibrarySearchScopes, readLibraryCatalogManifest } from "../libraryCatalog";
import { resolveMaestroPlaybackNode } from "../playbackIdentity";
import { playbackContextForSelection } from "../playback/playbackContext";
import {
  isUpnpTreeNode,
  libraryScopeLabel,
  scopeForUpnpTreeNode,
  shouldApplyUpnpPageResponse,
  targetSupportsContentDirectory,
  upnpPageCursor,
  upnpPageToTree,
  type UpnpCatalogPage,
  type UpnpPageCursor,
} from "../upnpCatalog";

interface SearchViewProps { connected: boolean; target: OliveDeviceTarget; onStatus: (status: string) => void; onRegisterBack?: (handler: (() => void) | null) => void }
interface SearchResult { key: string; scope: LibrarySearchScope; item: MaestroTreeNode }
type ActiveUpnpPage =
  | { kind: "search"; query: string; fallbackScope: LibrarySearchScope; cursor: UpnpPageCursor }
  | { kind: "browse"; objectId: string; scope: LibrarySearchScope; cursor: UpnpPageCursor };
interface SearchBreadcrumb { title: string; results: SearchResult[]; page: ActiveUpnpPage | null }

export function shouldApplyRootSearch(
  expectedRevision: number,
  currentRevision: number,
  browseDepth: number,
  browseOpening = false,
): boolean {
  return expectedRevision === currentRevision && browseDepth === 0 && !browseOpening;
}

export function nextCatalogPage(startingIndex: number, numberReturned: number): number {
  return startingIndex + numberReturned;
}

export function serverSearchRequired(manifest: {
  complete?: boolean;
} | null, missingScopeCount: number): boolean {
  return manifest?.complete !== true || missingScopeCount > 0;
}

function pageLoadIdentity(page: ActiveUpnpPage | null): string | null {
  return page ? `${page.cursor.requestIdentity}@${page.cursor.nextStartingIndex}` : null;
}

function scopeFromOliveId(id: string): LibrarySearchScope | null {
  const marker = id.toUpperCase().match(/_(AR|AL|TR)\d+$/)?.[1];
  if (marker === "AR") return "artists";
  if (marker === "AL") return "albums";
  if (marker === "TR") return "tracks";
  return null;
}

export function searchResultScope(item: MaestroTreeNode, fallback: LibrarySearchScope): LibrarySearchScope {
  if (isUpnpTreeNode(item)) return scopeForUpnpTreeNode(item, fallback);
  return scopeFromOliveId(item.id) ?? scopeForItem(item, fallback);
}

export function searchResultBrowseType(item: MaestroTreeNode, fallback: LibrarySearchScope): MaestroBrowseRequest["type"] {
  const scope = searchResultScope(item, fallback);
  if (scope === "tracks") return "track";
  if (scope === "artists") return "artists";
  if (scope === "composers") return "composer";
  if (scope === "genres") return "genre";
  if (scope === "playlists") return "playlist";
  return "compilation";
}

function searchResult(item: MaestroTreeNode, fallback: LibrarySearchScope): SearchResult {
  const scope = searchResultScope(item, fallback);
  return { key: searchResultIdentity(item, scope), scope, item };
}

export function searchResultIdentity(item: MaestroTreeNode, scope: LibrarySearchScope): string {
  if (scope === "tracks" && isUpnpTreeNode(item)) {
    const trackId = (item.userData.upnpId || item.id).match(/_TR([0-9]+)$/)?.[1];
    if (trackId) return `tracks:upnp-track:${trackId}`;
  }
  return `${scope}:${item.userData.source ?? "maestro"}:${item.userData.upnpId ?? item.id}`;
}

function isPlayableSearchResult(result: SearchResult): boolean {
  return searchResultBrowseType(result.item, result.scope) === "track"
    && result.item.id !== "tracks"
    && !(isUpnpTreeNode(result.item) && result.item.userData.objectKind === "container");
}

function mergeResults(local: SearchDocument[], remote: SearchResult[]): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const document of local) {
    const result = searchResult(document.item, document.scope);
    merged.set(result.key, result);
  }
  for (const result of remote) {
    const normalized = searchResult(result.item, result.scope);
    merged.set(normalized.key, normalized);
  }
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
  const [activeUpnpPage, setActiveUpnpPage] = useState<ActiveUpnpPage | null>(null);
  const [indexRevision, setIndexRevision] = useState(0);
  const searchRevision = useRef(0);
  const browseDepth = useRef(0);
  const browseOpening = useRef(false);
  const activeUpnpPageRef = useRef<ActiveUpnpPage | null>(null);
  const pageLoadActive = useRef(false);
  const handledIndexRevision = useRef(0);
  const { playTrack, enqueue } = usePlaybackActions();
  const targetNamespace = deviceCacheNamespace(target as StableOliveTarget);
  const targetRequestKey = deviceRequestKey(target as StableOliveTarget);
  const targetRequestKeyRef = useRef(targetRequestKey);
  targetRequestKeyRef.current = targetRequestKey;

  const commitActiveUpnpPage = useCallback((next: ActiveUpnpPage | null) => {
    activeUpnpPageRef.current = next;
    setActiveUpnpPage(next);
  }, []);

  useEffect(() => {
    ++searchRevision.current;
    browseDepth.current = 0;
    browseOpening.current = false;
    setBreadcrumbs([]);
    setActiveTitle("");
    commitActiveUpnpPage(null);
    setLoading(false);
    setResults([]);
    setSearched(false);
  }, [commitActiveUpnpPage, targetRequestKey]);

  useEffect(() => {
    const key = targetNamespace;
    const refresh = (event: Event) => {
      if (!loading && !browseOpening.current && browseDepth.current === 0 && (event as CustomEvent<{ target?: string }>).detail?.target === key) {
        setIndexRevision((value) => value + 1);
      }
    };
    window.addEventListener(SEARCH_INDEX_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(SEARCH_INDEX_UPDATED_EVENT, refresh);
  }, [loading, targetNamespace]);

  useEffect(() => {
    const query = term.trim();
    const revision = ++searchRevision.current;
    const expectedNamespace = targetRequestKey;
    setLoading(false);
    if (!query) {
      commitActiveUpnpPage(null);
      setResults([]);
      setSearched(false);
      return;
    }
    commitActiveUpnpPage(null);
    const localTimer = window.setTimeout(() => {
      void searchLocalIndex(target, query).then((matches) => {
        if (
          targetRequestKeyRef.current !== expectedNamespace
          || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
        ) return;
        setResults((current) => mergeResults(matches, current));
        setSearched(matches.length > 0);
      });
    }, 90);
    const remoteTimer = window.setTimeout(() => {
      if (!connected || !targetSupportsContentDirectory(target as StableOliveTarget)) return;
      void (async () => {
        const manifest = await readLibraryCatalogManifest(target);
        const missingScopes = missingLibrarySearchScopes(manifest);
        if (!serverSearchRequired(manifest, missingScopes.length)) return;
        if (
          targetRequestKeyRef.current !== expectedNamespace
          || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
        ) return;
        setLoading(true);
        try {
          const requestIdentity = `search:${expectedNamespace}:${query.toLocaleLowerCase()}`;
          const [local, response] = await Promise.all([
            searchLocalIndex(target, query),
            appFetch("/api/upnp/search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ target, term: query, requestedCount: 64 }),
            }),
          ]);
          const data = await response.json() as UpnpCatalogPage & { error?: string };
          if (!response.ok) throw new Error(data.error ?? "UPnP search failed.");
          if (
            targetRequestKeyRef.current !== expectedNamespace
            || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
          ) return;
          const cursor = upnpPageCursor("search", requestIdentity, 0, 64, data);
          const tree = upnpPageToTree(target as StableOliveTarget, data, "albums");
          const remote = tree.items.map((item) => searchResult(item, "albums"));
          setResults(mergeResults(local, remote));
          commitActiveUpnpPage(cursor.complete ? null : {
            kind: "search",
            query,
            fallbackScope: "albums",
            cursor,
          });
          setSearched(true);
        } catch {
          // The durable local index remains useful while a foreground server
          // search is temporarily unavailable.
        } finally {
          if (
            targetRequestKeyRef.current === expectedNamespace
            && shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
          ) setLoading(false);
        }
      })();
    }, 280);
    return () => {
      window.clearTimeout(localTimer);
      window.clearTimeout(remoteTimer);
    };
  }, [commitActiveUpnpPage, connected, targetNamespace, targetRequestKey, term]);

  useEffect(() => {
    if (handledIndexRevision.current === indexRevision) return;
    handledIndexRevision.current = indexRevision;
    const query = term.trim();
    if (!query || browseDepth.current !== 0 || browseOpening.current) return;
    const revision = searchRevision.current;
    const expectedNamespace = targetRequestKey;
    void searchLocalIndex(target, query).then((matches) => {
      if (
        targetRequestKeyRef.current !== expectedNamespace
        || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
      ) return;
      setResults((current) => mergeResults(matches, current));
      if (matches.length) setSearched(true);
    });
  }, [indexRevision, targetNamespace, targetRequestKey, term]);

  async function search() {
    const query = term.trim();
    if (!connected || !query) return;
    browseDepth.current = 0;
    browseOpening.current = false;
    const revision = ++searchRevision.current;
    const expectedNamespace = targetRequestKey;
    setLoading(true); setError(""); setBreadcrumbs([]); setActiveTitle(""); commitActiveUpnpPage(null); setSearched(true);
    try {
      const local = await searchLocalIndex(target, query);
      if (
        targetRequestKeyRef.current !== expectedNamespace
        || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
      ) return;
      let remote: SearchResult[] = [];
      let merged = mergeResults(local, remote);
      setResults(merged);

      const manifest = await readLibraryCatalogManifest(target);
      const missingScopes = missingLibrarySearchScopes(manifest);
      if (!serverSearchRequired(manifest, missingScopes.length)) {
        if (
          targetRequestKeyRef.current !== expectedNamespace
          || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
        ) return;
        setSearched(true);
        onStatus(`${merged.length} local matches across your library`);
        return;
      }
      const remoteScopes = missingScopes.length ? missingScopes : [...LIBRARY_SEARCH_SCOPES];

      if (targetSupportsContentDirectory(target as StableOliveTarget)) {
        onStatus("Searching the Olive…");
        const requestIdentity = `search:${expectedNamespace}:${query.toLocaleLowerCase()}`;
        const response = await appFetch("/api/upnp/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target, term: query, requestedCount: 64 }),
        });
        const data = await response.json() as UpnpCatalogPage & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Your Olive could not complete this search.");
        if (
          targetRequestKeyRef.current !== expectedNamespace
          || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
        ) return;
        const cursor = upnpPageCursor("search", requestIdentity, 0, 64, data);
        const tree = upnpPageToTree(target as StableOliveTarget, data, "albums");
        remote = tree.items.map((item) => searchResult(item, "albums"));
        merged = mergeResults(local, remote);
        setResults(merged);
        commitActiveUpnpPage(cursor.complete ? null : {
          kind: "search",
          query,
          fallbackScope: "albums",
          cursor,
        });
        onStatus(`${merged.length} matches across your library`);
        return;
      }

      const cachedTrees = await Promise.all(remoteScopes.map((scope) => readDeviceCache<MaestroTree>(target, `library:search:${scope}:${query.toLowerCase()}`)));
      if (
        targetRequestKeyRef.current !== expectedNamespace
        || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
      ) return;
      remote = cachedTrees.flatMap((tree, index) => {
        const scope = remoteScopes[index]!;
        return tree?.items.map((item) => searchResult(item, scope)) ?? [];
      });
      merged = mergeResults(local, remote);
      setResults(merged);

      let failures = 0;
      for (const scope of remoteScopes) {
        if (
          targetRequestKeyRef.current !== expectedNamespace
          || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
        ) return;
        try {
          onStatus(`Searching ${scope}…`);
          const response = await appFetch("/api/library/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, term: query, scope }) });
          const data = await response.json() as MaestroTree & { error?: string };
          if (!response.ok) throw new Error(data.error ?? `${scope} search failed.`);
          if (
            targetRequestKeyRef.current !== expectedNamespace
            || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
          ) return;
          void writeDeviceCache(target, `library:search:${scope}:${query.toLowerCase()}`, data);
          void indexSearchTree(target, data, scope);
          remote = [
            ...remote.filter((result) => result.scope !== scope),
            ...data.items.map((item) => searchResult(item, scope)),
          ];
          merged = mergeResults(local, remote);
          setResults(merged);
        } catch {
          failures += 1;
        }
      }
      if (
        targetRequestKeyRef.current !== expectedNamespace
        || !shouldApplyRootSearch(revision, searchRevision.current, browseDepth.current, browseOpening.current)
      ) return;
      if (failures === 0) {
        merged = mergeResults(local, remote);
        setResults(merged);
      }
      if (failures === remoteScopes.length && !merged.length) setError("Your Olive could not complete this search.");
      onStatus(`${merged.length} matches across your library`);
    } finally {
      if (searchRevision.current === revision && targetRequestKeyRef.current === expectedNamespace) setLoading(false);
    }
  }

  async function openItem(result: SearchResult) {
    const { item, scope } = result;
    const type = searchResultBrowseType(item, scope);
    if (isPlayableSearchResult(result)) { await play(item); return; }
    const revision = ++searchRevision.current;
    const expectedNamespace = targetRequestKey;
    const sourceResults = results;
    const sourcePage = activeUpnpPageRef.current;
    browseOpening.current = true;
    setLoading(true); setError("");
    try {
      const upnp = isUpnpTreeNode(item);
      const upnpObjectId = item.userData.upnpId || item.id;
      const response = upnp
        ? await appFetch("/api/upnp/browse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target, objectId: upnpObjectId, startingIndex: 0, requestedCount: 64 }),
        })
        : await appFetch("/api/library/browse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target, browse: { id: item.id, type, startIndex: 0, index: 0 } }),
        });
      const raw = await response.json() as (MaestroTree | UpnpCatalogPage) & { error?: string };
      if (searchRevision.current !== revision || targetRequestKeyRef.current !== expectedNamespace) return;
      if (!response.ok) throw new Error(raw.error ?? "Could not open this result.");
      const requestIdentity = `browse:${expectedNamespace}:${upnpObjectId}:${scope}`;
      const cursor = upnp
        ? upnpPageCursor("browse", requestIdentity, 0, 64, raw as UpnpCatalogPage)
        : null;
      const data = upnp
        ? upnpPageToTree(target as StableOliveTarget, raw as UpnpCatalogPage, scope)
        : raw as MaestroTree;
      browseDepth.current += 1;
      browseOpening.current = false;
      if (!upnp) void indexSearchTree(target, data);
      setBreadcrumbs((trail) => [...trail, {
        title: activeTitle || "Search results",
        results: sourceResults,
        page: sourcePage,
      }]);
      setActiveTitle(item.title || "Search result");
      setResults(data.items.map((child) => searchResult(child, scope)));
      if (cursor) {
        commitActiveUpnpPage(cursor.complete ? null : {
          kind: "browse",
          objectId: upnpObjectId,
          scope,
          cursor,
        });
      } else {
        commitActiveUpnpPage(null);
      }
    } catch (reason) {
      if (searchRevision.current === revision && targetRequestKeyRef.current === expectedNamespace) {
        setError(reason instanceof Error ? reason.message : "Could not open this result.");
      }
    } finally {
      if (searchRevision.current === revision && targetRequestKeyRef.current === expectedNamespace) {
        browseOpening.current = false;
        setLoading(false);
      }
    }
  }

  async function loadMore() {
    const activePage = activeUpnpPageRef.current;
    if (!activePage || loading || pageLoadActive.current) return;
    pageLoadActive.current = true;
    const revision = searchRevision.current;
    const expectedNamespace = targetRequestKey;
    const expectedPageIdentity = pageLoadIdentity(activePage);
    const startingIndex = activePage.cursor.nextStartingIndex;
    const requestedCount = activePage.cursor.requestedCount;
    setLoading(true); setError("");
    try {
      const response = await appFetch(activePage.kind === "search" ? "/api/upnp/search" : "/api/upnp/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activePage.kind === "search"
          ? { target, term: activePage.query, startingIndex, requestedCount }
          : { target, objectId: activePage.objectId, startingIndex, requestedCount }),
      });
      const responsePage = await response.json() as UpnpCatalogPage & { error?: string };
      if (!response.ok) throw new Error(responsePage.error ?? "Could not load more results.");
      if (!shouldApplyUpnpPageResponse(
        revision,
        searchRevision.current,
        expectedNamespace,
        targetRequestKeyRef.current,
        expectedPageIdentity ?? "",
        pageLoadIdentity(activeUpnpPageRef.current),
      )) return;
      const fallbackScope = activePage.kind === "search" ? activePage.fallbackScope : activePage.scope;
      const cursor = upnpPageCursor(
        activePage.kind,
        activePage.cursor.requestIdentity,
        startingIndex,
        requestedCount,
        responsePage,
      );
      const nextTree = upnpPageToTree(target as StableOliveTarget, responsePage, fallbackScope);
      setResults((current) => {
        const merged = new Map(current.map((result) => [result.key, result]));
        for (const item of nextTree.items) {
          const result = searchResult(item, fallbackScope);
          merged.set(result.key, result);
        }
        return [...merged.values()];
      });
      commitActiveUpnpPage(cursor.complete ? null : { ...activePage, cursor });
    } catch (reason) {
      if (
        searchRevision.current === revision
        && targetRequestKeyRef.current === expectedNamespace
        && pageLoadIdentity(activeUpnpPageRef.current) === expectedPageIdentity
      ) {
        setError(reason instanceof Error ? reason.message : "Could not load more results.");
      }
    } finally {
      pageLoadActive.current = false;
      if (searchRevision.current === revision && targetRequestKeyRef.current === expectedNamespace) setLoading(false);
    }
  }

  function changeTerm(value: string) {
    ++searchRevision.current;
    browseDepth.current = 0;
    browseOpening.current = false;
    setBreadcrumbs([]);
    setActiveTitle("");
    commitActiveUpnpPage(null);
    setError("");
    setResults([]);
    setSearched(false);
    setTerm(value);
  }

  const goBack = useCallback(() => {
    ++searchRevision.current;
    browseOpening.current = false;
    setLoading(false);
    browseDepth.current = Math.max(0, browseDepth.current - 1);
    setBreadcrumbs((trail) => {
      const previous = trail.at(-1);
      if (!previous) return trail;
      setResults(previous.results);
      setActiveTitle(previous.title === "Search results" ? "" : previous.title);
      commitActiveUpnpPage(previous.page);
      return trail.slice(0, -1);
    });
    setError("");
  }, [commitActiveUpnpPage]);

  useEffect(() => {
    onRegisterBack?.(breadcrumbs.length ? goBack : null);
    return () => onRegisterBack?.(null);
  }, [breadcrumbs.length, goBack, onRegisterBack]);

  async function play(item: MaestroTreeNode) {
    setPlayingId(item.id); setError("");
    try {
      const playable = await resolveMaestroPlaybackNode(target, item);
      const candidates = results
        .filter((result) => result.scope === "tracks")
        .map((result) => result.item);
      const context = isUpnpTreeNode(item)
        ? [playable]
        : playbackContextForSelection(
          item,
          candidates,
          breadcrumbs.length ? "explicit" : "automatic",
        );
      await playTrack(playable, context.length ? context : [playable]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  async function queue(item: MaestroTreeNode) {
    setError("");
    try {
      const playable = await resolveMaestroPlaybackNode(target, item);
      enqueue(playable);
      onStatus(`${item.title} added to queue`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add this track to the queue.");
    }
  }

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;
  return <section className="module-stack">
    <div className="card search-hero"><form onSubmit={(event) => { event.preventDefault(); void search(); }}><input autoFocus value={term} onChange={(event) => changeTerm(event.target.value)} placeholder="Artists, songs, albums, playlists and composers" aria-label="Search your music library" /><button disabled={loading || !term.trim()}>{loading ? "Searching…" : "Search"}</button></form></div>
    {error && <div className="error-box">{error}</div>}
    <div className="card search-results" aria-busy={loading}>
      {results.length > 0 && <div className="search-results-toolbar"><h2 className="results-count">{activeTitle || `${results.length} results`}</h2>{breadcrumbs.length > 0 && <button className="secondary" onClick={goBack}>Back</button>}</div>}
      {loading && !results.length ? <LibrarySkeleton count={9} /> : results.length ? <><div className="library-grid">{results.map((result) => <div className="library-item" key={result.key}><button onClick={() => void openItem(result)}><LibraryArtwork target={target} item={result.item} fallback={isPlayableSearchResult(result) ? "▶" : "♪"} /><span><strong>{result.item.title || "Untitled"}</strong><small>{playingId === result.item.id ? "Starting…" : libraryScopeLabel(result.scope)}</small></span><i>›</i></button>{isPlayableSearchResult(result) && <button className="queue-add" onClick={() => { void queue(result.item); }} aria-label={`Add ${result.item.title} to queue`}>+</button>}</div>)}</div>{activeUpnpPage && <button className="secondary search-load-more" disabled={loading} onClick={() => void loadMore()}>{loading ? "Loading…" : activeUpnpPage.cursor.totalMatches === null ? `Load more · ${activeUpnpPage.cursor.nextStartingIndex} server results` : `Load more · ${Math.min(activeUpnpPage.cursor.nextStartingIndex, activeUpnpPage.cursor.totalMatches)} of ${activeUpnpPage.cursor.totalMatches} server results`}</button>}</> : searched ? <div className="empty">No matches found.</div> : <div className="empty">Search everything on your Olive.</div>}
    </div>
  </section>;
}
