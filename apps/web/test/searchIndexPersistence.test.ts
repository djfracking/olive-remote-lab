import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaestroTreeNode } from "@olive-remote-lab/olive-client";

const cacheHarness = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  strictReadGate: undefined as Promise<void> | undefined,
  deleted: [] as string[][],
}));

vi.mock("../src/deviceCache", () => ({
  readDeviceCache: vi.fn(async (_target: unknown, resource: string) =>
    cacheHarness.records.get(resource) ?? null),
  readDeviceCacheStrict: vi.fn(async (_target: unknown, resource: string) => {
    if (resource === "library:search-index-manifest:v2" && cacheHarness.strictReadGate) {
      await cacheHarness.strictReadGate;
    }
    return cacheHarness.records.get(resource) ?? null;
  }),
  readDeviceCacheResourcesStrict: vi.fn(async (_target: unknown, resources: readonly string[]) =>
    resources.map((resource) => cacheHarness.records.get(resource) ?? null)),
  writeDeviceCache: vi.fn(async (_target: unknown, resource: string, value: unknown) => {
    cacheHarness.records.set(resource, value);
  }),
  writeDeviceCacheStrict: vi.fn(async (_target: unknown, resource: string, value: unknown) => {
    cacheHarness.records.set(resource, value);
  }),
  writeDeviceCacheResourcesStrict: vi.fn(async (
    _target: unknown,
    entries: readonly { resource: string; value: unknown }[],
  ) => {
    for (const entry of entries) cacheHarness.records.set(entry.resource, entry.value);
  }),
  transactDeviceCacheResourcesStrict: vi.fn(async (
    _target: unknown,
    resources: readonly string[],
    mutate: (values: readonly (unknown | null)[]) => {
      writes: readonly { resource: string; value: unknown }[];
      deletePrefixes?: readonly {
        resourcePrefix: string;
        preserveResourcePrefixes?: readonly string[];
      }[];
      result: unknown;
    },
  ) => {
    const mutation = mutate(resources.map((resource) => cacheHarness.records.get(resource) ?? null));
    for (const entry of mutation.writes) cacheHarness.records.set(entry.resource, entry.value);
    for (const rule of mutation.deletePrefixes ?? []) {
      const deleted = [...cacheHarness.records.keys()].filter((resource) =>
        resource.startsWith(rule.resourcePrefix)
        && !(rule.preserveResourcePrefixes ?? []).some((prefix) => resource.startsWith(prefix)));
      if (deleted.length) cacheHarness.deleted.push(deleted);
      for (const resource of deleted) cacheHarness.records.delete(resource);
    }
    return mutation.result;
  }),
  deleteDeviceCacheResourcesByPrefix: vi.fn(async (
    _target: unknown,
    prefix: string,
    keep: readonly string[],
  ) => {
    const keepSet = new Set(keep);
    const deleted = [...cacheHarness.records.keys()]
      .filter((resource) => resource.startsWith(prefix) && !keepSet.has(resource));
    if (deleted.length) cacheHarness.deleted.push(deleted);
    for (const resource of deleted) cacheHarness.records.delete(resource);
  }),
}));

import {
  SEARCH_INDEX_UPDATED_EVENT,
  appendSearchScopePage,
  beginSearchScope,
  completeSearchScope,
  readSearchScope,
  searchLocalIndex,
} from "../src/searchIndex";
import { readDeviceCacheStrict } from "../src/deviceCache";

let targetCounter = 0;

function target() {
  targetCounter += 1;
  return {
    host: "192.168.0.112",
    port: 80,
    deviceId: `uuid:search-index-test-${targetCounter}`,
  };
}

function track(id: string, title: string): MaestroTreeNode {
  return {
    id,
    title,
    childCount: 0,
    userData: { type: "track", source: "upnp", upnpId: id },
  };
}

beforeEach(() => {
  cacheHarness.records.clear();
  cacheHarness.deleted.length = 0;
  cacheHarness.strictReadGate = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chunked search-index persistence", () => {
  it("uses one cold-load promise for concurrent first searches", async () => {
    let release = () => undefined;
    cacheHarness.strictReadGate = new Promise<void>((resolve) => { release = resolve; });
    const olive = target();

    const first = searchLocalIndex(olive, "abba");
    const second = searchLocalIndex(olive, "abba");
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
    expect(vi.mocked(readDeviceCacheStrict)).toHaveBeenCalledTimes(1);
  });

  it("updates page keys incrementally, coalesces events, and removes stale-generation chunks", async () => {
    vi.useFakeTimers();
    const dispatched: unknown[] = [];
    vi.stubGlobal("window", { dispatchEvent: (event: unknown) => { dispatched.push(event); } });
    vi.stubGlobal("CustomEvent", class {
      constructor(public type: string, public init: unknown) {}
    });
    const olive = target();

    await beginSearchScope(olive, "tracks", "20001");
    await appendSearchScopePage(olive, "tracks", "20001", "0", [
      track("UPNP-1", "Alpha"),
      track("UPNP-2", "Beta"),
    ]);
    await appendSearchScopePage(olive, "tracks", "20001", "64", [
      track("UPNP-3", "Gamma"),
    ]);
    await completeSearchScope(olive, "tracks", "20001");
    cacheHarness.records.set("library:search-index-chunk:v2:tracks:orphan:999", []);

    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id).sort())
      .toEqual(["UPNP-1", "UPNP-2", "UPNP-3"]);
    expect(dispatched).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(350);
    expect(dispatched).toHaveLength(1);
    expect((dispatched[0] as { type: string }).type).toBe(SEARCH_INDEX_UPDATED_EVENT);

    await appendSearchScopePage(olive, "tracks", "20001", "0", [
      track("UPNP-4", "Delta"),
    ]);
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id).sort())
      .toEqual(["UPNP-3", "UPNP-4"]);
    expect((await searchLocalIndex(olive, "gamma")).map((entry) => entry.item.id)).toEqual(["UPNP-3"]);

    await beginSearchScope(olive, "tracks", "20002");
    expect(await readSearchScope(olive, "tracks")).toEqual([]);
    expect(cacheHarness.deleted.at(-1)).toEqual([
      "library:search-index-chunk:v2:tracks:20001:0",
      "library:search-index-chunk:v2:tracks:20001:64",
      "library:search-index-chunk:v2:tracks:orphan:999",
    ]);
  });

  it("can replace a generation whose old manifest references a missing chunk", async () => {
    cacheHarness.records.set("library:search-index-manifest:v2", {
      version: 2,
      scopes: {
        tracks: {
          generation: "20001",
          chunks: ["library:search-index-chunk:v2:tracks:20001:0"],
          count: 64,
          complete: false,
        },
      },
    });
    const olive = target();

    await expect(beginSearchScope(olive, "tracks", "20002")).resolves.toBeUndefined();
    await expect(appendSearchScopePage(olive, "tracks", "20002", "0", [
      track("UPNP-9", "Recovered"),
    ])).resolves.toBe(1);
    expect((await readSearchScope(olive, "tracks")).map((entry) => entry.item.id)).toEqual(["UPNP-9"]);
  });

  it("rejects a stale append without rolling the manifest back", async () => {
    const olive = target();
    await beginSearchScope(olive, "tracks", "20001");
    await beginSearchScope(olive, "tracks", "20002");

    await expect(appendSearchScopePage(olive, "tracks", "20001", "0", [
      track("UPNP-OLD", "Old generation"),
    ])).rejects.toThrow("Cannot append stale tracks search generation.");

    expect(cacheHarness.records.has("library:search-index-chunk:v2:tracks:20001:0")).toBe(false);
    expect(cacheHarness.records.get("library:search-index-manifest:v2")).toMatchObject({
      scopes: { tracks: { generation: "20002", chunks: [] } },
    });
  });

  it("purges fanout chunks when the same revision switches to flat fallback", async () => {
    const olive = target();
    await beginSearchScope(olive, "tracks", "20001.tracks-45683.album-fanout");
    await appendSearchScopePage(olive, "tracks", "20001.tracks-45683.album-fanout", "album-0-offset-0", [
      track("ROOT_ALLAL_AL10_TR100", "Fanout"),
    ]);

    await beginSearchScope(olive, "tracks", "20001");

    expect(cacheHarness.deleted.at(-1)).toEqual([
      "library:search-index-chunk:v2:tracks:20001.tracks-45683.album-fanout:album-0-offset-0",
    ]);
    expect(await readSearchScope(olive, "tracks")).toEqual([]);
  });

  it("keeps the best bounded search results in score order", async () => {
    const olive = target();
    await beginSearchScope(olive, "tracks", "20003");
    await appendSearchScopePage(olive, "tracks", "20003", "0", [
      track("UPNP-EXACT", "Abba"),
      track("UPNP-PREFIX", "Abba Gold"),
      track("UPNP-WORD", "The Abba Collection"),
    ]);

    expect((await searchLocalIndex(olive, "abba", 2)).map((entry) => entry.item.id))
      .toEqual(["UPNP-EXACT", "UPNP-PREFIX"]);
  });
});
