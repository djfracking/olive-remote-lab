import { useEffect, useRef, useState } from "react";
import type { MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { artworkUrl } from "../artwork";
import { appFetch } from "../nativeApi";
import { deviceCacheNamespace, deviceRequestKey, type StableOliveTarget } from "../deviceIdentity";
import { ARTWORK_PATH_STORAGE_KEY } from "../deviceStorageMigration";
import { RetryingArtwork } from "./RetryingArtwork";
import {
  isUpnpTreeNode,
  normalizeUpnpArtworkUri,
  type UpnpCatalogPage,
} from "../upnpCatalog";

const MAX_STORED_PATHS = 2_000;
const artworkPathCache = new Map<string, string>();
const artworkRequests = new Map<string, Promise<string>>();
const queue: Array<() => void> = [];
let activeRequests = 0;
let pathCacheLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

export function artworkRequestIdentity(target: StableOliveTarget, itemId: string): string {
  return `${deviceRequestKey(target)}:${itemId}`;
}

export function shouldApplyArtworkResult(
  expectedRevision: number,
  currentRevision: number,
  expectedRequestIdentity: string,
  currentRequestIdentity: string,
): boolean {
  return expectedRevision === currentRevision
    && expectedRequestIdentity === currentRequestIdentity;
}

function loadPathCache(): void {
  if (pathCacheLoaded) return;
  pathCacheLoaded = true;
  try {
    const stored = JSON.parse(localStorage.getItem(ARTWORK_PATH_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(stored)) return;
    for (const entry of stored.slice(-MAX_STORED_PATHS)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1]) {
        artworkPathCache.set(entry[0], entry[1]);
      }
    }
  } catch { /* A disabled or corrupt local store should not block the library. */ }
}

function persistPathCache(): void {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try { localStorage.setItem(ARTWORK_PATH_STORAGE_KEY, JSON.stringify([...artworkPathCache])); }
    catch { /* The browser may deny storage or evict it under pressure. */ }
  }, 250);
}

function rememberPath(key: string, path: string): void {
  artworkPathCache.delete(key);
  artworkPathCache.set(key, path);
  while (artworkPathCache.size > MAX_STORED_PATHS) {
    const oldest = artworkPathCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    artworkPathCache.delete(oldest);
  }
  persistPathCache();
}

function forgetPath(key: string): void {
  loadPathCache();
  artworkPathCache.delete(key);
  persistPathCache();
}

function runQueue(): void {
  while (activeRequests < 2 && queue.length) {
    activeRequests += 1;
    queue.shift()?.();
  }
}

function scheduled<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      void task().then(resolve, reject).finally(() => { activeRequests -= 1; runQueue(); });
    });
    runQueue();
  });
}

function directArtworkPath(item: MaestroTreeNode): string {
  const path = item.userData.albumart ?? item.userData.albumArt ?? item.userData.artwork
    ?? item.userData.artworkPath ?? item.userData.cover ?? "";
  return /artworknotfound\.gif(?:$|\?)/i.test(path) ? "" : path;
}

async function metadataArtworkPath(target: OliveDeviceTarget, itemId: string): Promise<string> {
  const response = await appFetch("/api/library/item-metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, itemId }),
  });
  if (!response.ok) return "";
  const metadata = await response.json() as { artworkPath?: unknown } | null;
  return typeof metadata?.artworkPath === "string" ? metadata.artworkPath : "";
}

async function firstTrackArtworkPath(target: OliveDeviceTarget, item: MaestroTreeNode): Promise<string> {
  if (isUpnpTreeNode(item)) {
    const response = await appFetch("/api/upnp/browse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target,
        objectId: item.userData.upnpId || item.id,
        startingIndex: 0,
        requestedCount: 8,
      }),
    });
    if (!response.ok) return "";
    const page = await response.json() as UpnpCatalogPage;
    return page.objects.map((child) =>
      normalizeUpnpArtworkUri(target as StableOliveTarget, child.albumArtUri))
      .find(Boolean) ?? "";
  }
  const response = await appFetch("/api/library/browse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target,
      browse: { id: item.id, type: "compilation", startIndex: 0, index: 0 },
    }),
  });
  if (!response.ok) return "";
  const tree = await response.json() as { items?: MaestroTreeNode[] } | null;
  const children = Array.isArray(tree?.items) ? tree.items : [];
  for (const child of children) {
    const direct = directArtworkPath(child);
    if (direct) return direct;
  }
  const firstTrack = children.find((child) => {
    const type = child.userData.type?.toLowerCase();
    return type === "track" || (type !== "album" && type !== "compilation" && child.childCount === 0);
  });
  return firstTrack?.id ? metadataArtworkPath(target, firstTrack.id) : "";
}

async function requestArtworkPath(target: OliveDeviceTarget, item: MaestroTreeNode): Promise<string> {
  const type = item.userData.type?.toLowerCase() ?? "";
  if (type === "album" || type === "compilation") return firstTrackArtworkPath(target, item);
  if (["artist", "artists", "interpreter", "genre", "playlist", "albumname"].includes(type)) return "";
  if (isUpnpTreeNode(item)) {
    const maestroId = item.userData.maestroId?.trim();
    return maestroId ? metadataArtworkPath(target, maestroId) : "";
  }
  return metadataArtworkPath(target, item.id);
}

async function itemArtworkPath(target: OliveDeviceTarget, item: MaestroTreeNode, force = false): Promise<string> {
  const cacheKey = `${deviceCacheNamespace(target as StableOliveTarget)}:${item.id}`;
  const requestKey = artworkRequestIdentity(target as StableOliveTarget, item.id);
  loadPathCache();
  if (!force && artworkPathCache.has(cacheKey)) return artworkPathCache.get(cacheKey) ?? "";
  const cached = artworkRequests.get(requestKey);
  if (cached) return cached;
  let request: Promise<string>;
  request = scheduled(() => requestArtworkPath(target, item)).catch(() => "").finally(() => {
    if (artworkRequests.get(requestKey) === request) artworkRequests.delete(requestKey);
  });
  artworkRequests.set(requestKey, request);
  return request;
}

export function LibraryArtwork({ target, item, fallback = "♪" }: { target: OliveDeviceTarget; item: MaestroTreeNode; fallback?: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const recoveryAttempted = useRef<string | null>(null);
  const artworkRevision = useRef(0);
  const directPath = directArtworkPath(item);
  const targetNamespace = deviceCacheNamespace(target as StableOliveTarget);
  const targetRequestKey = deviceRequestKey(target as StableOliveTarget);
  const requestIdentity = artworkRequestIdentity(target as StableOliveTarget, item.id);
  const requestIdentityRef = useRef(requestIdentity);
  requestIdentityRef.current = requestIdentity;
  const [path, setPath] = useState(directPath);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const revision = ++artworkRevision.current;
    const expectedRequestIdentity = requestIdentity;
    const cacheKey = `${targetNamespace}:${item.id}`;
    recoveryAttempted.current = null;
    setPath(directPath);
    setFailed(false);
    const element = root.current;
    if (!element || !item.id || directPath) return;
    let active = true;
    const load = () => {
      void itemArtworkPath(target, item).then((artworkPath) => {
        if (!active || !artworkPath || !shouldApplyArtworkResult(
          revision,
          artworkRevision.current,
          expectedRequestIdentity,
          requestIdentityRef.current,
        )) return;
        rememberPath(cacheKey, artworkPath);
        setPath(artworkPath);
      });
    };
    if (!("IntersectionObserver" in window)) { load(); return () => { active = false; }; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: "600px" });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [targetNamespace, targetRequestKey, item.id, directPath]);

  const source = artworkUrl(target, path);

  function recoverArtwork() {
    if (requestIdentityRef.current !== requestIdentity) return;
    if (recoveryAttempted.current === requestIdentity || !item.id) {
      setFailed(true);
      return;
    }
    const revision = ++artworkRevision.current;
    const expectedRequestIdentity = requestIdentity;
    recoveryAttempted.current = expectedRequestIdentity;
    const previousPath = path;
    const key = `${targetNamespace}:${item.id}`;
    forgetPath(key);
    setPath("");
    void itemArtworkPath(target, item, true).then((refreshedPath) => {
      if (!shouldApplyArtworkResult(
        revision,
        artworkRevision.current,
        expectedRequestIdentity,
        requestIdentityRef.current,
      )) return;
      if (refreshedPath && refreshedPath !== previousPath) {
        rememberPath(key, refreshedPath);
        setFailed(false);
        setPath(refreshedPath);
      } else {
        forgetPath(key);
        setFailed(true);
      }
    });
  }

  return <span ref={root} className={`library-icon artwork-tile ${source && !failed ? "has-artwork" : ""}`}>
    {source && !failed
      ? <RetryingArtwork src={source} alt="" loading="lazy" decoding="async" fallback={fallback} onExhausted={recoverArtwork} />
      : fallback}
  </span>;
}

export function LibrarySkeleton({ count = 12 }: { count?: number }) {
  return <div className="library-grid library-skeleton" role="status" aria-label="Loading library">
    {Array.from({ length: count }, (_, index) => <div className="skeleton-row" key={index} aria-hidden="true">
      <span className="skeleton-art" /><span><i /><i /></span>
    </div>)}
  </div>;
}
