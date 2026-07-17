import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";

const DATABASE_NAME = "olive-remote-device-cache";
const STORE_NAME = "responses";
const DATABASE_VERSION = 1;
const memoryCache = new Map<string, unknown>();
let databasePromise: Promise<IDBDatabase> | undefined;

interface CacheRecord<T> {
  key: string;
  savedAt: number;
  value: T;
}

function cacheKey(target: OliveDeviceTarget, resource: string): string {
  return `${target.host.trim().toLowerCase()}:${target.port}|${resource}`;
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

export async function readDeviceCache<T>(target: OliveDeviceTarget, resource: string): Promise<T | null> {
  const key = cacheKey(target, resource);
  if (memoryCache.has(key)) return memoryCache.get(key) as T;
  if (!("indexedDB" in window)) return null;
  try {
    const db = await database();
    const record = await new Promise<CacheRecord<T> | undefined>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as CacheRecord<T> | undefined);
      request.onerror = () => reject(request.error);
    });
    if (!record) return null;
    memoryCache.set(key, record.value);
    return record.value;
  } catch { return null; }
}

export async function writeDeviceCache<T>(target: OliveDeviceTarget, resource: string, value: T): Promise<void> {
  const key = cacheKey(target, resource);
  memoryCache.set(key, value);
  if (!("indexedDB" in window)) return;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ key, savedAt: Date.now(), value } satisfies CacheRecord<T>);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { /* Cache failures must never block the Olive. */ }
}
