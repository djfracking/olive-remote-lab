import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LibrarySearchScope, MaestroBrowseRequest, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "../nativeApi";
import { LibraryArtwork, LibrarySkeleton } from "./LibraryArtwork";
import { readDeviceCache, writeDeviceCache } from "../deviceCache";
import { deviceRequestKey, type StableOliveTarget } from "../deviceIdentity";
import { indexSearchTree, readSearchScope } from "../searchIndex";
import {
  ARTIST_INDEX_RESOURCE,
  artistIndexMatchesCatalog,
  readLibraryCatalogManifest,
  type ArtistIndexCache,
} from "../libraryCatalog";
import { usePlaybackActions } from "../playback/PlaybackProvider";
import { resolveMaestroPlaybackNode } from "../playbackIdentity";
import { playbackContextForSelection } from "../playback/playbackContext";
import { alphabetizeLibraryItems } from "../librarySorting";
import {
  UPNP_CATALOG_ROOTS,
  isUpnpTreeNode,
  libraryScopeLabel,
  scopeForUpnpTreeNode,
  shouldApplyUpnpPageResponse,
  targetSupportsContentDirectory,
  upnpPageCursor,
  upnpPageToTree,
  type UpnpCatalogPage,
} from "../upnpCatalog";

interface LibraryViewProps {
  connected: boolean;
  target: OliveDeviceTarget;
  onStatus: (status: string) => void;
  onRegisterBack?: (handler: (() => void) | null) => void;
}

export interface BrowsePageState {
  requestIdentity: string;
  startingIndex: number;
  requestedCount: number;
  numberReturned: number;
  nextStartingIndex: number;
  totalItems: number | null;
  previousStartingIndices: number[];
}

interface BrowsePageCache {
  version: 1;
  tree: MaestroTree;
  page: BrowsePageState;
}

interface Breadcrumb {
  title: string;
  tree: MaestroTree;
  activeNode: MaestroTreeNode | null;
  page: BrowsePageState | null;
}

const ALPHABET = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const ARTIST_PAGE_SIZE = 21;
const MAX_ARTIST_ITEMS = 150_000;

export function artistInitial(title: string) {
  const first = title.trim().charAt(0).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await appFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Library request failed.");
  return data;
}

async function postWithSignal<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await appFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Library request failed.");
  return data;
}

export function browsePageState(
  requestIdentity: string,
  startingIndex: number,
  requestedCount: number,
  numberReturned: number,
  totalItems: number | null,
  previousStartingIndices: number[] = [],
): BrowsePageState {
  if (!requestIdentity.trim()) throw new Error("A browse page identity is required.");
  if (!Number.isSafeInteger(startingIndex) || startingIndex < 0) throw new Error("Invalid browse StartingIndex.");
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) throw new Error("Invalid browse RequestedCount.");
  if (!Number.isSafeInteger(numberReturned) || numberReturned < 0) throw new Error("Invalid browse NumberReturned.");
  if (totalItems !== null && (!Number.isSafeInteger(totalItems) || totalItems < 0)) throw new Error("Invalid browse total.");
  return {
    requestIdentity,
    startingIndex,
    requestedCount,
    numberReturned,
    nextStartingIndex: startingIndex + numberReturned,
    totalItems,
    previousStartingIndices: [...previousStartingIndices],
  };
}

function isBrowsePageCache(
  value: BrowsePageCache | null,
  requestIdentity: string,
  startingIndex: number,
): value is BrowsePageCache {
  return value?.version === 1
    && value.page?.requestIdentity === requestIdentity
    && value.page.startingIndex === startingIndex
    && Array.isArray(value.tree?.items);
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function browseType(node: MaestroTreeNode): MaestroBrowseRequest["type"] | null {
  const type = node.userData.type?.toLowerCase();
  if (type === "albumname") return "albumname";
  if (type === "artist" || type === "artists" || type === "interpreter") return "artists";
  if (type === "album" || type === "compilation") return "compilation";
  if (type === "composer" || type === "composers") return "composer";
  if (type === "playlist") return "playlist";
  if (type === "genre") return "genre";
  if (type === "track" || type === "tracks") return "track";
  return null;
}

function isArtistRoot(node: MaestroTreeNode | null): node is MaestroTreeNode {
  if (!node) return false;
  const id = node.id.trim().toUpperCase();
  return id === "ARTISTS" || id === "ROOT_ALLAR";
}

function isTrackRoot(node: MaestroTreeNode | null): node is MaestroTreeNode {
  if (!node) return false;
  const id = node.id.trim().toUpperCase();
  return id === "TRACKS" || id === "ROOT_ALLAU";
}

function isPlayableTrackNode(node: MaestroTreeNode): boolean {
  return browseType(node) === "track"
    && node.id !== "tracks"
    && !(isUpnpTreeNode(node) && node.userData.objectKind === "container");
}

function isBroadTrackListing(node: MaestroTreeNode | null): boolean {
  if (!node) return true;
  const id = node.id.trim().toUpperCase();
  return id === "TRACKS" || id === "ROOT_ALLAU";
}

function libraryNodeScope(node: MaestroTreeNode): LibrarySearchScope {
  const type = browseType(node);
  const fallback: LibrarySearchScope = type === "artists" ? "artists"
    : type === "composer" ? "composers"
      : type === "genre" ? "genres"
        : type === "playlist" ? "playlists"
          : type === "track" ? "tracks"
            : "albums";
  return isUpnpTreeNode(node) ? scopeForUpnpTreeNode(node, fallback) : fallback;
}

function upnpLibraryRoot(): MaestroTree {
  const roots: Array<[keyof typeof UPNP_CATALOG_ROOTS, string, string]> = [
    ["artists", "Artists", "artists"],
    ["albums", "Albums", "albumname"],
    ["tracks", "Tracks", "track"],
    ["genres", "Genres", "genre"],
    ["playlists", "Playlists", "playlist"],
    ["composers", "Composers", "composer"],
  ];
  return {
    id: "0",
    totalItems: roots.length,
    items: roots.map(([scope, title, type]) => ({
      id: UPNP_CATALOG_ROOTS[scope],
      title,
      childCount: null,
      userData: {
        type,
        source: "upnp",
        objectKind: "container",
        upnpId: UPNP_CATALOG_ROOTS[scope],
        upnpClass: "object.container",
      },
    })),
  };
}

export function LibraryView({ connected, target, onStatus, onRegisterBack }: LibraryViewProps) {
  const [tree, setTree] = useState<MaestroTree | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState<BrowsePageState | null>(null);
  const [activeNode, setActiveNode] = useState<MaestroTreeNode | null>(null);
  const [playingId, setPlayingId] = useState("");
  const autoLoadedTarget = useRef("");
  const artistLoadController = useRef<AbortController | null>(null);
  const viewRevision = useRef(0);
  const activeBrowseRequest = useRef<string | null>(null);
  const artistIndexRef = useRef<HTMLElement>(null);
  const scrubPointerId = useRef<number | null>(null);
  const lastScrubLetter = useRef("");
  const { playTrack: playCanonicalTrack, enqueue } = usePlaybackActions();
  const targetRequestKey = deviceRequestKey(target as StableOliveTarget);
  const targetRequestKeyRef = useRef(targetRequestKey);
  targetRequestKeyRef.current = targetRequestKey;

  function requestIsCurrent(
    revision: number,
    expectedNamespace: string,
    requestIdentity: string,
  ): boolean {
    return shouldApplyUpnpPageResponse(
      revision,
      viewRevision.current,
      expectedNamespace,
      targetRequestKeyRef.current,
      requestIdentity,
      activeBrowseRequest.current,
    );
  }

  async function loadRoot() {
    if (!connected) return;
    const revision = ++viewRevision.current;
    const expectedNamespace = targetRequestKey;
    const requestIdentity = `root:${expectedNamespace}`;
    activeBrowseRequest.current = requestIdentity;
    artistLoadController.current?.abort();
    artistLoadController.current = null;
    setLoading(true); setError("");
    if (targetSupportsContentDirectory(target as StableOliveTarget)) {
      const result = upnpLibraryRoot();
      if (!requestIsCurrent(revision, expectedNamespace, requestIdentity)) return;
      setTree(result); setBreadcrumbs([]); setActiveNode(null); setPage(null); setLoading(false);
      onStatus("Artists, albums, tracks, genres, playlists and composers available");
      return;
    }
    const resource = "library:navigation";
    const cached = await readDeviceCache<MaestroTree>(target, resource);
    if (cached && requestIsCurrent(revision, expectedNamespace, requestIdentity)) {
      setTree(cached); setBreadcrumbs([]); setActiveNode(null); setPage(null); setLoading(false);
    }
    try {
      const result = await post<MaestroTree>("/api/library/navigation", target);
      if (!requestIsCurrent(revision, expectedNamespace, requestIdentity)) return;
      setTree(result); setBreadcrumbs([]); setActiveNode(null); setPage(null);
      void writeDeviceCache(target, resource, result);
      void indexSearchTree(target, result);
      onStatus(`${result.items.length} library sections available`);
    } catch (reason) {
      if (requestIsCurrent(revision, expectedNamespace, requestIdentity)) {
        setError(reason instanceof Error ? reason.message : "Library unavailable.");
      }
    } finally {
      if (requestIsCurrent(revision, expectedNamespace, requestIdentity)) setLoading(false);
    }
  }

  useEffect(() => {
    const key = connected
      ? `${targetRequestKey}|${targetSupportsContentDirectory(target as StableOliveTarget) ? "upnp" : "legacy"}`
      : "";
    if (!key) {
      ++viewRevision.current;
      activeBrowseRequest.current = null;
      artistLoadController.current?.abort();
      artistLoadController.current = null;
      autoLoadedTarget.current = "";
      return;
    }
    if (autoLoadedTarget.current === key) return;
    autoLoadedTarget.current = key;
    void loadRoot();
  }, [connected, targetRequestKey]);

  useEffect(() => () => {
    artistLoadController.current?.abort();
    artistLoadController.current = null;
  }, []);

  async function openArtistIndex(node: MaestroTreeNode, refresh = false) {
    const revision = ++viewRevision.current;
    const expectedNamespace = targetRequestKey;
    const requestIdentity = `artist-index:${expectedNamespace}:${node.userData.upnpId || node.id}`;
    activeBrowseRequest.current = requestIdentity;
    artistLoadController.current?.abort();
    const controller = new AbortController();
    artistLoadController.current = controller;
    const sourceTree = tree;
    const sourceActiveNode = activeNode;
    const sourcePage = page;
    let breadcrumbCommitted = refresh;
    const showTree = (nextTree: MaestroTree) => {
      if (!requestIsCurrent(revision, expectedNamespace, requestIdentity) || controller.signal.aborted) return;
      if (!breadcrumbCommitted) {
        breadcrumbCommitted = true;
        if (sourceTree) setBreadcrumbs((trail) => [...trail, {
          title: node.title,
          tree: sourceTree,
          activeNode: sourceActiveNode,
          page: sourcePage,
        }]);
      }
      setTree(nextTree);
      setActiveNode(node);
      setPage(null);
    };

    setLoading(true);
    setError("");
    try {
      if (!refresh) {
        const [manifest, cached] = await Promise.all([
          readLibraryCatalogManifest(target),
          readDeviceCache<ArtistIndexCache>(target, ARTIST_INDEX_RESOURCE),
        ]);
        if (!requestIsCurrent(revision, expectedNamespace, requestIdentity) || controller.signal.aborted) return;
        if (artistIndexMatchesCatalog(cached, manifest)) {
          showTree(cached.tree);
          setLoading(false);
          onStatus(`${node.title}: ${cached.tree.items.length.toLocaleString()} artists available`);
          return;
        }
      }

      const items = new Map<string, MaestroTreeNode>();
      const pageSignatures = new Set<string>();
      let startIndex = 0;
      let reportedTotal: number | null = null;
      let treeId = node.id;
      let complete = false;
      let incompleteReason = "";
      const useUpnp = targetSupportsContentDirectory(target as StableOliveTarget);
      const pageSize = useUpnp ? 64 : ARTIST_PAGE_SIZE;
      let pageIndex = 0;

      while (startIndex < MAX_ARTIST_ITEMS) {
        if (!requestIsCurrent(revision, expectedNamespace, requestIdentity) || controller.signal.aborted) return;
        let result: MaestroTree;
        let numberReturned: number;
        let nextStartIndex: number;
        let upnpPageComplete = false;
        if (useUpnp) {
          const rawPage = await postWithSignal<UpnpCatalogPage>("/api/upnp/browse", {
              target,
              objectId: node.userData.upnpId || UPNP_CATALOG_ROOTS.artists,
              startingIndex: startIndex,
              requestedCount: pageSize,
            }, controller.signal);
          const cursor = upnpPageCursor("browse", requestIdentity, startIndex, pageSize, rawPage);
          result = upnpPageToTree(target as StableOliveTarget, rawPage, "artists");
          numberReturned = cursor.numberReturned;
          nextStartIndex = cursor.nextStartingIndex;
          reportedTotal = cursor.totalMatches;
          upnpPageComplete = cursor.complete;
        } else {
          result = await postWithSignal<MaestroTree>("/api/library/browse", {
            target,
            browse: {
              id: node.id,
              type: "artists",
              startIndex,
              index: pageIndex,
            },
          }, controller.signal);
          numberReturned = result.items.length;
          nextStartIndex = startIndex + numberReturned;
        }
        if (!requestIsCurrent(revision, expectedNamespace, requestIdentity) || controller.signal.aborted) return;

        treeId = result.id || treeId;
        if (result.totalItems !== null && Number.isFinite(result.totalItems) && result.totalItems >= 0) {
          reportedTotal = Math.max(reportedTotal ?? 0, result.totalItems);
        }
        if (numberReturned === 0) {
          complete = true;
          break;
        }

        const signature = result.items.map((item) => `${item.id}\u0000${item.title}`).join("\u0001");
        if (pageSignatures.has(signature)) {
          incompleteReason = "The Olive repeated an artist page before the index was complete.";
          break;
        }
        pageSignatures.add(signature);

        const previousSize = items.size;
        for (const [offset, item] of result.items.entries()) {
          const key = item.id || `${startIndex + offset}:${item.title}`;
          items.set(key, item);
        }
        const added = items.size - previousSize;
        const mergedTree: MaestroTree = {
          id: treeId,
          totalItems: reportedTotal,
          items: [...items.values()],
        };
        if (!refresh) {
          showTree(mergedTree);
          setLoading(false);
        }
        onStatus(`${node.title}: ${items.size.toLocaleString()}${reportedTotal === null ? "" : ` of ${reportedTotal.toLocaleString()}`} loaded`);

        const reachedReportedEnd = reportedTotal !== null && nextStartIndex >= reportedTotal;
        if (upnpPageComplete || reachedReportedEnd) {
          complete = true;
          break;
        }
        if (!useUpnp && numberReturned < pageSize) {
          if (reportedTotal === null) complete = true;
          else incompleteReason = `The Olive stopped after ${items.size.toLocaleString()} of ${reportedTotal.toLocaleString()} artists.`;
          break;
        }
        if (added === 0) {
          incompleteReason = "The Olive returned no new artists before the index was complete.";
          break;
        }
        startIndex = nextStartIndex;
        pageIndex += 1;
      }

      if (!complete && !incompleteReason) {
        incompleteReason = `The artist index reached its ${MAX_ARTIST_ITEMS.toLocaleString()}-item safety limit.`;
      }

      const mergedTree: MaestroTree = {
        id: treeId,
        totalItems: reportedTotal ?? items.size,
        items: [...items.values()],
      };
      if (complete || !refresh) showTree(mergedTree);
      if (!requestIsCurrent(revision, expectedNamespace, requestIdentity) || controller.signal.aborted) return;
      void indexSearchTree(target, mergedTree);
      if (complete) {
        onStatus(`${node.title}: ${items.size.toLocaleString()} artists available`);
      } else {
        setError(incompleteReason);
        onStatus(`${node.title}: ${items.size.toLocaleString()} artists loaded before the Olive stopped responding`);
      }
    } catch (reason) {
      if (
        !isAbortError(reason)
        && requestIsCurrent(revision, expectedNamespace, requestIdentity)
      ) {
        setError(reason instanceof Error ? reason.message : "Could not load the artist index.");
      }
    } finally {
      if (artistLoadController.current === controller) {
        artistLoadController.current = null;
        if (requestIsCurrent(revision, expectedNamespace, requestIdentity)) setLoading(false);
      }
    }
  }

  async function openNode(
    node: MaestroTreeNode,
    requestedStartingIndex = 0,
    refresh = false,
    previousStartingIndices: number[] = [],
  ) {
    const type = browseType(node);
    if (!type) { setError(`“${node.title}” uses an unverified browse mode.`); return; }
    if (isPlayableTrackNode(node)) {
      ++viewRevision.current;
      activeBrowseRequest.current = null;
      setError("");
      await playTrack(node);
      return;
    }
    if (type === "artists" && isArtistRoot(node) && requestedStartingIndex === 0) {
      await openArtistIndex(node, refresh);
      return;
    }
    if (type === "track" && isTrackRoot(node) && requestedStartingIndex === 0) {
      const revision = ++viewRevision.current;
      const expectedNamespace = targetRequestKey;
      const sourceTree = tree;
      const sourceActiveNode = activeNode;
      const sourcePage = page;
      activeBrowseRequest.current = `track-index:${expectedNamespace}`;
      setLoading(true);
      setError("");
      try {
        const [manifest, documents] = await Promise.all([
          readLibraryCatalogManifest(target),
          readSearchScope(target, "tracks"),
        ]);
        if (revision !== viewRevision.current || targetRequestKeyRef.current !== expectedNamespace) return;
        const expectedCount = manifest?.scopes.tracks;
        const complete = manifest?.cursors.tracks?.complete === true
          && expectedCount !== undefined
          && documents.length === expectedCount;
        if (complete) {
          const items = alphabetizeLibraryItems(documents.map((document) => document.item));
          if (!refresh && sourceTree) {
            setBreadcrumbs((trail) => [...trail, {
              title: node.title,
              tree: sourceTree,
              activeNode: sourceActiveNode,
              page: sourcePage,
            }]);
          }
          setTree({ id: node.id, totalItems: items.length, items });
          setActiveNode(node);
          setPage(null);
          activeBrowseRequest.current = null;
          setLoading(false);
          onStatus(`${items.length.toLocaleString()} tracks sorted A–Z`);
          return;
        }
      } catch {
        // The normal paged Olive endpoint remains available while indexing.
      }
      if (revision !== viewRevision.current || targetRequestKeyRef.current !== expectedNamespace) return;
      activeBrowseRequest.current = null;
      setLoading(false);
    }
    const revision = ++viewRevision.current;
    const expectedNamespace = targetRequestKey;
    artistLoadController.current?.abort();
    artistLoadController.current = null;
    const useUpnp = targetSupportsContentDirectory(target as StableOliveTarget) && isUpnpTreeNode(node);
    const pageSize = useUpnp || type === "track" ? 64 : 21;
    const objectIdentity = useUpnp ? node.userData.upnpId || node.id : node.id;
    const requestIdentity = `browse:${expectedNamespace}:${useUpnp ? "upnp" : "maestro"}:${type}:${objectIdentity}`;
    const operationIdentity = `${requestIdentity}@${requestedStartingIndex}`;
    activeBrowseRequest.current = operationIdentity;
    const sourceTree = tree;
    const sourceActiveNode = activeNode;
    const sourcePage = page;
    let breadcrumbCommitted = refresh || requestedStartingIndex > 0 || previousStartingIndices.length > 0;
    const showPage = (nextTree: MaestroTree, nextPage: BrowsePageState) => {
      if (!requestIsCurrent(revision, expectedNamespace, operationIdentity)) return;
      if (!breadcrumbCommitted) {
        breadcrumbCommitted = true;
        if (sourceTree) setBreadcrumbs((trail) => [...trail, {
          title: node.title,
          tree: sourceTree,
          activeNode: sourceActiveNode,
          page: sourcePage,
        }]);
      }
      const completeTrackListing = isTrackRoot(node)
        && nextPage.startingIndex === 0
        && nextTree.totalItems !== null
        && nextTree.items.length >= nextTree.totalItems;
      setTree(completeTrackListing
        ? { ...nextTree, items: alphabetizeLibraryItems(nextTree.items) }
        : nextTree);
      setActiveNode(node);
      setPage(completeTrackListing ? null : nextPage);
    };
    setLoading(true); setError("");
    const resource = `library:browse:v2:${useUpnp ? "upnp" : "maestro"}:${type}:${objectIdentity}:${requestedStartingIndex}`;
    const cached = await readDeviceCache<BrowsePageCache>(target, resource);
    if (isBrowsePageCache(cached, requestIdentity, requestedStartingIndex)
      && requestIsCurrent(revision, expectedNamespace, operationIdentity)) {
      showPage(cached.tree, {
        ...cached.page,
        previousStartingIndices: [...previousStartingIndices],
      });
      setLoading(false);
    }
    try {
      let result: MaestroTree;
      let nextPage: BrowsePageState;
      if (useUpnp) {
        const rawPage = await post<UpnpCatalogPage>("/api/upnp/browse", {
            target,
            objectId: objectIdentity,
            startingIndex: requestedStartingIndex,
            requestedCount: pageSize,
          });
        const cursor = upnpPageCursor("browse", requestIdentity, requestedStartingIndex, pageSize, rawPage);
        result = upnpPageToTree(
          target as StableOliveTarget,
          rawPage,
          browseType(node) === "composer" ? "composers"
            : browseType(node) === "artists" ? "artists"
              : browseType(node) === "genre" ? "genres"
                : browseType(node) === "playlist" ? "playlists"
                  : browseType(node) === "track" ? "tracks"
                    : "albums",
        );
        nextPage = browsePageState(
          requestIdentity,
          cursor.startingIndex,
          cursor.requestedCount,
          cursor.numberReturned,
          cursor.totalMatches,
          previousStartingIndices,
        );
      } else {
        result = await post<MaestroTree>("/api/library/browse", {
          target,
          browse: {
            id: node.id,
            type,
            startIndex: requestedStartingIndex,
            index: previousStartingIndices.length,
          },
        });
        nextPage = browsePageState(
          requestIdentity,
          requestedStartingIndex,
          pageSize,
          result.items.length,
          result.totalItems,
          previousStartingIndices,
        );
      }
      if (!requestIsCurrent(revision, expectedNamespace, operationIdentity)) return;
      showPage(result, nextPage);
      void writeDeviceCache(target, resource, {
        version: 1,
        tree: result,
        page: nextPage,
      } satisfies BrowsePageCache);
      void indexSearchTree(target, result);
      onStatus(`${node.title}: ${result.items.length} items loaded`);
    } catch (reason) {
      if (requestIsCurrent(revision, expectedNamespace, operationIdentity)) {
        setError(reason instanceof Error ? reason.message : "Could not open this section.");
      }
    } finally {
      if (requestIsCurrent(revision, expectedNamespace, operationIdentity)) setLoading(false);
    }
  }

  const goBack = useCallback(() => {
    ++viewRevision.current;
    activeBrowseRequest.current = null;
    artistLoadController.current?.abort();
    artistLoadController.current = null;
    setLoading(false);
    setBreadcrumbs((trail) => {
      const previous = trail.at(-1);
      if (previous) {
        setTree(previous.tree);
        setActiveNode(previous.activeNode);
        setPage(previous.page);
      }
      return previous ? trail.slice(0, -1) : trail;
    });
    setError("");
  }, []);

  useEffect(() => {
    onRegisterBack?.(breadcrumbs.length ? goBack : null);
    return () => onRegisterBack?.(null);
  }, [breadcrumbs.length, goBack, onRegisterBack]);

  async function playTrack(track: MaestroTreeNode) {
    setPlayingId(track.id); setError("");
    try {
      onStatus(`Starting ${track.title}…`);
      const playable = await resolveMaestroPlaybackNode(target, track);
      const candidates = (tree?.items ?? []).filter(isPlayableTrackNode);
      const context = isUpnpTreeNode(track)
        ? [playable]
        : playbackContextForSelection(
          track,
          candidates,
          isBroadTrackListing(activeNode) ? "automatic" : "explicit",
        );
      await playCanonicalTrack(playable, context.length ? context : [playable]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Playback failed."); }
    finally { setPlayingId(""); }
  }

  async function queueTrack(track: MaestroTreeNode) {
    setError("");
    try {
      const playable = await resolveMaestroPlaybackNode(target, track);
      enqueue(playable);
      onStatus(`${track.title} added to queue`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add this track to the queue.");
    }
  }

  if (!connected) return <section className="card module-empty"><h2>Olive not connected</h2><p>Open Settings to connect your Olive.</p></section>;

  const total = page?.totalItems ?? tree?.totalItems ?? null;
  const canNext = page !== null && page.numberReturned > 0 && (
    total === null
      ? page.numberReturned === page.requestedCount
      : page.nextStartingIndex < total
  );
  const previousStart = page?.previousStartingIndices.at(-1) ?? null;
  const previousHistory = page?.previousStartingIndices.slice(0, -1) ?? [];
  const pageNumber = (page?.previousStartingIndices.length ?? 0) + 1;
  const rangeStart = page && page.numberReturned > 0 ? page.startingIndex + 1 : 0;
  const rangeEnd = page?.nextStartingIndex ?? 0;
  const isArtistIndex = isArtistRoot(activeNode) && browseType(activeNode) === "artists";
  const isTrackIndex = isTrackRoot(activeNode) && browseType(activeNode) === "track" && page === null;
  const isAlphabetIndex = isArtistIndex || isTrackIndex;
  const alphabetBuckets = new Map(ALPHABET.map((letter) => [letter, [] as MaestroTreeNode[]]));
  if (isAlphabetIndex && tree) {
    for (const item of alphabetizeLibraryItems(tree.items)) {
      alphabetBuckets.get(artistInitial(item.title))?.push(item);
    }
  }
  const alphabetGroups = isAlphabetIndex
    ? ALPHABET.map((letter) => ({ letter, items: alphabetBuckets.get(letter) ?? [] })).filter((group) => group.items.length > 0)
    : [];
  const availableAlphabetLetters = new Set(alphabetGroups.map((group) => group.letter));
  const sectionPrefix = isTrackIndex ? "track" : "artist";
  const indexLabel = isTrackIndex ? "track" : "artist";

  function jumpToAlphabetLetter(letter: string, behavior: ScrollBehavior = "smooth") {
    if (!availableAlphabetLetters.has(letter)) return;
    document.getElementById(`${sectionPrefix}-section-${letter === "#" ? "other" : letter}`)?.scrollIntoView({ behavior, block: "start" });
  }

  function scrubToAlphabetLetter(clientY: number) {
    const buttons = artistIndexRef.current?.querySelectorAll<HTMLButtonElement>('button[data-letter]:not([aria-disabled="true"])');
    if (!buttons?.length) return;
    let closest: HTMLButtonElement | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      if (distance < closestDistance) {
        closest = button;
        closestDistance = distance;
      }
    }
    const letter = closest?.dataset.letter;
    if (!letter || lastScrubLetter.current === letter) return;
    lastScrubLetter.current = letter;
    jumpToAlphabetLetter(letter, "auto");
  }

  function startArtistScrub(event: ReactPointerEvent<HTMLElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    scrubPointerId.current = event.pointerId;
    lastScrubLetter.current = "";
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer capture is an enhancement. */ }
    scrubToAlphabetLetter(event.clientY);
  }

  function moveArtistScrub(event: ReactPointerEvent<HTMLElement>) {
    if (scrubPointerId.current !== event.pointerId) return;
    event.preventDefault();
    scrubToAlphabetLetter(event.clientY);
  }

  function finishArtistScrub(event: ReactPointerEvent<HTMLElement>, selectFinalLetter: boolean) {
    if (scrubPointerId.current !== event.pointerId) return;
    if (selectFinalLetter) scrubToAlphabetLetter(event.clientY);
    scrubPointerId.current = null;
    lastScrubLetter.current = "";
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch { /* The pointer may already have been released by the browser. */ }
  }

  return <section className="module-stack">
    <div className="content-toolbar">
      {breadcrumbs.length > 0 ? <div className="library-path"><button onClick={() => void loadRoot()}>Library</button>{breadcrumbs.map((crumb, index) => <span key={`${crumb.title}-${index}`}>/ {crumb.title}</span>)}</div> : <span />}
      <div className="toolbar-actions">{breadcrumbs.length > 0 && <button className="secondary" onClick={goBack}>Back</button>}<button className="secondary" onClick={() => activeNode ? void openNode(activeNode, page?.startingIndex ?? 0, true, page?.previousStartingIndices ?? []) : void loadRoot()} disabled={loading}>Refresh</button></div>
    </div>
    {error && <div className="error-box">{error}</div>}
    <div className="card library-panel" aria-busy={loading}>
      {loading ? <LibrarySkeleton count={tree?.items.length ? Math.min(tree.items.length, 15) : 12} /> : tree?.items.length ? isAlphabetIndex ? <div className="artist-browser">
        <div className="artist-sections">{alphabetGroups.map((group) => <section className="artist-section" id={`${sectionPrefix}-section-${group.letter === "#" ? "other" : group.letter}`} key={group.letter} aria-labelledby={`${sectionPrefix}-heading-${group.letter}`}><h2 id={`${sectionPrefix}-heading-${group.letter}`}>{group.letter}</h2><div className="library-grid">{group.items.map((item) => isTrackIndex
          ? <div className="library-item" key={`${item.userData.source ?? "maestro"}:${item.userData.upnpId ?? item.id}`}><button onClick={() => void openNode(item)}><LibraryArtwork target={target} item={item} fallback="▶" /><span><strong>{item.title || "Untitled"}</strong><small>{playingId === item.id ? "Starting…" : item.userData.artist || item.userData.interpreter || "Track"}</small></span><i>›</i></button><button className="queue-add" onClick={() => { void queueTrack(item); }} aria-label={`Add ${item.title} to queue`}>+</button></div>
          : <button key={item.id} onClick={() => void openNode(item)}><LibraryArtwork target={target} item={item} fallback="♪" /><span><strong>{item.title || "Untitled"}</strong></span><i>›</i></button>)}</div></section>)}</div>
        <nav
          ref={artistIndexRef}
          className="artist-index"
          aria-label={`Jump to ${indexLabel} letter`}
          onPointerDown={startArtistScrub}
          onPointerMove={moveArtistScrub}
          onPointerUp={(event) => finishArtistScrub(event, true)}
          onPointerCancel={(event) => finishArtistScrub(event, false)}
        >
          {ALPHABET.map((letter) => {
            const available = availableAlphabetLetters.has(letter);
            return <button
              type="button"
              key={letter}
              data-letter={letter}
              aria-disabled={!available}
              tabIndex={available ? 0 : -1}
              aria-label={`Jump to ${indexLabel}s beginning with ${letter}`}
              onClick={() => jumpToAlphabetLetter(letter)}
            >{letter}</button>;
          })}
        </nav>
      </div> : <div className="library-grid">{tree.items.map((item) => <div className="library-item" key={`${item.userData.source ?? "maestro"}:${item.userData.upnpId ?? item.id}`}><button onClick={() => void openNode(item)}><LibraryArtwork target={target} item={item} fallback={isPlayableTrackNode(item) ? "▶" : "♪"} /><span><strong>{item.title || "Untitled"}</strong><small>{playingId === item.id ? "Starting…" : libraryScopeLabel(libraryNodeScope(item))}</small></span><i>›</i></button>{isPlayableTrackNode(item) && <button className="queue-add" onClick={() => { void queueTrack(item); }} aria-label={`Add ${item.title} to queue`}>+</button>}</div>)}</div> : <div className="empty">This section is empty.</div>}
      {page && !isAlphabetIndex && <div className="pagination"><span>{rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}{total === null ? "" : ` of ${total.toLocaleString()}`} items · Page {pageNumber}</span><div><button className="secondary" disabled={loading || previousStart === null || !activeNode} onClick={() => activeNode && previousStart !== null && void openNode(activeNode, previousStart, false, previousHistory)}>Previous</button><button className="secondary" disabled={loading || !canNext || !activeNode} onClick={() => activeNode && page && void openNode(activeNode, page.nextStartingIndex, false, [...page.previousStartingIndices, page.startingIndex])}>Next</button></div></div>}
    </div>
  </section>;
}
