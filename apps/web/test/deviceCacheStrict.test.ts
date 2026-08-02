import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readDeviceCache,
  readDeviceCacheResourcesStrict,
  readDeviceCacheStrict,
  writeDeviceCache,
  writeDeviceCacheStrict,
} from "../src/deviceCache";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("strict device-cache durability", () => {
  it("does not mistake a memory-only lenient write for durable catalog state", async () => {
    vi.stubGlobal("window", {});
    const target = { host: "192.168.0.112", port: 80, deviceId: "uuid:strict-cache-test" };
    const resource = "library:test:memory-only";

    await writeDeviceCache(target, resource, { value: 1 });

    await expect(readDeviceCache(target, resource)).resolves.toEqual({ value: 1 });
    await expect(readDeviceCacheStrict(target, resource)).resolves.toBeNull();
    await expect(readDeviceCacheResourcesStrict(target, [resource])).resolves.toEqual([null]);
    await expect(writeDeviceCacheStrict(target, resource, { value: 2 }))
      .rejects.toThrow("Durable device storage is unavailable.");
  });

  it("does not mark a newer failed memory value durable when an older write finishes later", async () => {
    const records = new Map<string, unknown>();
    const writes: Array<{
      record: { key: string; value: unknown };
      transaction: {
        error: Error | null;
        oncomplete?: () => void;
        onerror?: () => void;
        onabort?: () => void;
      };
    }> = [];
    const database = {
      transaction: (_storeName: string, mode: "readonly" | "readwrite") => {
        const transaction: {
          error: Error | null;
          oncomplete?: () => void;
          onerror?: () => void;
          onabort?: () => void;
          objectStore: () => {
            put: (record: { key: string; value: unknown }) => void;
            get: (key: string) => {
              result?: unknown;
              error: Error | null;
              onsuccess?: () => void;
              onerror?: () => void;
            };
          };
        } = {
          error: null,
          objectStore: () => ({
            put: (record) => { writes.push({ record, transaction }); },
            get: (key) => {
              const request: {
                result?: unknown;
                error: Error | null;
                onsuccess?: () => void;
                onerror?: () => void;
              } = { error: null };
              queueMicrotask(() => {
                request.result = records.get(key);
                request.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return request;
            },
          }),
        };
        expect(mode === "readonly" || mode === "readwrite").toBe(true);
        return transaction;
      },
    };
    vi.stubGlobal("indexedDB", {
      open: () => {
        const request: {
          result?: unknown;
          error: Error | null;
          onsuccess?: () => void;
          onerror?: () => void;
          onupgradeneeded?: () => void;
        } = { error: null };
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess?.();
        });
        return request;
      },
    });

    const target = { host: "192.168.0.113", port: 80, deviceId: "uuid:strict-cache-race" };
    const resource = "library:test:write-race";
    const older = writeDeviceCache(target, resource, { value: "older" });
    const newer = writeDeviceCache(target, resource, { value: "newer" });
    await vi.waitFor(() => expect(writes).toHaveLength(2));

    writes[1]!.transaction.error = new Error("simulated quota failure");
    writes[1]!.transaction.onabort?.();
    records.set(writes[0]!.record.key, writes[0]!.record);
    writes[0]!.transaction.oncomplete?.();
    await Promise.all([older, newer]);

    await expect(readDeviceCacheStrict(target, resource)).resolves.toEqual({ value: "older" });
  });
});
