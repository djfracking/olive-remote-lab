import type { LibrarySearchScope, MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { readDeviceCache, writeDeviceCache } from "./deviceCache";

export interface SearchDocument {
  key: string;
  scope: LibrarySearchScope;
  item: MaestroTreeNode;
  searchable: string;
  updatedAt: number;
}

const INDEX_RESOURCE = "library:search-index:v1";
const MAX_DOCUMENTS = 200_000;
const indexQueues = new Map<string, Promise<void>>();
export const SEARCH_INDEX_UPDATED_EVENT = "olive-search-index-updated";

function announceIndexUpdate(target: OliveDeviceTarget): void {
  window.dispatchEvent(new CustomEvent(SEARCH_INDEX_UPDATED_EVENT, { detail: { target: `${target.host.trim().toLowerCase()}:${target.port}` } }));
}

function queueIndexUpdate(target: OliveDeviceTarget, update: () => Promise<void>): Promise<void> {
  const queueKey = `${target.host.trim().toLowerCase()}:${target.port}`;
  const previous = indexQueues.get(queueKey) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(update);
  indexQueues.set(queueKey, queued);
  return queued.finally(() => {
    if (indexQueues.get(queueKey) === queued) indexQueues.delete(queueKey);
  });
}

export function scopeForItem(item: MaestroTreeNode, fallback: LibrarySearchScope = "albums"): LibrarySearchScope {
  const type = item.userData.type?.toLowerCase();
  if (type === "track" || type === "tracks") return "tracks";
  if (type === "artist" || type === "artists" || type === "interpreter") return "artists";
  if (type === "genre") return "genres";
  if (type === "playlist") return "playlists";
  if (type === "album" || type === "albumname" || type === "compilation") return "albums";
  return fallback;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function documentFor(item: MaestroTreeNode, scope: LibrarySearchScope): SearchDocument {
  const fields = [item.title, item.userData.artist, item.userData.album, item.userData.genre].filter(Boolean).join(" ");
  return { key: `${scope}:${item.id}`, scope, item, searchable: normalize(fields), updatedAt: Date.now() };
}

export async function indexSearchTree(target: OliveDeviceTarget, tree: MaestroTree, fallback?: LibrarySearchScope): Promise<void> {
  await queueIndexUpdate(target, async () => {
    const existing = await readDeviceCache<SearchDocument[]>(target, INDEX_RESOURCE) ?? [];
    const documents = new Map(existing.map((document) => [document.key, document]));
    for (const item of tree.items) {
      const scope = scopeForItem(item, fallback);
      const document = documentFor(item, scope);
      if (document.searchable) documents.set(document.key, document);
    }
    const next = [...documents.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DOCUMENTS);
    await writeDeviceCache(target, INDEX_RESOURCE, next);
    announceIndexUpdate(target);
  });
}

/** Replace one fully-crawled catalog scope while preserving the other scopes. */
export async function replaceSearchScope(target: OliveDeviceTarget, scope: LibrarySearchScope, items: MaestroTreeNode[]): Promise<void> {
  await queueIndexUpdate(target, async () => {
    const existing = await readDeviceCache<SearchDocument[]>(target, INDEX_RESOURCE) ?? [];
    const documents = new Map(existing.filter((document) => document.scope !== scope).map((document) => [document.key, document]));
    for (const item of items) {
      const document = documentFor(item, scope);
      if (document.searchable) documents.set(document.key, document);
    }
    const next = [...documents.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DOCUMENTS);
    await writeDeviceCache(target, INDEX_RESOURCE, next);
    announceIndexUpdate(target);
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

export function scoreSearchText(searchable: string, rawQuery: string): number {
  const query = normalize(rawQuery);
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
  if (query.length >= 4) {
    const closest = Math.min(...words.map((word) => editDistance(word, query)));
    const allowed = query.length >= 8 ? 2 : 1;
    if (closest <= allowed) return 420 - closest * 40;
  }
  return 0;
}

export async function searchLocalIndex(target: OliveDeviceTarget, query: string, limit = 60): Promise<SearchDocument[]> {
  const documents = await readDeviceCache<SearchDocument[]>(target, INDEX_RESOURCE) ?? [];
  return documents.map((document) => ({ document, score: scoreSearchText(document.searchable, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.document.updatedAt - a.document.updatedAt)
    .slice(0, limit)
    .map((entry) => entry.document);
}
