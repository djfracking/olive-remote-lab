import { useEffect, useRef, useState } from "react";
import type { MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { artworkUrl } from "../artwork";
import { appFetch } from "../nativeApi";

const ARTWORK_PATH_STORAGE_KEY = "olive-artwork-paths-v1";
const MAX_STORED_PATHS = 2_000;
const artworkPathCache = new Map<string, string>();
const metadataRequests = new Map<string, Promise<string>>();
const queue: Array<() => void> = [];
let activeRequests = 0;
let pathCacheLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

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

function runQueue(): void {
  while (activeRequests < 3 && queue.length) {
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

async function itemArtworkPath(target: OliveDeviceTarget, itemId: string): Promise<string> {
  const key = `${target.host}:${target.port}:${itemId}`;
  loadPathCache();
  if (artworkPathCache.has(key)) return artworkPathCache.get(key) ?? "";
  const cached = metadataRequests.get(key);
  if (cached) return cached;
  let request: Promise<string>;
  request = scheduled(async () => {
    const response = await appFetch("/api/library/item-metadata", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, itemId }),
    });
    if (!response.ok) return "";
    const metadata = await response.json() as { artworkPath?: unknown } | null;
    return typeof metadata?.artworkPath === "string" ? metadata.artworkPath : "";
  }).then((path) => {
    if (path) rememberPath(key, path);
    return path;
  }).catch(() => "").finally(() => {
    if (metadataRequests.get(key) === request) metadataRequests.delete(key);
  });
  metadataRequests.set(key, request);
  return request;
}

export function LibraryArtwork({ target, item, fallback = "♪" }: { target: OliveDeviceTarget; item: MaestroTreeNode; fallback?: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const directPath = item.userData.albumart ?? item.userData.albumArt ?? item.userData.artwork ?? item.userData.artworkPath ?? item.userData.cover ?? "";
  const [path, setPath] = useState(directPath);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPath(directPath);
    setFailed(false);
    const element = root.current;
    if (!element || !item.id || directPath) return;
    let active = true;
    const load = () => {
      void itemArtworkPath(target, item.id).then((artworkPath) => {
        if (active && artworkPath) setPath(artworkPath);
      });
    };
    if (!("IntersectionObserver" in window)) { load(); return () => { active = false; }; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer.disconnect(); load(); }
    }, { rootMargin: "600px" });
    observer.observe(element);
    return () => { active = false; observer.disconnect(); };
  }, [target.host, target.port, item.id, directPath]);

  const source = artworkUrl(target, path);
  return <span ref={root} className={`library-icon artwork-tile ${source && !failed ? "has-artwork" : ""}`}>
    {source && !failed ? <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : fallback}
  </span>;
}

export function LibrarySkeleton({ count = 12 }: { count?: number }) {
  return <div className="library-grid library-skeleton" role="status" aria-label="Loading library">
    {Array.from({ length: count }, (_, index) => <div className="skeleton-row" key={index} aria-hidden="true">
      <span className="skeleton-art" /><span><i /><i /></span>
    </div>)}
  </div>;
}
