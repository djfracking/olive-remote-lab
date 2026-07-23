import type { LibrarySearchScope, MaestroBrowseRequest, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "./nativeApi";
import { readDeviceCache, writeDeviceCache } from "./deviceCache";
import { replaceSearchScope } from "./searchIndex";

const MANIFEST_RESOURCE = "library:catalog-manifest:v1";
const PARTIAL_PREFIX = "library:catalog-partial:v1";
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_SCOPE_ITEMS = 150_000;

export interface LibraryCatalogManifest {
  version: 1;
  complete: boolean;
  completedAt: number;
  itemCount: number;
  scopes: Partial<Record<LibrarySearchScope, number>>;
}

export interface LibraryCatalogProgress {
  phase: "syncing" | "complete" | "error";
  scope: LibrarySearchScope | null;
  scopeItems: number;
  scopeTotal: number | null;
  itemCount: number;
  message?: string;
}

interface PartialScope {
  items: MaestroTreeNode[];
  nextStartIndex: number;
  totalItems: number | null;
}

interface ScopeConfig {
  scope: LibrarySearchScope;
  id: string;
  type: MaestroBrowseRequest["type"];
  pageSize: number;
  paged: boolean;
}

const SCOPES: ScopeConfig[] = [
  { scope: "artists", id: "artists", type: "artists", pageSize: 21, paged: true },
  { scope: "albums", id: "albumname", type: "albumname", pageSize: 21, paged: true },
  { scope: "playlists", id: "playlists", type: "playlist", pageSize: 21, paged: false },
  { scope: "genres", id: "genres", type: "genre", pageSize: 21, paged: false },
  { scope: "tracks", id: "tracks", type: "track", pageSize: 64, paged: true },
];

const activeSyncs = new Map<string, Promise<LibraryCatalogManifest>>();

function targetKey(target: OliveDeviceTarget): string {
  return `${target.host.trim().toLowerCase()}:${target.port}`;
}

function partialResource(scope: LibrarySearchScope): string {
  return `${PARTIAL_PREFIX}:${scope}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Library sync cancelled.", "AbortError");
}

async function browse(target: OliveDeviceTarget, config: ScopeConfig, startIndex: number, signal?: AbortSignal): Promise<MaestroTree> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      throwIfAborted(signal);
      const response = await appFetch("/api/library/browse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          target,
          browse: { id: config.id, type: config.type, startIndex, index: Math.floor(startIndex / config.pageSize) },
        }),
      });
      const data = await response.json() as MaestroTree & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `${config.scope} sync failed.`);
      return data;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 400));
    }
  }
  throw lastError;
}

async function crawlScope(
  target: OliveDeviceTarget,
  config: ScopeConfig,
  report: (progress: LibraryCatalogProgress) => void,
  completedItemCount: number,
  publishPartialIndex: boolean,
  signal?: AbortSignal,
): Promise<MaestroTreeNode[]> {
  const saved = await readDeviceCache<PartialScope>(target, partialResource(config.scope));
  const items = saved?.items ? [...saved.items] : [];
  let startIndex = saved?.nextStartIndex ?? 0;
  let totalItems = saved?.totalItems ?? null;
  let priorSignature = "";

  while (items.length < MAX_SCOPE_ITEMS) {
    throwIfAborted(signal);
    const tree = await browse(target, config, startIndex, signal);
    if (tree.totalItems !== null) totalItems = tree.totalItems;
    const signature = tree.items.length ? `${tree.items[0]?.id}:${tree.items.at(-1)?.id}:${tree.items.length}` : "empty";
    if (startIndex > 0 && signature === priorSignature) break;
    priorSignature = signature;

    const byId = new Map(items.map((item) => [item.id, item]));
    for (const item of tree.items) byId.set(item.id, item);
    items.splice(0, items.length, ...byId.values());
    startIndex += config.pageSize;
    report({ phase: "syncing", scope: config.scope, scopeItems: items.length, scopeTotal: totalItems, itemCount: completedItemCount + items.length });

    const finished = !config.paged || tree.items.length === 0 || tree.items.length < config.pageSize
      || (totalItems !== null && startIndex >= totalItems);
    if (finished) break;

    if (Math.floor(startIndex / config.pageSize) % 25 === 0) {
      await writeDeviceCache(target, partialResource(config.scope), { items, nextStartIndex: startIndex, totalItems } satisfies PartialScope);
      if (publishPartialIndex) await replaceSearchScope(target, config.scope, items);
    }
    // Give playback and Now Playing requests room on slower Olive hardware.
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  }

  await writeDeviceCache(target, partialResource(config.scope), { items, nextStartIndex: startIndex, totalItems } satisfies PartialScope);
  return items;
}

export async function readLibraryCatalogManifest(target: OliveDeviceTarget): Promise<LibraryCatalogManifest | null> {
  return readDeviceCache<LibraryCatalogManifest>(target, MANIFEST_RESOURCE);
}

export async function libraryCatalogIsReady(target: OliveDeviceTarget): Promise<boolean> {
  return (await readLibraryCatalogManifest(target))?.complete === true;
}

export async function syncLibraryCatalog(
  target: OliveDeviceTarget,
  report: (progress: LibraryCatalogProgress) => void,
  force = false,
  signal?: AbortSignal,
): Promise<LibraryCatalogManifest> {
  const key = targetKey(target);
  const running = activeSyncs.get(key);
  if (running) return running;

  const task = (async () => {
    const existing = await readLibraryCatalogManifest(target);
    if (!force && existing?.complete && Date.now() - existing.completedAt < REFRESH_AFTER_MS) {
      report({ phase: "complete", scope: null, scopeItems: 0, scopeTotal: null, itemCount: existing.itemCount });
      return existing;
    }

    const scopeCounts: Partial<Record<LibrarySearchScope, number>> = {};
    let completedItemCount = 0;
    try {
      for (const config of SCOPES) {
        throwIfAborted(signal);
        report({ phase: "syncing", scope: config.scope, scopeItems: 0, scopeTotal: null, itemCount: completedItemCount });
        const items = await crawlScope(target, config, report, completedItemCount, existing?.complete !== true, signal);
        await replaceSearchScope(target, config.scope, items);
        scopeCounts[config.scope] = items.length;
        completedItemCount += items.length;
        await writeDeviceCache(target, partialResource(config.scope), { items: [], nextStartIndex: 0, totalItems: null } satisfies PartialScope);
      }
      const manifest: LibraryCatalogManifest = { version: 1, complete: true, completedAt: Date.now(), itemCount: completedItemCount, scopes: scopeCounts };
      await writeDeviceCache(target, MANIFEST_RESOURCE, manifest);
      report({ phase: "complete", scope: null, scopeItems: 0, scopeTotal: null, itemCount: completedItemCount });
      return manifest;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : "Library preparation stopped.";
      report({ phase: "error", scope: null, scopeItems: 0, scopeTotal: null, itemCount: completedItemCount, message });
      throw error;
    }
  })();

  activeSyncs.set(key, task);
  try { return await task; }
  finally { if (activeSyncs.get(key) === task) activeSyncs.delete(key); }
}
