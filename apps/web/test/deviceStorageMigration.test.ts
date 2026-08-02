import { describe, expect, it } from "vitest";
import {
  adoptDeviceLocalStorage,
  ARTWORK_PATH_STORAGE_KEY,
  PLAYBACK_METADATA_STORAGE_KEY,
  PLAYBACK_QUEUE_STORAGE_PREFIX,
} from "../src/deviceStorageMigration";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe("stable device localStorage adoption", () => {
  it("copies queue, metadata, and artwork paths to the stable namespace", () => {
    const storage = new MemoryStorage();
    const oldNamespace = "192.168.0.124:80";
    const stableNamespace = "upnp:uuid:olive-a";
    storage.setItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}${oldNamespace}`, JSON.stringify([
      { queueId: "q1", itemId: "track-1", title: "One" },
    ]));
    storage.setItem(PLAYBACK_METADATA_STORAGE_KEY, JSON.stringify({
      [`${oldNamespace}:track-1`]: { cachedAt: 20, metadata: { title: "One" } },
    }));
    storage.setItem(ARTWORK_PATH_STORAGE_KEY, JSON.stringify([
      [`${oldNamespace}:album-1`, "http://192.168.0.124/server/getArtwork.php?id=album-1"],
    ]));

    expect(adoptDeviceLocalStorage(
      { host: "192.168.0.124", port: 80, deviceId: "uuid:olive-a" },
      [{ host: "192.168.0.124", port: 80 }],
      storage,
    )).toBe(3);
    expect(JSON.parse(storage.getItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}${stableNamespace}`) ?? "[]")).toHaveLength(1);
    expect(storage.getItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}${oldNamespace}`)).toBeNull();
    expect(JSON.parse(storage.getItem(PLAYBACK_METADATA_STORAGE_KEY) ?? "{}")).toHaveProperty(`${stableNamespace}:track-1`);
    const artworkPaths = new Map(JSON.parse(storage.getItem(ARTWORK_PATH_STORAGE_KEY) ?? "[]"));
    expect(artworkPaths.has(`${oldNamespace}:album-1`)).toBe(false);
    expect(artworkPaths.get(`${stableNamespace}:album-1`))
      .toContain("192.168.0.124");
  });

  it("moves known identity state across DHCP without merging another Olive", () => {
    const storage = new MemoryStorage();
    storage.setItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}192.168.0.124:80`, JSON.stringify([
      { queueId: "q1", itemId: "track-a" },
    ]));
    storage.setItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}192.168.0.113:80`, JSON.stringify([
      { queueId: "q2", itemId: "track-b" },
    ]));

    adoptDeviceLocalStorage(
      { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-a" },
      [
        { host: "192.168.0.124", port: 80, deviceId: "uuid:olive-a" },
        { host: "192.168.0.113", port: 80, deviceId: "uuid:olive-b" },
      ],
      storage,
    );
    expect(JSON.parse(storage.getItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}upnp:uuid:olive-a`) ?? "[]"))
      .toEqual([{ queueId: "q1", itemId: "track-a" }]);
  });

  it("refuses to adopt an unidentified cache from a different address", () => {
    const storage = new MemoryStorage();
    storage.setItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}192.168.0.124:80`, JSON.stringify([{ queueId: "q1" }]));
    expect(adoptDeviceLocalStorage(
      { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-a" },
      [{ host: "192.168.0.124", port: 80 }],
      storage,
    )).toBe(0);
    expect(storage.getItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}upnp:uuid:olive-a`)).toBeNull();
  });

  it("quarantines an endpoint cache when a different known Olive owned that address", () => {
    const storage = new MemoryStorage();
    storage.setItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}192.168.0.112:80`, JSON.stringify([{ queueId: "old" }]));
    expect(adoptDeviceLocalStorage(
      { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-a" },
      [
        { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-a" },
        { host: "192.168.0.112", port: 80, deviceId: "uuid:olive-b" },
      ],
      storage,
    )).toBe(0);
    expect(storage.getItem(`${PLAYBACK_QUEUE_STORAGE_PREFIX}upnp:uuid:olive-a`)).toBeNull();
  });
});
