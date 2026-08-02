import {
  canAdoptDeviceCache,
  deviceCacheNamespace,
  deviceEndpointKey,
  stableDeviceIdentity,
  type StableOliveTarget,
} from "./deviceIdentity";

export const PLAYBACK_QUEUE_STORAGE_PREFIX = "olive:queue:";
export const PLAYBACK_METADATA_STORAGE_KEY = "olive-playback-metadata-v2";
export const ARTWORK_PATH_STORAGE_KEY = "olive-artwork-paths-v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sourceNamespaces(destination: StableOliveTarget, sources: readonly StableOliveTarget[]): string[] {
  const destinationNamespace = deviceCacheNamespace(destination);
  const destinationIdentity = stableDeviceIdentity(destination);
  const destinationEndpoint = deviceEndpointKey(destination);
  const endpointIdentityConflict = sources.some((source) => {
    const sourceIdentity = stableDeviceIdentity(source);
    return deviceEndpointKey(source) === destinationEndpoint
      && sourceIdentity !== null
      && sourceIdentity !== destinationIdentity;
  });
  const namespaces = new Set<string>();
  for (const source of sources) {
    if (!canAdoptDeviceCache(source, destination)) continue;
    const sourceEndpoint = deviceEndpointKey(source);
    if (!(endpointIdentityConflict && sourceEndpoint === destinationEndpoint)) {
      namespaces.add(sourceEndpoint);
    }
    namespaces.add(deviceCacheNamespace(source));
  }
  namespaces.delete(destinationNamespace);
  return [...namespaces];
}

function parseArray(value: string | null): unknown[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function objectKey(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const item = value as Record<string, unknown>;
  if (typeof item.queueId === "string" && item.queueId) return `queue:${item.queueId}`;
  return JSON.stringify([
    item.itemId ?? "",
    item.title ?? "",
    item.artist ?? "",
    item.album ?? "",
    item.playbackIndex ?? "",
  ]);
}

function migrateQueues(storage: StorageLike, destinationNamespace: string, sources: readonly string[]): number {
  const destinationKey = `${PLAYBACK_QUEUE_STORAGE_PREFIX}${destinationNamespace}`;
  const destination = parseArray(storage.getItem(destinationKey));
  const merged = new Map(destination.map((item) => [objectKey(item), item]));
  const before = merged.size;
  const populatedSourceKeys: string[] = [];
  for (const source of sources) {
    const sourceKey = `${PLAYBACK_QUEUE_STORAGE_PREFIX}${source}`;
    const items = parseArray(storage.getItem(sourceKey));
    if (items.length) populatedSourceKeys.push(sourceKey);
    for (const item of items) {
      const key = objectKey(item);
      if (!merged.has(key)) merged.set(key, item);
    }
  }
  if (merged.size !== before) storage.setItem(destinationKey, JSON.stringify([...merged.values()]));
  for (const sourceKey of populatedSourceKeys) storage.removeItem(sourceKey);
  return merged.size - before;
}

function migrateRecordKeys(
  storage: StorageLike,
  storageKey: string,
  destinationNamespace: string,
  sources: readonly string[],
): number {
  let raw: unknown;
  try { raw = JSON.parse(storage.getItem(storageKey) ?? ""); }
  catch { return 0; }

  if (Array.isArray(raw)) {
    const entries = new Map<string, unknown>();
    for (const entry of raw) {
      if (Array.isArray(entry) && typeof entry[0] === "string") entries.set(entry[0], entry[1]);
    }
    let changed = 0;
    let removed = 0;
    for (const [key, value] of [...entries]) {
      const source = sources.find((namespace) => key.startsWith(`${namespace}:`));
      if (!source) continue;
      const destinationKey = `${destinationNamespace}:${key.slice(source.length + 1)}`;
      if (!entries.has(destinationKey)) {
        entries.set(destinationKey, value);
        changed += 1;
      }
      entries.delete(key);
      removed += 1;
    }
    if (changed || removed) storage.setItem(storageKey, JSON.stringify([...entries]));
    return changed;
  }

  if (!raw || typeof raw !== "object") return 0;
  const entries = raw as Record<string, unknown>;
  let changed = 0;
  let removed = 0;
  for (const [key, value] of [...Object.entries(entries)]) {
    const source = sources.find((namespace) => key.startsWith(`${namespace}:`));
    if (!source) continue;
    const destinationKey = `${destinationNamespace}:${key.slice(source.length + 1)}`;
    const existing = entries[destinationKey] as { cachedAt?: unknown } | undefined;
    const incoming = value as { cachedAt?: unknown } | undefined;
    const existingTime = typeof existing?.cachedAt === "number" ? existing.cachedAt : -1;
    const incomingTime = typeof incoming?.cachedAt === "number" ? incoming.cachedAt : 0;
    if (existing === undefined || existingTime < incomingTime) {
      entries[destinationKey] = value;
      changed += 1;
    }
    delete entries[key];
    removed += 1;
  }
  if (changed || removed) storage.setItem(storageKey, JSON.stringify(entries));
  return changed;
}

/**
 * Adopts the localStorage caches that predate stable IDs. Each destination is
 * written before its legacy alias is removed, preventing a future Olive at the
 * recycled endpoint from inheriting the first device's queue or metadata.
 */
export function adoptDeviceLocalStorage(
  destination: StableOliveTarget,
  sources: readonly StableOliveTarget[],
  storage: StorageLike = window.localStorage,
): number {
  if (!stableDeviceIdentity(destination)) return 0;
  const destinationNamespace = deviceCacheNamespace(destination);
  const namespaces = sourceNamespaces(destination, sources);
  if (!namespaces.length) return 0;
  return migrateQueues(storage, destinationNamespace, namespaces)
    + migrateRecordKeys(storage, PLAYBACK_METADATA_STORAGE_KEY, destinationNamespace, namespaces)
    + migrateRecordKeys(storage, ARTWORK_PATH_STORAGE_KEY, destinationNamespace, namespaces);
}
