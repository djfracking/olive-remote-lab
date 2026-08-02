import type { LibrarySearchScope, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import {
  readDeviceCache,
  readDeviceCacheResourcesStrict,
  readDeviceCacheStrict,
  transactDeviceCacheResourcesStrict,
  writeDeviceCache,
} from "./deviceCache";
import { deviceCacheNamespace, type StableOliveTarget } from "./deviceIdentity";

export interface SearchDocument {
  key: string;
  scope: LibrarySearchScope;
  item: MaestroTreeNode;
  searchable: string;
  updatedAt: number;
}

interface SearchScopeManifest {
  generation: string;
  chunks: string[];
  count: number;
  complete: boolean;
}

interface SearchIndexManifest {
  version: 2;
  scopes: Partial<Record<LibrarySearchScope, SearchScopeManifest>>;
}

interface SearchMemoryIndex {
  documents: Map<string, SearchDocument>;
  scopeKeys: Map<LibrarySearchScope, Set<string>>;
  chunkedScopes: Set<LibrarySearchScope>;
}

const LEGACY_INDEX_RESOURCE = "library:search-index:v1";
const INDEX_MANIFEST_RESOURCE = "library:search-index-manifest:v2";
const INDEX_CHUNK_PREFIX = "library:search-index-chunk:v2";
const MAX_DOCUMENTS = 200_000;
const INDEX_UPDATE_COALESCE_MS = 350;
const indexQueues = new Map<string, Promise<void>>();
const inMemoryIndexes = new Map<string, SearchMemoryIndex>();
const loadingIndexes = new Map<string, Promise<SearchMemoryIndex>>();
const loadVersions = new Map<string, number>();
const notificationTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const SEARCH_INDEX_UPDATED_EVENT = "olive-search-index-updated";

function namespace(target: OliveDeviceTarget): string {
  return deviceCacheNamespace(target as StableOliveTarget);
}

function announceIndexUpdate(target: OliveDeviceTarget): void {
  if (typeof window === "undefined") return;
  const key = namespace(target);
  if (notificationTimers.has(key)) return;
  const timer = setTimeout(() => {
    notificationTimers.delete(key);
    window.dispatchEvent(new CustomEvent(SEARCH_INDEX_UPDATED_EVENT, {
      detail: { target: key },
    }));
  }, INDEX_UPDATE_COALESCE_MS);
  notificationTimers.set(key, timer);
}

function queueIndexUpdate<T>(target: OliveDeviceTarget, update: () => Promise<T>): Promise<T> {
  const queueKey = namespace(target);
  const previous = indexQueues.get(queueKey) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(update);
  const tail = task.then(() => undefined, () => undefined);
  indexQueues.set(queueKey, tail);
  return task.finally(() => {
    if (indexQueues.get(queueKey) === tail) indexQueues.delete(queueKey);
  });
}

export function scopeForItem(item: MaestroTreeNode, fallback: LibrarySearchScope = "albums"): LibrarySearchScope {
  const type = item.userData.type?.toLowerCase();
  if (type === "track" || type === "tracks") return "tracks";
  if (type === "artist" || type === "artists" || type === "interpreter") return "artists";
  if (type === "composer" || type === "composers") return "composers";
  if (type === "genre") return "genres";
  if (type === "playlist") return "playlists";
  if (type === "album" || type === "albumname" || type === "compilation") return "albums";
  return fallback;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function documentFor(item: MaestroTreeNode, scope: LibrarySearchScope, updatedAt = Date.now()): SearchDocument {
  const fields = [
    item.title,
    item.userData.artist,
    item.userData.album,
    item.userData.genre,
    item.userData.composer,
    item.userData.creator,
  ].filter(Boolean).join(" ");
  const sourceId = item.userData.source === "upnp"
    ? item.userData.upnpId || item.id
    : item.userData.maestroId || item.id;
  return { key: `${scope}:${item.userData.source ?? "maestro"}:${sourceId}`, scope, item, searchable: normalize(fields), updatedAt };
}

function newestDocuments(documents: readonly SearchDocument[]): SearchDocument[] {
  const merged = new Map<string, SearchDocument>();
  for (const document of documents) {
    const prior = merged.get(document.key);
    if (!prior || prior.updatedAt <= document.updatedAt) merged.set(document.key, document);
  }
  return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_DOCUMENTS);
}

function emptyMemoryIndex(chunkedScopes: Iterable<LibrarySearchScope> = []): SearchMemoryIndex {
  return {
    documents: new Map(),
    scopeKeys: new Map(),
    chunkedScopes: new Set(chunkedScopes),
  };
}

function removeMemoryDocument(index: SearchMemoryIndex, key: string): void {
  const current = index.documents.get(key);
  if (!current) return;
  index.documents.delete(key);
  const scopeKeys = index.scopeKeys.get(current.scope);
  scopeKeys?.delete(key);
  if (scopeKeys?.size === 0) index.scopeKeys.delete(current.scope);
}

function upsertMemoryDocument(index: SearchMemoryIndex, document: SearchDocument): void {
  const prior = index.documents.get(document.key);
  if (prior && prior.updatedAt > document.updatedAt) return;
  if (prior) removeMemoryDocument(index, document.key);
  index.documents.set(document.key, document);
  const scopeKeys = index.scopeKeys.get(document.scope) ?? new Set<string>();
  scopeKeys.add(document.key);
  index.scopeKeys.set(document.scope, scopeKeys);
  while (index.documents.size > MAX_DOCUMENTS) {
    const oldestKey = index.documents.keys().next().value as string | undefined;
    if (!oldestKey) break;
    removeMemoryDocument(index, oldestKey);
  }
}

function memoryIndexFrom(
  documents: readonly SearchDocument[],
  chunkedScopes: Iterable<LibrarySearchScope>,
): SearchMemoryIndex {
  const index = emptyMemoryIndex(chunkedScopes);
  // Oldest first makes Map insertion order a cheap eviction queue. Incoming
  // catalog pages are timestamped later and append without sorting the index.
  for (const document of newestDocuments(documents).reverse()) upsertMemoryDocument(index, document);
  return index;
}

function clearMemoryScope(index: SearchMemoryIndex, scope: LibrarySearchScope): void {
  const keys = [...(index.scopeKeys.get(scope) ?? [])];
  for (const key of keys) removeMemoryDocument(index, key);
  index.chunkedScopes.add(scope);
}

function replaceMemoryChunk(
  index: SearchMemoryIndex,
  prior: readonly SearchDocument[],
  next: readonly SearchDocument[],
): void {
  for (const document of prior) {
    const current = index.documents.get(document.key);
    if (current?.updatedAt === document.updatedAt) removeMemoryDocument(index, document.key);
  }
  for (const document of next) upsertMemoryDocument(index, document);
}

async function loadManifestDocuments(target: OliveDeviceTarget): Promise<{
  documents: SearchDocument[];
  scopes: Set<LibrarySearchScope>;
}> {
  const manifest = await readDeviceCacheStrict<SearchIndexManifest>(target, INDEX_MANIFEST_RESOURCE);
  if (!manifest || manifest.version !== 2) return { documents: [], scopes: new Set() };
  const resources = [...new Set(Object.values(manifest.scopes).flatMap((scope) => scope?.chunks ?? []))];
  const chunks = await readDeviceCacheResourcesStrict<SearchDocument[]>(target, resources);
  const missingIndex = chunks.findIndex((chunk) => chunk === null);
  if (missingIndex >= 0) {
    throw new Error(`The saved search index is missing chunk ${resources[missingIndex] ?? "unknown"}.`);
  }
  return {
    documents: chunks.flatMap((chunk) => chunk ?? []),
    scopes: new Set(Object.keys(manifest.scopes) as LibrarySearchScope[]),
  };
}

async function loadMemoryIndex(target: OliveDeviceTarget): Promise<SearchMemoryIndex> {
  const key = namespace(target);
  const loaded = inMemoryIndexes.get(key);
  if (loaded) return loaded;
  const loading = loadingIndexes.get(key);
  if (loading) return loading;
  const loadVersion = loadVersions.get(key) ?? 0;
  const task = (async () => {
    const [chunked, legacy] = await Promise.all([
      loadManifestDocuments(target),
      readDeviceCache<SearchDocument[]>(target, LEGACY_INDEX_RESOURCE),
    ]);
    const index = memoryIndexFrom([
      ...chunked.documents,
      ...(legacy ?? []).filter((document) => !chunked.scopes.has(document.scope)),
    ], chunked.scopes);
    if ((loadVersions.get(key) ?? 0) === loadVersion) inMemoryIndexes.set(key, index);
    return index;
  })();
  loadingIndexes.set(key, task);
  try { return await task; }
  finally { if (loadingIndexes.get(key) === task) loadingIndexes.delete(key); }
}

function invalidateMemoryIndex(key: string): void {
  loadVersions.set(key, (loadVersions.get(key) ?? 0) + 1);
  inMemoryIndexes.delete(key);
  loadingIndexes.delete(key);
}

function safeGeneration(value: string): string {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80);
  if (!normalized) throw new Error("A search-index generation is required.");
  return normalized;
}

function chunkResource(scope: LibrarySearchScope, generation: string, chunkId: string): string {
  const normalizedChunk = chunkId.trim().replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80);
  if (!normalizedChunk) throw new Error("A search-index chunk ID is required.");
  return `${INDEX_CHUNK_PREFIX}:${scope}:${safeGeneration(generation)}:${normalizedChunk}`;
}

export async function beginSearchScope(
  target: OliveDeviceTarget,
  scope: LibrarySearchScope,
  generation: string,
): Promise<void> {
  await queueIndexUpdate(target, async () => {
    const normalizedGeneration = safeGeneration(generation);
    const nextManifest = await transactDeviceCacheResourcesStrict(
      target,
      [INDEX_MANIFEST_RESOURCE],
      ([storedManifest]) => {
        const manifest = (storedManifest as SearchIndexManifest | null)?.version === 2
          ? storedManifest as SearchIndexManifest
          : { version: 2 as const, scopes: {} };
        const next: SearchIndexManifest = {
          version: 2,
          scopes: {
            ...manifest.scopes,
            [scope]: { generation: normalizedGeneration, chunks: [], count: 0, complete: false },
          },
        };
        return {
          writes: [{ resource: INDEX_MANIFEST_RESOURCE, value: next }],
          deletePrefixes: [{
            resourcePrefix: `${INDEX_CHUNK_PREFIX}:${scope}:`,
            preserveResourcePrefixes: [`${INDEX_CHUNK_PREFIX}:${scope}:${normalizedGeneration}:`],
          }],
          result: next,
        };
      },
    );
    let memoryIndex: SearchMemoryIndex;
    try { memoryIndex = await loadMemoryIndex(target); }
    catch {
      // A missing old chunk must not prevent a clean generation from replacing
      // it. Invalidate any detached cold load and rebuild from the new manifest.
      const key = namespace(target);
      invalidateMemoryIndex(key);
      try { memoryIndex = await loadMemoryIndex(target); }
      catch {
        memoryIndex = emptyMemoryIndex(Object.keys(nextManifest.scopes) as LibrarySearchScope[]);
        inMemoryIndexes.set(key, memoryIndex);
      }
    }
    clearMemoryScope(memoryIndex, scope);
    announceIndexUpdate(target);
  });
}

/**
 * Stores one fetched page once, then updates only the small manifest. This is
 * the hot path for the 45k-track crawl and avoids rewriting all prior pages.
 */
export async function appendSearchScopePage(
  target: OliveDeviceTarget,
  scope: LibrarySearchScope,
  generation: string,
  chunkId: string,
  items: MaestroTreeNode[],
): Promise<number> {
  return queueIndexUpdate(target, async () => {
    const normalizedGeneration = safeGeneration(generation);
    const resource = chunkResource(scope, normalizedGeneration, chunkId);
    const documents = items.map((item) => documentFor(item, scope));
    const update = await transactDeviceCacheResourcesStrict(
      target,
      [INDEX_MANIFEST_RESOURCE, resource],
      ([storedManifest, storedChunk]) => {
        const manifest = storedManifest as SearchIndexManifest | null;
        const current = manifest?.version === 2 ? manifest.scopes[scope] : undefined;
        if (!manifest || manifest.version !== 2 || !current || current.generation !== normalizedGeneration) {
          throw new Error(`Cannot append stale ${scope} search generation.`);
        }
        const replacingChunk = current.chunks.includes(resource);
        if (replacingChunk && !storedChunk) {
          throw new Error(`The saved ${scope} search index is missing chunk ${resource}.`);
        }
        const previousDocuments = replacingChunk ? storedChunk as SearchDocument[] : [];
        const chunks = replacingChunk ? current.chunks : [...current.chunks, resource];
        const nextScope: SearchScopeManifest = {
          ...current,
          chunks,
          count: Math.max(0, current.count - previousDocuments.length + documents.length),
          complete: false,
        };
        const nextManifest: SearchIndexManifest = {
          version: 2,
          scopes: { ...manifest.scopes, [scope]: nextScope },
        };
        return {
          writes: [
            { resource, value: documents },
            { resource: INDEX_MANIFEST_RESOURCE, value: nextManifest },
          ],
          result: { previousDocuments, replacingChunk, count: nextScope.count },
        };
      },
    );
    const memoryIndex = await loadMemoryIndex(target);
    const { previousDocuments, replacingChunk } = update;
    replaceMemoryChunk(memoryIndex, replacingChunk ? previousDocuments : [], documents);
    memoryIndex.chunkedScopes.add(scope);
    announceIndexUpdate(target);
    return update.count;
  });
}

export async function completeSearchScope(
  target: OliveDeviceTarget,
  scope: LibrarySearchScope,
  generation: string,
): Promise<void> {
  await queueIndexUpdate(target, async () => {
    const normalizedGeneration = safeGeneration(generation);
    await transactDeviceCacheResourcesStrict(
      target,
      [INDEX_MANIFEST_RESOURCE],
      ([storedManifest]) => {
        const manifest = storedManifest as SearchIndexManifest | null;
        const current = manifest?.version === 2 ? manifest.scopes[scope] : undefined;
        if (!manifest || !current || current.generation !== normalizedGeneration) {
          throw new Error(`Cannot complete stale ${scope} search generation.`);
        }
        const nextManifest: SearchIndexManifest = {
          version: 2,
          scopes: { ...manifest.scopes, [scope]: { ...current, complete: true } },
        };
        return {
          writes: [{ resource: INDEX_MANIFEST_RESOURCE, value: nextManifest }],
          result: undefined,
        };
      },
    );
    announceIndexUpdate(target);
  });
}

export async function indexSearchTree(target: OliveDeviceTarget, tree: MaestroTree, fallback?: LibrarySearchScope): Promise<void> {
  await queueIndexUpdate(target, async () => {
    let memoryIndex: SearchMemoryIndex;
    try { memoryIndex = await loadMemoryIndex(target); }
    catch {
      memoryIndex = inMemoryIndexes.get(namespace(target)) ?? emptyMemoryIndex();
      inMemoryIndexes.set(namespace(target), memoryIndex);
    }
    const existing = await readDeviceCache<SearchDocument[]>(target, LEGACY_INDEX_RESOURCE) ?? [];
    const documents = new Map(existing.map((document) => [document.key, document]));
    const changed: SearchDocument[] = [];
    for (const item of tree.items) {
      const scope = scopeForItem(item, fallback);
      const document = documentFor(item, scope);
      if (document.searchable) {
        documents.set(document.key, document);
        if (!memoryIndex.chunkedScopes.has(scope)) changed.push(document);
      }
    }
    const next = newestDocuments([...documents.values()]);
    await writeDeviceCache(target, LEGACY_INDEX_RESOURCE, next);
    for (const document of changed) upsertMemoryDocument(memoryIndex, document);
    announceIndexUpdate(target);
  });
}

/** Replace one scope atomically while preserving all other chunked scopes. */
export async function replaceSearchScope(target: OliveDeviceTarget, scope: LibrarySearchScope, items: MaestroTreeNode[]): Promise<void> {
  const generation = `replace-${Date.now()}`;
  await beginSearchScope(target, scope, generation);
  await appendSearchScopePage(target, scope, generation, "all", items);
  await completeSearchScope(target, scope, generation);
}

export async function readSearchScope(target: OliveDeviceTarget, scope: LibrarySearchScope): Promise<SearchDocument[]> {
  const index = await loadMemoryIndex(target);
  return [...(index.scopeKeys.get(scope) ?? [])].flatMap((key) => {
    const document = index.documents.get(key);
    return document ? [document] : [];
  });
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const held = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = held;
    }
  }
  return row[right.length]!;
}

function scoreNormalizedSearchText(searchable: string, query: string): number {
  if (!query) return 0;
  if (searchable === query) return 1_000;
  if (searchable.startsWith(query)) return 850 - Math.min(100, searchable.length - query.length);
  const words = searchable.split(" ");
  if (words.some((word) => word === query)) return 760;
  if (words.some((word) => word.startsWith(query))) return 680;
  if (searchable.includes(query)) return 580;
  const queryWords = query.split(" ");
  const allTokensMatch = queryWords.every((token) => words.some((word) => word.startsWith(token)));
  if (allTokensMatch) return 520;
  // Fuzzy distance is reserved for the small candidate set with a matching
  // first character. It is never run across every word in a 200k-item index.
  if (query.length >= 4) {
    const candidates = words.filter((word) => word[0] === query[0] && Math.abs(word.length - query.length) <= 2);
    if (candidates.length) {
      const closest = Math.min(...candidates.map((word) => editDistance(word, query)));
      const allowed = query.length >= 8 ? 2 : 1;
      if (closest <= allowed) return 420 - closest * 40;
    }
  }
  return 0;
}

export function scoreSearchText(searchable: string, rawQuery: string): number {
  return scoreNormalizedSearchText(searchable, normalize(rawQuery));
}

export async function searchLocalIndex(target: OliveDeviceTarget, query: string, limit = 60): Promise<SearchDocument[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  let index: SearchMemoryIndex;
  try { index = await loadMemoryIndex(target); }
  catch { index = inMemoryIndexes.get(namespace(target)) ?? emptyMemoryIndex(); }
  const ranked: Array<{ document: SearchDocument; score: number }> = [];
  const better = (
    left: { document: SearchDocument; score: number },
    right: { document: SearchDocument; score: number },
  ) => left.score > right.score
    || left.score === right.score && left.document.updatedAt > right.document.updatedAt;
  const bubbleUpWorst = (start: number) => {
    let position = start;
    while (position > 0) {
      const parent = Math.floor((position - 1) / 2);
      if (!better(ranked[parent]!, ranked[position]!)) break;
      [ranked[parent], ranked[position]] = [ranked[position]!, ranked[parent]!];
      position = parent;
    }
  };
  const sinkWorst = () => {
    let position = 0;
    for (;;) {
      const left = position * 2 + 1;
      if (left >= ranked.length) return;
      const right = left + 1;
      let worseChild = left;
      if (right < ranked.length && better(ranked[left]!, ranked[right]!)) worseChild = right;
      if (!better(ranked[position]!, ranked[worseChild]!)) return;
      [ranked[position], ranked[worseChild]] = [ranked[worseChild]!, ranked[position]!];
      position = worseChild;
    }
  };
  for (const document of index.documents.values()) {
    const entry = { document, score: scoreNormalizedSearchText(document.searchable, normalizedQuery) };
    if (entry.score <= 0) continue;
    if (ranked.length < limit) {
      ranked.push(entry);
      bubbleUpWorst(ranked.length - 1);
      continue;
    }
    if (!better(entry, ranked[0]!)) continue;
    ranked[0] = entry;
    sinkWorst();
  }
  return ranked.sort((left, right) =>
    right.score - left.score || right.document.updatedAt - left.document.updatedAt)
    .map((entry) => entry.document);
}
