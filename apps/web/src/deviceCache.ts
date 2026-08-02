import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import {
  canAdoptDeviceCache,
  deviceCacheNamespace,
  deviceEndpointKey,
  stableDeviceIdentity,
  type StableOliveTarget,
} from "./deviceIdentity";

const DATABASE_NAME = "olive-remote-device-cache";
const STORE_NAME = "responses";
const DATABASE_VERSION = 1;
const memoryCache = new Map<string, unknown>();
const durableMemoryKeys = new Set<string>();
const cacheWriteRevisions = new Map<string, number>();
let nextCacheWriteRevision = 0;
let databasePromise: Promise<IDBDatabase> | undefined;

interface CacheRecord<T> {
  key: string;
  savedAt: number;
  value: T;
}

export function deviceCacheKey(target: StableOliveTarget, resource: string): string {
  return `${deviceCacheNamespace(target)}|${resource}`;
}

function legacyCacheKey(target: OliveDeviceTarget, resource: string): string {
  return `${deviceEndpointKey(target)}|${resource}`;
}

function database(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Device cache could not be opened."));
  });
  return databasePromise;
}

function supportsIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function reserveCacheWrite(key: string): number {
  nextCacheWriteRevision += 1;
  cacheWriteRevisions.set(key, nextCacheWriteRevision);
  return nextCacheWriteRevision;
}

function publishDurableValue<T>(key: string, revision: number | undefined, value: T): void {
  if (cacheWriteRevisions.get(key) !== revision) return;
  memoryCache.set(key, value);
  durableMemoryKeys.add(key);
}

function cacheRead<T>(db: IDBDatabase, recordKey: string): Promise<CacheRecord<T> | undefined> {
  return new Promise<CacheRecord<T> | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(recordKey);
    let record: CacheRecord<T> | undefined;
    request.onsuccess = () => { record = request.result as CacheRecord<T> | undefined; };
    request.onerror = () => reject(request.error ?? new Error("Device cache record could not be read."));
    transaction.oncomplete = () => resolve(record);
    transaction.onerror = () => reject(transaction.error ?? new Error("Device cache read transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Device cache read transaction was aborted."));
  });
}

async function readDeviceCacheInternal<T>(
  target: OliveDeviceTarget,
  resource: string,
  strict: boolean,
): Promise<T | null> {
  const identifiedTarget = target as StableOliveTarget;
  const key = deviceCacheKey(identifiedTarget, resource);
  if (memoryCache.has(key) && (!strict || durableMemoryKeys.has(key))) return memoryCache.get(key) as T;
  if (!supportsIndexedDb()) return null;
  const observedRevision = cacheWriteRevisions.get(key);
  const read = async (): Promise<T | null> => {
    const db = await database();
    let record = await cacheRead<T>(db, key);
    const endpointKey = legacyCacheKey(target, resource);
    if (!record && stableDeviceIdentity(identifiedTarget) && endpointKey !== key) {
      record = await cacheRead<T>(db, endpointKey);
      if (record) {
        if (strict) await writeDeviceCacheStrict(identifiedTarget, resource, record.value);
        else await writeDeviceCache(identifiedTarget, resource, record.value);
      }
    }
    if (!record) return null;
    publishDurableValue(key, observedRevision, record.value);
    return record.value;
  };
  if (strict) return read();
  try { return await read(); }
  catch { return null; }
}

export async function readDeviceCache<T>(target: OliveDeviceTarget, resource: string): Promise<T | null> {
  return readDeviceCacheInternal<T>(target, resource, false);
}

/**
 * Reads durable state without converting IndexedDB errors into cache misses.
 * Catalog/index callers use this when treating a missing record as a restart
 * would otherwise let them advance past data that may still exist.
 */
export async function readDeviceCacheStrict<T>(target: OliveDeviceTarget, resource: string): Promise<T | null> {
  return readDeviceCacheInternal<T>(target, resource, true);
}

/**
 * Loads many stable-namespace records through one readonly transaction. Values
 * already proven durable in the memory front cache do not open another request.
 */
export async function readDeviceCacheResourcesStrict<T>(
  target: OliveDeviceTarget,
  resources: readonly string[],
): Promise<Array<T | null>> {
  if (!resources.length) return [];
  const identifiedTarget = target as StableOliveTarget;
  const values = new Array<T | null>(resources.length).fill(null);
  const missing: Array<{ index: number; key: string; legacyKey: string | null; observedRevision: number | undefined }> = [];
  resources.forEach((resource, index) => {
    const key = deviceCacheKey(identifiedTarget, resource);
    if (memoryCache.has(key) && durableMemoryKeys.has(key)) values[index] = memoryCache.get(key) as T;
    else {
      const endpointKey = legacyCacheKey(target, resource);
      missing.push({
        index,
        key,
        legacyKey: stableDeviceIdentity(identifiedTarget) && endpointKey !== key ? endpointKey : null,
        observedRevision: cacheWriteRevisions.get(key),
      });
    }
  });
  if (!missing.length || !supportsIndexedDb()) return values;

  const db = await database();
  const records = await new Promise<Array<{
    stable: CacheRecord<T> | undefined;
    legacy: CacheRecord<T> | undefined;
  }>>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const output = Array.from({ length: missing.length }, () => ({
      stable: undefined as CacheRecord<T> | undefined,
      legacy: undefined as CacheRecord<T> | undefined,
    }));
    for (const [requestIndex, entry] of missing.entries()) {
      const request = store.get(entry.key);
      request.onsuccess = () => {
        output[requestIndex]!.stable = request.result as CacheRecord<T> | undefined;
      };
      request.onerror = () => reject(request.error ?? new Error("Device cache records could not be read."));
      if (entry.legacyKey) {
        const legacyRequest = store.get(entry.legacyKey);
        legacyRequest.onsuccess = () => {
          output[requestIndex]!.legacy = legacyRequest.result as CacheRecord<T> | undefined;
        };
        legacyRequest.onerror = () => reject(legacyRequest.error ?? new Error("Legacy device cache records could not be read."));
      }
    }
    transaction.oncomplete = () => resolve(output);
    transaction.onerror = () => reject(transaction.error ?? new Error("Device cache read transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Device cache read transaction was aborted."));
  });
  const migrations: Array<{ resource: string; value: T }> = [];
  records.forEach(({ stable, legacy }, requestIndex) => {
    const record = stable ?? legacy;
    if (!record) return;
    const entry = missing[requestIndex];
    if (!entry) return;
    if (!stable && legacy) migrations.push({ resource: resources[entry.index]!, value: legacy.value });
    else publishDurableValue(entry.key, entry.observedRevision, record.value);
    values[entry.index] = record.value;
  });
  if (migrations.length) await writeDeviceCacheResourcesStrict(target, migrations);
  return values;
}

export async function writeDeviceCache<T>(target: OliveDeviceTarget, resource: string, value: T): Promise<void> {
  const key = deviceCacheKey(target as StableOliveTarget, resource);
  const revision = reserveCacheWrite(key);
  memoryCache.set(key, value);
  durableMemoryKeys.delete(key);
  if (!supportsIndexedDb()) return;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key, savedAt: Date.now(), value } satisfies CacheRecord<T>);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Device cache write transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Device cache write transaction was aborted."));
    });
    if (cacheWriteRevisions.get(key) === revision) durableMemoryKeys.add(key);
  } catch { /* Cache failures must never block the Olive. */ }
}

/**
 * Persists before publishing to the memory front cache and surfaces all storage
 * failures. Use for manifests, chunks and checkpoints that claim resumability.
 */
export async function writeDeviceCacheStrict<T>(
  target: OliveDeviceTarget,
  resource: string,
  value: T,
): Promise<void> {
  await writeDeviceCacheResourcesStrict(target, [{ resource, value }]);
}

/**
 * Commits related durable records in one IndexedDB transaction, then publishes
 * the same values to the memory front cache. Search chunks and their manifest
 * use this to avoid a crash-visible half update.
 */
export async function writeDeviceCacheResourcesStrict(
  target: OliveDeviceTarget,
  entries: readonly { resource: string; value: unknown }[],
): Promise<void> {
  if (!entries.length) return;
  if (!supportsIndexedDb()) throw new Error("Durable device storage is unavailable.");
  const keyedEntries = new Map<string, { value: unknown; revision: number }>();
  for (const entry of entries) {
    const key = deviceCacheKey(target as StableOliveTarget, entry.resource);
    keyedEntries.set(key, { value: entry.value, revision: reserveCacheWrite(key) });
  }
  const db = await database();
  const savedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    for (const [key, entry] of keyedEntries) {
      store.put({ key, savedAt, value: entry.value } satisfies CacheRecord<unknown>);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Device cache write transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Device cache write transaction was aborted."));
  });
  for (const [key, entry] of keyedEntries) publishDurableValue(key, entry.revision, entry.value);
}

export interface DeviceCachePrefixCleanup {
  resourcePrefix: string;
  preserveResourcePrefixes?: readonly string[];
}

export interface DeviceCacheTransactionMutation<T> {
  writes: readonly { resource: string; value: unknown }[];
  deletePrefixes?: readonly DeviceCachePrefixCleanup[];
  result: T;
}

/**
 * Reads, validates, and mutates related records while holding one IndexedDB
 * readwrite transaction. IndexedDB serializes this object-store transaction
 * across tabs, preventing a stale tab from rolling a newer manifest backward.
 * The callback must stay synchronous so the browser cannot auto-close the
 * transaction before its writes are queued.
 */
export async function transactDeviceCacheResourcesStrict<T>(
  target: OliveDeviceTarget,
  resources: readonly string[],
  mutate: (values: readonly (unknown | null)[]) => DeviceCacheTransactionMutation<T>,
): Promise<T> {
  if (!supportsIndexedDb()) throw new Error("Durable device storage is unavailable.");
  const identifiedTarget = target as StableOliveTarget;
  const db = await database();
  const namespacePrefix = deviceCacheKey(identifiedTarget, "");
  const readKeys = resources.map((resource) => {
    const key = deviceCacheKey(identifiedTarget, resource);
    const endpointKey = legacyCacheKey(target, resource);
    return {
      key,
      legacyKey: stableDeviceIdentity(identifiedTarget) && endpointKey !== key ? endpointKey : null,
    };
  });
  const writeEntries = new Map<string, { value: unknown; revision: number }>();
  const deletedRevisions = new Map<string, number>();
  let mutationResult: T | undefined;
  let didMutate = false;

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const readResults = Array.from({ length: readKeys.length }, () => ({
      stable: undefined as CacheRecord<unknown> | undefined,
      legacy: undefined as CacheRecord<unknown> | undefined,
    }));
    let remainingRequests = readKeys.reduce((count, entry) => count + 1 + (entry.legacyKey ? 1 : 0), 0);
    let finalized = false;

    const finalize = () => {
      if (finalized || remainingRequests > 0) return;
      finalized = true;
      try {
        const mutation = mutate(readResults.map(({ stable, legacy }) => (stable ?? legacy)?.value ?? null));
        mutationResult = mutation.result;
        didMutate = true;
        for (const entry of mutation.writes) {
          const key = deviceCacheKey(identifiedTarget, entry.resource);
          writeEntries.set(key, { value: entry.value, revision: reserveCacheWrite(key) });
        }
        const savedAt = Date.now();
        for (const [key, entry] of writeEntries) {
          store.put({ key, savedAt, value: entry.value } satisfies CacheRecord<unknown>);
        }

        const cleanupRules = (mutation.deletePrefixes ?? []).map((rule) => ({
          keyPrefix: `${namespacePrefix}${rule.resourcePrefix}`,
          preserveKeyPrefixes: (rule.preserveResourcePrefixes ?? [])
            .map((prefix) => `${namespacePrefix}${prefix}`),
        }));
        if (cleanupRules.length) {
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const key = String(cursor.key);
            const shouldDelete = cleanupRules.some((rule) =>
              key.startsWith(rule.keyPrefix)
              && !rule.preserveKeyPrefixes.some((prefix) => key.startsWith(prefix)));
            if (shouldDelete && !writeEntries.has(key)) {
              deletedRevisions.set(key, reserveCacheWrite(key));
              cursor.delete();
            }
            cursor.continue();
          };
          cursorRequest.onerror = () => reject(
            cursorRequest.error ?? new Error("Device cache transaction cleanup could not scan records."),
          );
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };

    for (const [index, entry] of readKeys.entries()) {
      const request = store.get(entry.key);
      request.onsuccess = () => {
        readResults[index]!.stable = request.result as CacheRecord<unknown> | undefined;
        remainingRequests -= 1;
        finalize();
      };
      request.onerror = () => reject(request.error ?? new Error("Device cache transaction record could not be read."));
      if (entry.legacyKey) {
        const legacyRequest = store.get(entry.legacyKey);
        legacyRequest.onsuccess = () => {
          readResults[index]!.legacy = legacyRequest.result as CacheRecord<unknown> | undefined;
          remainingRequests -= 1;
          finalize();
        };
        legacyRequest.onerror = () => reject(
          legacyRequest.error ?? new Error("Legacy device cache transaction record could not be read."),
        );
      }
    }
    finalize();
    transaction.oncomplete = () => {
      if (!didMutate) {
        reject(new Error("Device cache transaction completed without applying its mutation."));
        return;
      }
      resolve();
    };
    transaction.onerror = () => reject(transaction.error ?? new Error("Device cache transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Device cache transaction was aborted."));
  });

  for (const [key, entry] of writeEntries) publishDurableValue(key, entry.revision, entry.value);
  for (const [key, revision] of deletedRevisions) {
    if (cacheWriteRevisions.get(key) !== revision) continue;
    memoryCache.delete(key);
    durableMemoryKeys.delete(key);
  }
  return mutationResult as T;
}

export async function deleteDeviceCacheResources(
  target: OliveDeviceTarget,
  resources: readonly string[],
): Promise<void> {
  if (!resources.length) return;
  const keys = resources.map((resource) => deviceCacheKey(target as StableOliveTarget, resource));
  for (const key of keys) {
    reserveCacheWrite(key);
    memoryCache.delete(key);
    durableMemoryKeys.delete(key);
  }
  if (!supportsIndexedDb()) return;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      for (const key of keys) store.delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Device cache cleanup transaction failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Device cache cleanup transaction was aborted."));
    });
  } catch { /* Orphan cleanup must not invalidate the newly published manifest. */ }
}

/**
 * Removes every durable resource under a stable-device prefix except the
 * explicitly retained resources. This also collects chunks orphaned by an
 * interrupted write before they were added to the manifest.
 */
export async function deleteDeviceCacheResourcesByPrefix(
  target: OliveDeviceTarget,
  resourcePrefix: string,
  keepResources: readonly string[] = [],
): Promise<void> {
  const namespacePrefix = deviceCacheKey(target as StableOliveTarget, "");
  const keyPrefix = `${namespacePrefix}${resourcePrefix}`;
  const keepKeys = new Set(keepResources.map((resource) =>
    deviceCacheKey(target as StableOliveTarget, resource)));
  for (const key of [...memoryCache.keys()]) {
    if (!key.startsWith(keyPrefix) || keepKeys.has(key)) continue;
    reserveCacheWrite(key);
    memoryCache.delete(key);
    durableMemoryKeys.delete(key);
  }
  if (!supportsIndexedDb()) return;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const request = transaction.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if (key.startsWith(keyPrefix) && !keepKeys.has(key)) {
          reserveCacheWrite(key);
          memoryCache.delete(key);
          durableMemoryKeys.delete(key);
          cursor.delete();
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Device cache prefix cleanup failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Device cache prefix cleanup was aborted."));
    });
  } catch { /* Orphan cleanup must not invalidate the manifest that retained the keep set. */ }
}

export async function clearDeviceCache(target: OliveDeviceTarget): Promise<void> {
  const identifiedTarget = target as StableOliveTarget;
  const prefixes = new Set([
    `${deviceCacheNamespace(identifiedTarget)}|`,
    `${deviceEndpointKey(target)}|`,
  ]);
  for (const key of memoryCache.keys()) {
    if ([...prefixes].some((prefix) => key.startsWith(prefix))) {
      reserveCacheWrite(key);
      memoryCache.delete(key);
      durableMemoryKeys.delete(key);
    }
  }
  if (!supportsIndexedDb()) return;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const request = transaction.objectStore(STORE_NAME).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key);
        if ([...prefixes].some((prefix) => key.startsWith(prefix))) {
          reserveCacheWrite(key);
          memoryCache.delete(key);
          durableMemoryKeys.delete(key);
          cursor.delete();
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { /* Forgetting a saved server must still work if cache cleanup fails. */ }
}

/**
 * Atomically moves old endpoint-namespaced records into the stable namespace.
 * The newest copy of a resource wins when a prior stable record already exists;
 * removing the legacy alias prevents a different Olive later assigned that IP
 * from inheriting the first device's cache.
 */
export async function adoptDeviceCacheIdentity(
  destination: StableOliveTarget,
  sources: readonly StableOliveTarget[],
): Promise<number> {
  const destinationIdentity = stableDeviceIdentity(destination);
  if (!destinationIdentity) return 0;
  const destinationPrefix = `${deviceCacheNamespace(destination)}|`;
  const destinationEndpoint = deviceEndpointKey(destination);
  const endpointIdentityConflict = sources.some((source) => {
    const sourceIdentity = stableDeviceIdentity(source);
    return deviceEndpointKey(source) === destinationEndpoint
      && sourceIdentity !== null
      && sourceIdentity !== destinationIdentity;
  });
  const sourcePrefixes = new Set<string>();
  for (const source of sources) {
    if (!canAdoptDeviceCache(source, destination)) continue;
    const sourceEndpoint = deviceEndpointKey(source);
    if (!(endpointIdentityConflict && sourceEndpoint === destinationEndpoint)) {
      sourcePrefixes.add(`${sourceEndpoint}|`);
    }
    const sourceNamespace = `${deviceCacheNamespace(source)}|`;
    if (sourceNamespace !== destinationPrefix) sourcePrefixes.add(sourceNamespace);
  }
  sourcePrefixes.delete(destinationPrefix);
  if (!sourcePrefixes.size) return 0;

  const memorySources: Array<{ key: string; destinationKey: string; value: unknown }> = [];
  for (const [key, value] of [...memoryCache.entries()]) {
    const sourcePrefix = [...sourcePrefixes].find((prefix) => key.startsWith(prefix));
    if (!sourcePrefix) continue;
    const destinationKey = `${destinationPrefix}${key.slice(sourcePrefix.length)}`;
    memorySources.push({ key, destinationKey, value });
  }
  if (!supportsIndexedDb()) {
    for (const source of memorySources) {
      if (!memoryCache.has(source.destinationKey)) {
        reserveCacheWrite(source.destinationKey);
        memoryCache.set(source.destinationKey, source.value);
        durableMemoryKeys.delete(source.destinationKey);
      }
      reserveCacheWrite(source.key);
      memoryCache.delete(source.key);
      durableMemoryKeys.delete(source.key);
    }
    return memorySources.length;
  }

  try {
    const db = await database();
    const adopted = new Map<string, CacheRecord<unknown>>();
    const destinationRevisions = new Map<string, number>();
    const sourceRevisions = new Map<string, number>();
    const memoryOnlyDestinations = new Map<string, unknown>();
    let sourceRecordCount = 0;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          const records = request.result as CacheRecord<unknown>[];
          const recordsByKey = new Map(records.map((record) => [record.key, record]));
          const sourceRecords = records.filter((record) =>
            [...sourcePrefixes].some((prefix) => record.key.startsWith(prefix)));
          sourceRecordCount = sourceRecords.length;
          for (const record of sourceRecords) {
            const sourcePrefix = [...sourcePrefixes].find((prefix) => record.key.startsWith(prefix));
            if (!sourcePrefix) continue;
            const key = `${destinationPrefix}${record.key.slice(sourcePrefix.length)}`;
            const existing = adopted.get(key) ?? recordsByKey.get(key);
            if (!existing || record.savedAt > existing.savedAt) adopted.set(key, { ...record, key });
            if (!sourceRevisions.has(record.key)) sourceRevisions.set(record.key, reserveCacheWrite(record.key));
          }
          for (const record of adopted.values()) {
            destinationRevisions.set(record.key, reserveCacheWrite(record.key));
            store.put(record);
          }
          for (const record of sourceRecords) store.delete(record.key);

          for (const source of memorySources) {
            if (!sourceRevisions.has(source.key)) {
              sourceRevisions.set(source.key, reserveCacheWrite(source.key));
            }
            if (recordsByKey.has(source.destinationKey) || adopted.has(source.destinationKey)
              || memoryCache.has(source.destinationKey)) continue;
            memoryOnlyDestinations.set(source.destinationKey, source.value);
            if (!destinationRevisions.has(source.destinationKey)) {
              destinationRevisions.set(source.destinationKey, reserveCacheWrite(source.destinationKey));
            }
          }
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
      request.onerror = () => reject(request.error ?? new Error("Device cache identity records could not be read."));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Device cache identity adoption failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Device cache identity adoption was aborted."));
    });
    for (const record of adopted.values()) {
      publishDurableValue(record.key, destinationRevisions.get(record.key), record.value);
    }
    for (const [key, value] of memoryOnlyDestinations) {
      if (cacheWriteRevisions.get(key) !== destinationRevisions.get(key)) continue;
      memoryCache.set(key, value);
      durableMemoryKeys.delete(key);
    }
    for (const [key, revision] of sourceRevisions) {
      if (cacheWriteRevisions.get(key) !== revision) continue;
      memoryCache.delete(key);
      durableMemoryKeys.delete(key);
    }
    return sourceRecordCount || memorySources.length;
  } catch {
    return 0;
  }
}
