import type {
  LibrarySearchScope,
  MaestroBrowseRequest,
  MaestroTree,
  MaestroTreeNode,
  OliveDeviceTarget,
} from "@olive-remote-lab/olive-client";
import { appFetch } from "./nativeApi";
import {
  readDeviceCacheStrict,
  writeDeviceCacheStrict as writeDeviceCacheStrictRaw,
} from "./deviceCache";
import {
  deviceCacheNamespace,
  deviceRequestKey,
  type StableOliveTarget,
} from "./deviceIdentity";
import {
  appendSearchScopePage as appendSearchScopePageRaw,
  beginSearchScope as beginSearchScopeRaw,
  completeSearchScope as completeSearchScopeRaw,
  readSearchScope,
  type SearchDocument,
} from "./searchIndex";
import {
  UPNP_CATALOG_ROOTS,
  isUpnpTreeNode,
  targetSupportsContentDirectory,
  upnpPageToTree,
  type UpnpCatalogPage,
} from "./upnpCatalog";

const MANIFEST_RESOURCE = "library:catalog-manifest:v2";
const CHECKPOINT_PREFIX = "library:catalog-checkpoint:v2";
export const ARTIST_INDEX_RESOURCE = "library:artist-index:v2";
const LEGACY_REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_SCOPE_ITEMS = 150_000;
const PAGE_SIZE = 64;
const activeCatalogEndpoints = new Map<string, string>();

export const LIBRARY_SEARCH_SCOPES = [
  "artists",
  "albums",
  "genres",
  "playlists",
  "composers",
  "tracks",
] as const satisfies readonly LibrarySearchScope[];
export const AUTOMATIC_CATALOG_SCOPES = LIBRARY_SEARCH_SCOPES;

export interface CatalogScopeCursor {
  nextStartingIndex: number;
  totalMatches: number | null;
  itemCount: number;
  complete: boolean;
  containerUpdateId: string | null;
  strategy?: "flat" | "album-fanout";
  parentIndex?: number;
  parentStartingIndex?: number;
  parentFailureIndex?: number;
  parentFailureCount?: number;
  flatFallback?: boolean;
}

export interface LibraryCatalogManifest {
  version: 2;
  protocol: "upnp" | "maestro";
  deviceId: string;
  updateId: string | null;
  complete: boolean;
  completedAt: number;
  itemCount: number;
  scopes: Partial<Record<LibrarySearchScope, number>>;
  cursors: Partial<Record<LibrarySearchScope, CatalogScopeCursor>>;
}

export interface LibraryCatalogProgress {
  phase: "syncing" | "complete" | "error";
  scope: LibrarySearchScope | null;
  scopeItems: number;
  scopeTotal: number | null;
  itemCount: number;
  message?: string;
}

interface ScopeCheckpoint extends CatalogScopeCursor {
  version: 2;
  protocol: "upnp" | "maestro";
  updateId: string;
}

export interface ArtistIndexCache {
  version: 2;
  deviceId: string;
  updateId: string | null;
  completedAt: number;
  tree: MaestroTree;
}

interface CatalogStatus {
  available: boolean;
  sampledAt: number;
  updateId?: string;
  searchCapabilities?: string[];
  sortCapabilities?: string[];
}

interface ScopeConfig {
  scope: LibrarySearchScope;
  upnpId: string;
  legacyId: string;
  legacyType: MaestroBrowseRequest["type"];
  legacyPageSize: number;
  legacyPaged: boolean;
}

const SCOPE_CONFIGS: Record<LibrarySearchScope, ScopeConfig> = {
  artists: { scope: "artists", upnpId: UPNP_CATALOG_ROOTS.artists, legacyId: "artists", legacyType: "artists", legacyPageSize: 21, legacyPaged: true },
  albums: { scope: "albums", upnpId: UPNP_CATALOG_ROOTS.albums, legacyId: "albumname", legacyType: "albumname", legacyPageSize: 21, legacyPaged: true },
  tracks: { scope: "tracks", upnpId: UPNP_CATALOG_ROOTS.tracks, legacyId: "tracks", legacyType: "track", legacyPageSize: 64, legacyPaged: true },
  genres: { scope: "genres", upnpId: UPNP_CATALOG_ROOTS.genres, legacyId: "genres", legacyType: "genre", legacyPageSize: 21, legacyPaged: false },
  playlists: { scope: "playlists", upnpId: UPNP_CATALOG_ROOTS.playlists, legacyId: "playlists", legacyType: "playlist", legacyPageSize: 21, legacyPaged: false },
  composers: { scope: "composers", upnpId: UPNP_CATALOG_ROOTS.composers, legacyId: "composers", legacyType: "composer", legacyPageSize: 21, legacyPaged: true },
};

const activeSyncs = new Map<string, Promise<LibraryCatalogManifest>>();

function targetKey(target: OliveDeviceTarget): string {
  return deviceCacheNamespace(target as StableOliveTarget);
}

function assertCurrentCatalogEndpoint(target: OliveDeviceTarget): void {
  const expected = activeCatalogEndpoints.get(targetKey(target));
  if (
    expected
    && expected !== deviceRequestKey(target as StableOliveTarget)
  ) {
    throw new DOMException("Library sync target changed.", "AbortError");
  }
}

async function writeDeviceCacheStrict(
  target: OliveDeviceTarget,
  resource: string,
  value: unknown,
): Promise<void> {
  assertCurrentCatalogEndpoint(target);
  await writeDeviceCacheStrictRaw(target, resource, value);
  assertCurrentCatalogEndpoint(target);
}

async function beginSearchScope(
  target: OliveDeviceTarget,
  scope: LibrarySearchScope,
  generation: string,
): Promise<void> {
  assertCurrentCatalogEndpoint(target);
  await beginSearchScopeRaw(target, scope, generation);
  assertCurrentCatalogEndpoint(target);
}

async function appendSearchScopePage(
  target: OliveDeviceTarget,
  scope: LibrarySearchScope,
  generation: string,
  chunkId: string,
  items: MaestroTreeNode[],
): Promise<number> {
  assertCurrentCatalogEndpoint(target);
  const count = await appendSearchScopePageRaw(target, scope, generation, chunkId, items);
  assertCurrentCatalogEndpoint(target);
  return count;
}

async function completeSearchScope(
  target: OliveDeviceTarget,
  scope: LibrarySearchScope,
  generation: string,
): Promise<void> {
  assertCurrentCatalogEndpoint(target);
  await completeSearchScopeRaw(target, scope, generation);
  assertCurrentCatalogEndpoint(target);
}

function checkpointResource(scope: LibrarySearchScope): string {
  return `${CHECKPOINT_PREFIX}:${scope}`;
}

function albumFanoutGeneration(updateId: string, totalMatches: number): string {
  return `${updateId}.tracks-${totalMatches}.album-fanout`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Library sync cancelled.", "AbortError");
}

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? fallback);
  return data;
}

async function catalogStatus(target: OliveDeviceTarget, signal?: AbortSignal): Promise<CatalogStatus> {
  const response = await appFetch("/api/upnp/catalog-status", {
    method: "POST",
    headers: { "content-type": "application/json", "x-olive-request-priority": "background" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify(target),
  });
  const status = await responseJson<CatalogStatus>(response, "Could not read the Olive catalog revision.");
  throwIfAborted(signal);
  assertCurrentCatalogEndpoint(target);
  return status;
}

async function browseUpnp(
  target: OliveDeviceTarget,
  config: ScopeConfig,
  startingIndex: number,
  signal?: AbortSignal,
  objectId = config.upnpId,
  requestedCount = PAGE_SIZE,
): Promise<UpnpCatalogPage> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      throwIfAborted(signal);
      const response = await appFetch("/api/upnp/browse", {
        method: "POST",
        headers: { "content-type": "application/json", "x-olive-request-priority": "background" },
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          target,
          objectId,
          startingIndex,
          requestedCount,
        }),
      });
      const page = await responseJson<UpnpCatalogPage>(response, `${config.scope} download failed.`);
      throwIfAborted(signal);
      assertCurrentCatalogEndpoint(target);
      return page;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function browseLegacy(
  target: OliveDeviceTarget,
  config: ScopeConfig,
  startingIndex: number,
  signal?: AbortSignal,
): Promise<MaestroTree> {
  const response = await appFetch("/api/library/browse", {
    method: "POST",
    headers: { "content-type": "application/json", "x-olive-request-priority": "background" },
    ...(signal ? { signal } : {}),
    body: JSON.stringify({
      target,
      browse: {
        id: config.legacyId,
        type: config.legacyType,
        startIndex: startingIndex,
        index: Math.floor(startingIndex / config.legacyPageSize),
      },
    }),
  });
  const tree = await responseJson<MaestroTree>(response, `${config.scope} download failed.`);
  throwIfAborted(signal);
  assertCurrentCatalogEndpoint(target);
  return tree;
}

export function nextCatalogCursor(startingIndex: number, numberReturned: number): number {
  if (!Number.isSafeInteger(startingIndex) || startingIndex < 0) throw new Error("Invalid catalog cursor.");
  if (!Number.isSafeInteger(numberReturned) || numberReturned < 0) throw new Error("Invalid NumberReturned.");
  return startingIndex + numberReturned;
}

export function canResumeCatalogRevision(
  checkpoint: Pick<ScopeCheckpoint, "protocol" | "updateId"> | null,
  protocol: ScopeCheckpoint["protocol"],
  updateId: string,
): boolean {
  return checkpoint?.protocol === protocol && checkpoint.updateId === updateId;
}

export function canPublishCatalogRevision(
  startedUpdateId: string,
  finishedUpdateId: string | null | undefined,
  cursors: Partial<Record<LibrarySearchScope, CatalogScopeCursor>>,
): boolean {
  return Boolean(startedUpdateId)
    && finishedUpdateId === startedUpdateId
    && AUTOMATIC_CATALOG_SCOPES.every((scope) => cursors[scope]?.complete === true);
}

export function trackCatalogSnapshotMatches(
  cursor: CatalogScopeCursor | undefined,
  observedTotal: number | null,
): boolean {
  if (
    cursor?.complete !== true
    || cursor.totalMatches === null
    || observedTotal === null
    || cursor.totalMatches !== observedTotal
  ) return false;
  const shortfall = cursor.totalMatches - cursor.itemCount;
  return cursor.strategy === "album-fanout"
    ? shortfall >= 0 && shortfall <= 1
    : shortfall === 0;
}

/**
 * ContentDirectory permits TotalMatches=0 when the server cannot calculate a
 * total. A non-empty page therefore turns zero into "unknown" instead of
 * incorrectly declaring the first page complete.
 */
export function upnpTotalMatches(
  reportedTotal: number,
  numberReturned: number,
  itemsAlreadySeen = 0,
): number | null {
  return reportedTotal === 0 && (numberReturned > 0 || itemsAlreadySeen > 0) ? null : reportedTotal;
}

export function upnpCatalogPageFinished(input: {
  startingIndex: number;
  numberReturned: number;
  requestedCount: number;
  totalMatches: number | null;
}): boolean {
  const nextStartingIndex = nextCatalogCursor(input.startingIndex, input.numberReturned);
  if (input.numberReturned === 0) {
    if (input.totalMatches !== null && input.startingIndex < input.totalMatches) {
      throw new Error("The Olive returned an empty page before the reported end.");
    }
    return true;
  }
  if (input.totalMatches !== null) return nextStartingIndex >= input.totalMatches;
  return input.numberReturned < input.requestedCount;
}

export function advanceAlbumFanoutCursor(input: {
  parentIndex: number;
  parentStartingIndex: number;
  parentContainerUpdateId: string | null;
  pageUpdateId: string;
  numberReturned: number;
  totalMatches: number;
  requestedCount?: number;
}): {
  parentIndex: number;
  parentStartingIndex: number;
  parentContainerUpdateId: string | null;
  albumFinished: boolean;
} {
  const observedUpdateId = input.pageUpdateId || null;
  if (
    observedUpdateId
    && input.parentContainerUpdateId
    && observedUpdateId !== input.parentContainerUpdateId
  ) {
    throw new Error("An Olive album changed during download. Resume to restart the latest catalog revision.");
  }
  const containerUpdateId = input.parentContainerUpdateId ?? observedUpdateId;
  const albumTotal = upnpTotalMatches(
    input.totalMatches,
    input.numberReturned,
    input.parentStartingIndex,
  );
  const albumFinished = upnpCatalogPageFinished({
    startingIndex: input.parentStartingIndex,
    numberReturned: input.numberReturned,
    requestedCount: input.requestedCount ?? PAGE_SIZE,
    totalMatches: albumTotal,
  });
  return albumFinished
    ? {
        parentIndex: input.parentIndex + 1,
        parentStartingIndex: 0,
        parentContainerUpdateId: null,
        albumFinished,
      }
    : {
        parentIndex: input.parentIndex,
        parentStartingIndex: nextCatalogCursor(input.parentStartingIndex, input.numberReturned),
        parentContainerUpdateId: containerUpdateId,
        albumFinished,
      };
}

function completedCount(scopes: Partial<Record<LibrarySearchScope, number>>, except?: LibrarySearchScope): number {
  return Object.entries(scopes).reduce((sum, [scope, count]) =>
    scope === except ? sum : sum + (count ?? 0), 0);
}

export function canResumeAlbumFanout(
  checkpoint: {
    protocol: "upnp" | "maestro";
    updateId: string;
    strategy?: "flat" | "album-fanout";
    parentIndex?: number;
    parentStartingIndex?: number;
  } | null,
  updateId: string,
): boolean {
  return canResumeCatalogRevision(checkpoint, "upnp", updateId)
    && checkpoint?.strategy === "album-fanout"
    && Number.isSafeInteger(checkpoint.parentIndex)
    && (checkpoint.parentIndex ?? -1) >= 0
    && Number.isSafeInteger(checkpoint.parentStartingIndex)
    && (checkpoint.parentStartingIndex ?? -1) >= 0;
}

export function canResumeFlatUpnpCatalog(
  checkpoint: {
    protocol: "upnp" | "maestro";
    updateId: string;
    strategy?: "flat" | "album-fanout";
  } | null,
  updateId: string,
): boolean {
  return canResumeCatalogRevision(checkpoint, "upnp", updateId)
    && checkpoint?.strategy !== "album-fanout";
}

export function shouldContinueFlatTrackFallback(
  checkpoint: {
    protocol: "upnp" | "maestro";
    updateId: string;
    strategy?: "flat" | "album-fanout";
    flatFallback?: boolean;
  } | null,
  updateId: string,
): boolean {
  return canResumeFlatUpnpCatalog(checkpoint, updateId)
    && checkpoint?.flatFallback === true;
}

export function nextAlbumFanoutFailure(
  savedFailureIndex: number | undefined,
  savedFailureCount: number | undefined,
  parentIndex: number,
): { parentFailureIndex: number; parentFailureCount: number; shouldFallback: boolean } {
  const parentFailureCount = savedFailureIndex === parentIndex
    ? Math.max(0, savedFailureCount ?? 0) + 1
    : 1;
  return {
    parentFailureIndex: parentIndex,
    parentFailureCount,
    shouldFallback: parentFailureCount >= 3,
  };
}

export function albumFanoutMatchesTrackTotal(
  expectedTotal: number | null,
  documents: readonly SearchDocument[],
): boolean {
  if (expectedTotal === null) return false;
  const trackIds = canonicalAlbumFanoutTrackIds(documents);
  return trackIds?.size === expectedTotal && documents.length === expectedTotal;
}

function canonicalAlbumFanoutTrackIds(
  documents: readonly SearchDocument[],
): Set<string> | null {
  const trackIds = new Set<string>();
  for (const document of documents) {
    const item = document.item;
    if (
      document.scope !== "tracks"
      || !isUpnpTreeNode(item)
      || item.userData.objectKind !== "item"
      || item.userData.type !== "track"
    ) return null;
    const match = (item.userData.upnpId || item.id).match(/^ROOT_ALLAL_AL[0-9]+_TR([0-9]+)$/);
    if (!match || trackIds.has(match[1]!)) return null;
    trackIds.add(match[1]!);
  }
  return trackIds;
}

export function albumFanoutCoversExhaustedTrackRoot(
  expectedTotal: number | null,
  documents: readonly SearchDocument[],
  rootPage: Pick<UpnpCatalogPage, "numberReturned" | "totalMatches" | "objects">,
  boundaryPage: Pick<UpnpCatalogPage, "numberReturned" | "totalMatches" | "objects">,
): boolean {
  if (expectedTotal === null) return false;
  const trackIds = canonicalAlbumFanoutTrackIds(documents);
  const reportedShortfall = expectedTotal - documents.length;
  return trackIds?.size === documents.length
    && expectedTotal > 0
    && reportedShortfall === 1
    && rootPage.totalMatches === expectedTotal
    && rootPage.numberReturned === 1
    && rootPage.objects.length === 1
    && boundaryPage.totalMatches === expectedTotal
    && boundaryPage.numberReturned === 0
    && boundaryPage.objects.length === 0;
}

export function flatTrackIndexMatchesCrawl(
  itemCount: number,
  totalMatches: number | null,
  documents: readonly SearchDocument[],
): boolean {
  if (documents.length !== itemCount) return false;
  if (totalMatches !== null && itemCount !== totalMatches) return false;
  const terminalTrackIds = new Set(documents.flatMap((document) => {
    const item = document.item;
    if (
      document.scope !== "tracks"
      || !isUpnpTreeNode(item)
      || item.userData.objectKind !== "item"
      || item.userData.type !== "track"
    ) return [];
    const match = (item.userData.upnpId || item.id)
      .match(/^(?:ROOT_ALLAU|ROOT_ALLAL_AL[0-9]+)_TR([0-9]+)$/);
    return match ? [match[1]!] : [];
  }));
  return terminalTrackIds.size === itemCount;
}

class AlbumFanoutUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AlbumFanoutUnavailableError";
  }
}

function canonicalAlbumContainers(
  documents: readonly SearchDocument[],
  expectedCount: number | undefined,
): MaestroTreeNode[] | null {
  if (expectedCount === undefined) return null;
  const albums = [...new Map(documents.flatMap((document) => {
    const item = document.item;
    if (
      document.scope !== "albums"
      || !isUpnpTreeNode(item)
      || item.userData.objectKind !== "container"
      || !/^ROOT_ALLAL_AL[0-9]+$/.test(item.userData.upnpId || item.id)
    ) return [];
    return [[item.userData.upnpId || item.id, item] as const];
  })).values()];
  if (albums.length !== expectedCount) return null;
  return albums.sort((left, right) => {
    const leftId = Number((left.userData.upnpId || left.id).match(/_AL([0-9]+)$/)?.[1]);
    const rightId = Number((right.userData.upnpId || right.id).match(/_AL([0-9]+)$/)?.[1]);
    return leftId - rightId;
  });
}

export function artistIndexMatchesCatalog(
  value: ArtistIndexCache | null,
  manifest: LibraryCatalogManifest | null,
): value is ArtistIndexCache {
  return value?.version === 2
    && Number.isFinite(value.completedAt)
    && Array.isArray(value.tree?.items)
    && manifest?.version === 2
    && value.deviceId === manifest.deviceId
    && value.updateId === manifest.updateId
    && manifest.cursors.artists?.complete === true
    && manifest.scopes.artists === value.tree.items.length;
}

async function publishArtistIndex(
  target: OliveDeviceTarget,
  manifest: LibraryCatalogManifest,
): Promise<void> {
  const documents = await readSearchScope(target, "artists");
  const items = [...new Map(documents.map((document) => [document.item.id, document.item])).values()];
  const expectedCount = manifest.scopes.artists;
  if (expectedCount === undefined || manifest.cursors.artists?.complete !== true) {
    throw new Error("Cannot publish the artist index before the artist catalog is complete.");
  }
  if (items.length !== expectedCount) {
    throw new Error(`The artist index contains ${items.length.toLocaleString()} of ${expectedCount.toLocaleString()} expected artists.`);
  }
  await writeDeviceCacheStrict(target, ARTIST_INDEX_RESOURCE, {
    version: 2,
    deviceId: manifest.deviceId,
    updateId: manifest.updateId,
    completedAt: Date.now(),
    tree: { id: UPNP_CATALOG_ROOTS.artists, totalItems: items.length, items },
  } satisfies ArtistIndexCache);
}

async function ensureArtistIndex(
  target: OliveDeviceTarget,
  manifest: LibraryCatalogManifest,
): Promise<void> {
  const cached = await readDeviceCacheStrict<ArtistIndexCache>(target, ARTIST_INDEX_RESOURCE);
  if (!artistIndexMatchesCatalog(cached, manifest)) await publishArtistIndex(target, manifest);
}

async function crawlUpnpScope(
  target: OliveDeviceTarget,
  config: ScopeConfig,
  updateId: string,
  scopeCounts: Partial<Record<LibrarySearchScope, number>>,
  report: (progress: LibraryCatalogProgress) => void,
  allowResume: boolean,
  signal?: AbortSignal,
  markAsFallback = false,
): Promise<CatalogScopeCursor> {
  const saved = await readDeviceCacheStrict<ScopeCheckpoint>(target, checkpointResource(config.scope));
  let resume = allowResume && canResumeFlatUpnpCatalog(saved, updateId);
  if (resume && config.scope === "tracks") {
    const rootProbe = await browseUpnp(target, config, 0, signal, config.upnpId, 1);
    if (rootProbe.numberReturned !== rootProbe.objects.length) {
      throw new Error("The Olive tracks root returned inconsistent UPnP counts.");
    }
    const observedTotal = upnpTotalMatches(rootProbe.totalMatches, rootProbe.numberReturned);
    const sameTotal = saved!.totalMatches !== null
      && observedTotal !== null
      && saved!.totalMatches === observedTotal;
    const sameContainer = !saved!.containerUpdateId
      || !rootProbe.updateId
      || saved!.containerUpdateId === rootProbe.updateId;
    resume = sameTotal && sameContainer;
  }
  const flatFallback = markAsFallback || saved?.flatFallback === true;
  let startingIndex = resume ? saved!.nextStartingIndex : 0;
  let itemCount = resume ? saved!.itemCount : 0;
  let totalMatches = resume ? saved!.totalMatches : null;
  let containerUpdateId = resume ? saved!.containerUpdateId ?? null : null;

  if (resume && saved!.complete) {
    if (config.scope === "tracks") {
      const documents = await readSearchScope(target, "tracks");
      if (!flatTrackIndexMatchesCrawl(saved!.itemCount, saved!.totalMatches, documents)) {
        throw new Error("The saved flat track crawl does not contain its reported unique track total.");
      }
    }
    await completeSearchScope(target, config.scope, updateId);
    return saved!;
  }
  if (!resume) {
    await writeDeviceCacheStrict(target, checkpointResource(config.scope), {
      version: 2,
      protocol: "upnp",
      updateId,
      nextStartingIndex: 0,
      totalMatches: null,
      itemCount: 0,
      complete: false,
      containerUpdateId: null,
      strategy: "flat",
      ...(flatFallback ? { flatFallback: true } : {}),
    } satisfies ScopeCheckpoint);
  }
  if (!resume || (itemCount === 0 && startingIndex === 0)) {
    await beginSearchScope(target, config.scope, updateId);
  }
  while (itemCount < MAX_SCOPE_ITEMS) {
    throwIfAborted(signal);
    const page = await browseUpnp(target, config, startingIndex, signal);
    if (page.updateId && containerUpdateId && page.updateId !== containerUpdateId) {
      throw new Error(`The Olive ${config.scope} section changed during download. Resume to restart that section cleanly.`);
    }
    containerUpdateId = containerUpdateId ?? (page.updateId || null);
    const observedTotal = upnpTotalMatches(page.totalMatches, page.numberReturned, itemCount);
    if (observedTotal !== null) {
      if (
        config.scope === "tracks"
        && totalMatches !== null
        && observedTotal !== totalMatches
      ) {
        throw new Error(
          `The Olive track total changed from ${totalMatches.toLocaleString()} to `
          + `${observedTotal.toLocaleString()} during indexing. Retrying the latest catalog.`,
        );
      }
      totalMatches = observedTotal;
    }
    if (page.numberReturned !== page.objects.length) {
      throw new Error(`${config.scope} returned inconsistent UPnP page counts.`);
    }
    const tree = upnpPageToTree(target as StableOliveTarget, page, config.scope);
    await appendSearchScopePage(target, config.scope, updateId, String(startingIndex), tree.items);
    startingIndex = nextCatalogCursor(startingIndex, page.numberReturned);
    itemCount += page.numberReturned;
    const reachedEnd = upnpCatalogPageFinished({
      startingIndex: startingIndex - page.numberReturned,
      numberReturned: page.numberReturned,
      requestedCount: PAGE_SIZE,
      totalMatches,
    });
    const hitSafetyCeiling = itemCount > MAX_SCOPE_ITEMS
      || (!reachedEnd && itemCount >= MAX_SCOPE_ITEMS);
    const finished = reachedEnd && !hitSafetyCeiling;
    if (finished && config.scope === "tracks") {
      const finalRootProbe = await browseUpnp(
        target,
        config,
        0,
        signal,
        config.upnpId,
        1,
      );
      if (finalRootProbe.numberReturned !== finalRootProbe.objects.length) {
        throw new Error("The Olive tracks root returned inconsistent UPnP counts.");
      }
      const finalTrackTotal = upnpTotalMatches(
        finalRootProbe.totalMatches,
        finalRootProbe.numberReturned,
      );
      if (totalMatches === null || finalTrackTotal !== totalMatches) {
        throw new Error(
          `The Olive track total changed from ${totalMatches?.toLocaleString() ?? "unknown"} to `
          + `${finalTrackTotal?.toLocaleString() ?? "unknown"} during indexing. Retrying the latest catalog.`,
        );
      }
      const documents = await readSearchScope(target, "tracks");
      if (!flatTrackIndexMatchesCrawl(itemCount, totalMatches, documents)) {
        throw new Error(
          `The flat track crawl returned ${itemCount.toLocaleString()} appearances but stored `
          + `${documents.length.toLocaleString()} unique canonical tracks.`,
        );
      }
    }
    const checkpoint: ScopeCheckpoint = {
      version: 2,
      protocol: "upnp",
      updateId,
      nextStartingIndex: startingIndex,
      totalMatches,
      itemCount,
      complete: finished,
      containerUpdateId,
      strategy: "flat",
      ...(flatFallback ? { flatFallback: true } : {}),
    };
    await writeDeviceCacheStrict(target, checkpointResource(config.scope), checkpoint);
    report({
      phase: "syncing",
      scope: config.scope,
      scopeItems: itemCount,
      scopeTotal: totalMatches,
      itemCount: completedCount(scopeCounts, config.scope) + itemCount,
    });
    if (hitSafetyCeiling) {
      throw new Error(`${config.scope} exceeded the ${MAX_SCOPE_ITEMS.toLocaleString()}-item safety ceiling.`);
    }
    if (finished) {
      await completeSearchScope(target, config.scope, updateId);
      return checkpoint;
    }
    // Yield between pages so player and foreground searches can enter the
    // native priority queue before the next background request.
    await new Promise((resolve) => window.setTimeout(resolve, 15));
  }
  throw new Error(`${config.scope} exceeded the ${MAX_SCOPE_ITEMS.toLocaleString()}-item safety ceiling.`);
}

async function crawlUpnpTracksByAlbum(
  target: OliveDeviceTarget,
  updateId: string,
  scopeCounts: Partial<Record<LibrarySearchScope, number>>,
  report: (progress: LibraryCatalogProgress) => void,
  allowResume: boolean,
  signal?: AbortSignal,
): Promise<CatalogScopeCursor> {
  const config = SCOPE_CONFIGS.tracks;
  const albumDocuments = await readSearchScope(target, "albums");
  const albums = canonicalAlbumContainers(albumDocuments, scopeCounts.albums);
  if (!albums) {
    throw new AlbumFanoutUnavailableError("The complete canonical album list was not available for fast track indexing.");
  }

  const saved = await readDeviceCacheStrict<ScopeCheckpoint>(target, checkpointResource("tracks"));
  if (allowResume && shouldContinueFlatTrackFallback(saved, updateId)) {
    throw new AlbumFanoutUnavailableError("Continuing the existing flat track crawl.");
  }
  const rootProbe = await browseUpnp(target, config, 0, signal, config.upnpId, 1);
  if (rootProbe.numberReturned !== rootProbe.objects.length) {
    throw new Error("The Olive tracks root returned inconsistent UPnP counts.");
  }
  const observedTrackTotal = upnpTotalMatches(rootProbe.totalMatches, rootProbe.numberReturned);
  if (observedTrackTotal === null) {
    throw new AlbumFanoutUnavailableError("The Olive did not provide a track total for fanout verification.");
  }
  const resume = allowResume
    && canResumeAlbumFanout(saved, updateId)
    && saved?.totalMatches === observedTrackTotal;
  let parentIndex = resume ? saved!.parentIndex! : 0;
  let parentStartingIndex = resume ? saved!.parentStartingIndex! : 0;
  let itemCount = resume ? saved!.itemCount : 0;
  const totalMatches = observedTrackTotal;
  let parentContainerUpdateId = resume && parentStartingIndex > 0
    ? saved!.containerUpdateId ?? null
    : null;
  let parentFailureIndex = resume ? saved!.parentFailureIndex : undefined;
  let parentFailureCount = resume ? saved!.parentFailureCount : undefined;

  if (resume && saved!.complete) {
    await completeSearchScope(
      target,
      "tracks",
      albumFanoutGeneration(updateId, totalMatches),
    );
    return saved!;
  }
  if (parentIndex > albums.length) {
    throw new AlbumFanoutUnavailableError("The saved album fanout cursor no longer matches this catalog.");
  }

  if (!resume) {
    // Publish the new strategy before clearing the old index. On interruption,
    // a zero fanout cursor tells the next launch to clear idempotently instead
    // of resuming an old flat offset against an empty index.
    await writeDeviceCacheStrict(target, checkpointResource("tracks"), {
      version: 2,
      protocol: "upnp",
      updateId,
      nextStartingIndex: 0,
      totalMatches,
      itemCount: 0,
      complete: false,
      containerUpdateId: null,
      strategy: "album-fanout",
      parentIndex: 0,
      parentStartingIndex: 0,
      parentFailureCount: 0,
    } satisfies ScopeCheckpoint);
  }
  if (!resume || (itemCount === 0 && parentIndex === 0 && parentStartingIndex === 0)) {
    await beginSearchScope(
      target,
      "tracks",
      albumFanoutGeneration(updateId, totalMatches),
    );
  }

  while (parentIndex < albums.length) {
    throwIfAborted(signal);
    const album = albums[parentIndex]!;
    const albumId = album.userData.upnpId || album.id;
    const pageStartingIndex = parentStartingIndex;
    const failAlbumAttempt = async (error: unknown): Promise<never> => {
      if (signal?.aborted) throw error;
      const failure = nextAlbumFanoutFailure(parentFailureIndex, parentFailureCount, parentIndex);
      parentFailureIndex = failure.parentFailureIndex;
      parentFailureCount = failure.parentFailureCount;
      await writeDeviceCacheStrict(target, checkpointResource("tracks"), {
        version: 2,
        protocol: "upnp",
        updateId,
        nextStartingIndex: itemCount,
        totalMatches,
        itemCount,
        complete: false,
        containerUpdateId: parentContainerUpdateId,
        strategy: "album-fanout",
        parentIndex,
        parentStartingIndex,
        parentFailureIndex,
        parentFailureCount,
      } satisfies ScopeCheckpoint);
      if (failure.shouldFallback) {
        throw new AlbumFanoutUnavailableError(
          `Album fanout could not read ${albumId} after three resumable attempts.`,
        );
      }
      throw error;
    };
    const page = await browseUpnp(
      target,
      config,
      pageStartingIndex,
      signal,
      albumId,
    ).catch(failAlbumAttempt);
    if (page.numberReturned !== page.objects.length) {
      throw new AlbumFanoutUnavailableError("An Olive album returned inconsistent UPnP page counts.");
    }
    const tree = upnpPageToTree(target as StableOliveTarget, page, "tracks");
    if (tree.items.some((item) =>
      !isUpnpTreeNode(item)
      || item.userData.objectKind !== "item"
      || item.userData.type !== "track"
      || !/^ROOT_ALLAL_AL[0-9]+_TR[0-9]+$/.test(item.userData.upnpId || item.id))) {
      throw new AlbumFanoutUnavailableError("An album did not expose canonical track identities.");
    }
    const nextParent = await (async () => {
      try {
        return advanceAlbumFanoutCursor({
          parentIndex,
          parentStartingIndex: pageStartingIndex,
          parentContainerUpdateId,
          pageUpdateId: page.updateId,
          numberReturned: page.numberReturned,
          totalMatches: page.totalMatches,
        });
      } catch (error) {
        return failAlbumAttempt(error);
      }
    })();
    parentFailureIndex = undefined;
    parentFailureCount = 0;
    await appendSearchScopePage(
      target,
      "tracks",
      albumFanoutGeneration(updateId, totalMatches),
      `album-${parentIndex}-offset-${pageStartingIndex}`,
      tree.items,
    );
    itemCount += page.numberReturned;
    parentIndex = nextParent.parentIndex;
    parentStartingIndex = nextParent.parentStartingIndex;
    parentContainerUpdateId = nextParent.parentContainerUpdateId;
    if (itemCount > MAX_SCOPE_ITEMS) {
      throw new Error(`tracks exceeded the ${MAX_SCOPE_ITEMS.toLocaleString()}-item safety ceiling.`);
    }
    const checkpoint: ScopeCheckpoint = {
      version: 2,
      protocol: "upnp",
      updateId,
      nextStartingIndex: itemCount,
      totalMatches,
      itemCount,
      complete: false,
      containerUpdateId: parentContainerUpdateId,
      strategy: "album-fanout",
      parentIndex,
      parentStartingIndex,
      parentFailureCount,
      ...(parentFailureIndex !== undefined ? { parentFailureIndex } : {}),
    };
    await writeDeviceCacheStrict(target, checkpointResource("tracks"), checkpoint);
    report({
      phase: "syncing",
      scope: "tracks",
      scopeItems: itemCount,
      scopeTotal: totalMatches,
      itemCount: completedCount(scopeCounts, "tracks") + itemCount,
    });
    // The Olive can answer these indexed album reads quickly. A small cooldown
    // keeps the old embedded server responsive to playback and DHCP changes.
    await new Promise((resolve) => window.setTimeout(resolve, 75));
  }

  const trackDocuments = await readSearchScope(target, "tracks");
  const finalRootProbe = await browseUpnp(target, config, 0, signal, config.upnpId, 1);
  if (finalRootProbe.numberReturned !== finalRootProbe.objects.length) {
    throw new Error("The Olive tracks root returned inconsistent UPnP counts.");
  }
  const finalTrackTotal = upnpTotalMatches(
    finalRootProbe.totalMatches,
    finalRootProbe.numberReturned,
  );
  if (finalTrackTotal !== totalMatches) {
    throw new Error(
      `The Olive track total changed from ${totalMatches.toLocaleString()} to `
      + `${finalTrackTotal?.toLocaleString() ?? "unknown"} during indexing. Retrying the latest catalog.`,
    );
  }
  if (!albumFanoutMatchesTrackTotal(totalMatches, trackDocuments)) {
    const boundaryPage = await browseUpnp(
      target,
      config,
      trackDocuments.length,
      signal,
      config.upnpId,
      1,
    );
    if (boundaryPage.totalMatches !== totalMatches) {
      throw new Error("The Olive track total changed during final fanout verification.");
    }
    if (!albumFanoutCoversExhaustedTrackRoot(
      totalMatches,
      trackDocuments,
      rootProbe,
      boundaryPage,
    )) {
      throw new AlbumFanoutUnavailableError(
        `Album fanout found ${trackDocuments.length.toLocaleString()} of ${totalMatches.toLocaleString()} tracks.`,
      );
    }
  }
  const completed: ScopeCheckpoint = {
    version: 2,
    protocol: "upnp",
    updateId,
    nextStartingIndex: trackDocuments.length,
    totalMatches,
    itemCount: trackDocuments.length,
    complete: true,
    containerUpdateId: null,
    strategy: "album-fanout",
    parentIndex: albums.length,
    parentStartingIndex: 0,
  };
  await writeDeviceCacheStrict(target, checkpointResource("tracks"), completed);
  await completeSearchScope(
    target,
    "tracks",
    albumFanoutGeneration(updateId, totalMatches),
  );
  return completed;
}

async function syncUpnpCatalog(
  target: OliveDeviceTarget,
  report: (progress: LibraryCatalogProgress) => void,
  force: boolean,
  signal?: AbortSignal,
): Promise<LibraryCatalogManifest> {
  const status = await catalogStatus(target, signal);
  if (!status.available || !status.updateId) throw new Error("ContentDirectory is not available on this Olive.");
  const deviceId = targetKey(target);
  const existing = await readLibraryCatalogManifest(target);
  let existingTrackSnapshotMatches = true;
  if (
    !force
    && existing?.protocol === "upnp"
    && existing.updateId === status.updateId
    && existing.cursors.tracks?.complete === true
  ) {
    const trackProbe = await browseUpnp(
      target,
      SCOPE_CONFIGS.tracks,
      0,
      signal,
      SCOPE_CONFIGS.tracks.upnpId,
      1,
    );
    if (trackProbe.numberReturned !== trackProbe.objects.length) {
      throw new Error("The Olive tracks root returned inconsistent UPnP counts.");
    }
    existingTrackSnapshotMatches = trackCatalogSnapshotMatches(
      existing.cursors.tracks,
      upnpTotalMatches(trackProbe.totalMatches, trackProbe.numberReturned),
    );
  }
  if (
    !force
    && existing?.protocol === "upnp"
    && existing.complete
    && existing.updateId === status.updateId
    && existingTrackSnapshotMatches
    && missingLibrarySearchScopes(existing).length === 0
  ) {
    await ensureArtistIndex(target, existing);
    report({ phase: "complete", scope: null, scopeItems: 0, scopeTotal: null, itemCount: existing.itemCount });
    return existing;
  }

  const sameRevision = !force
    && existing?.protocol === "upnp"
    && existing.updateId === status.updateId
    && existingTrackSnapshotMatches;
  const scopeCounts: Partial<Record<LibrarySearchScope, number>> = sameRevision ? { ...existing.scopes } : {};
  const cursors: Partial<Record<LibrarySearchScope, CatalogScopeCursor>> = sameRevision ? { ...existing.cursors } : {};
  let manifest: LibraryCatalogManifest = {
    version: 2,
    protocol: "upnp",
    deviceId,
    updateId: status.updateId,
    complete: false,
    completedAt: 0,
    itemCount: completedCount(scopeCounts),
    scopes: scopeCounts,
    cursors,
  };
  await writeDeviceCacheStrict(target, MANIFEST_RESOURCE, manifest);

  for (const scope of AUTOMATIC_CATALOG_SCOPES) {
    throwIfAborted(signal);
    if (scopeCounts[scope] !== undefined && cursors[scope]?.complete) continue;
    const config = SCOPE_CONFIGS[scope];
    report({
      phase: "syncing",
      scope,
      scopeItems: cursors[scope]?.itemCount ?? 0,
      scopeTotal: cursors[scope]?.totalMatches ?? null,
      itemCount: completedCount(scopeCounts),
    });
    let cursor: CatalogScopeCursor;
    if (scope === "tracks") {
      try {
        cursor = await crawlUpnpTracksByAlbum(
          target,
          status.updateId,
          scopeCounts,
          report,
          sameRevision,
          signal,
        );
      } catch (error) {
        if (!(error instanceof AlbumFanoutUnavailableError)) throw error;
        // A fanout result is publishable only when its canonical unique-track
        // count exactly matches the track root. Start the flat crawl cleanly
        // if this firmware exposes a different album topology.
        cursor = await crawlUpnpScope(
          target,
          config,
          status.updateId,
          scopeCounts,
          report,
          sameRevision,
          signal,
          true,
        );
      }
    } else {
      cursor = await crawlUpnpScope(
        target,
        config,
        status.updateId,
        scopeCounts,
        report,
        sameRevision,
        signal,
      );
    }
    scopeCounts[scope] = cursor.itemCount;
    cursors[scope] = cursor;
    manifest = {
      ...manifest,
      scopes: { ...scopeCounts },
      cursors: { ...cursors },
      itemCount: completedCount(scopeCounts),
    };
    await writeDeviceCacheStrict(target, MANIFEST_RESOURCE, manifest);
    if (scope === "artists") await ensureArtistIndex(target, manifest);
  }

  const finalStatus = await catalogStatus(target, signal);
  if (!finalStatus.available || finalStatus.updateId !== status.updateId) {
    const invalidated = { ...manifest, complete: false, completedAt: 0 };
    await writeDeviceCacheStrict(target, MANIFEST_RESOURCE, invalidated);
    throw new Error("The Olive library changed during download. Resume to index its latest revision.");
  }
  const complete = missingLibrarySearchScopes(manifest).length === 0
    && canPublishCatalogRevision(status.updateId, finalStatus.updateId, cursors);
  if (!complete) throw new Error("The catalog stopped before all six library sections were indexed.");
  const completed: LibraryCatalogManifest = {
    ...manifest,
    complete: true,
    completedAt: Date.now(),
    itemCount: completedCount(scopeCounts),
    scopes: { ...scopeCounts },
    cursors: { ...cursors },
  };
  await writeDeviceCacheStrict(target, MANIFEST_RESOURCE, completed);
  await ensureArtistIndex(target, completed);
  report({ phase: "complete", scope: null, scopeItems: 0, scopeTotal: null, itemCount: completed.itemCount });
  return completed;
}

async function crawlLegacyScope(
  target: OliveDeviceTarget,
  config: ScopeConfig,
  generation: string,
  scopeCounts: Partial<Record<LibrarySearchScope, number>>,
  report: (progress: LibraryCatalogProgress) => void,
  signal?: AbortSignal,
): Promise<CatalogScopeCursor> {
  const saved = await readDeviceCacheStrict<ScopeCheckpoint>(target, checkpointResource(config.scope));
  const resume = canResumeCatalogRevision(saved, "maestro", generation);
  let startingIndex = resume ? saved!.nextStartingIndex : 0;
  let itemCount = resume ? saved!.itemCount : 0;
  let totalMatches = resume ? saved!.totalMatches : null;
  if (resume && saved!.complete) {
    await completeSearchScope(target, config.scope, generation);
    return saved!;
  }
  if (!resume) {
    await writeDeviceCacheStrict(target, checkpointResource(config.scope), {
      version: 2,
      protocol: "maestro",
      updateId: generation,
      nextStartingIndex: 0,
      totalMatches: null,
      itemCount: 0,
      complete: false,
      containerUpdateId: null,
    } satisfies ScopeCheckpoint);
  }
  if (!resume || (itemCount === 0 && startingIndex === 0)) {
    await beginSearchScope(target, config.scope, generation);
  }

  while (itemCount < MAX_SCOPE_ITEMS) {
    throwIfAborted(signal);
    const tree = await browseLegacy(target, config, startingIndex, signal);
    if (tree.totalItems !== null) totalMatches = tree.totalItems;
    await appendSearchScopePage(target, config.scope, generation, String(startingIndex), tree.items);
    startingIndex = nextCatalogCursor(startingIndex, tree.items.length);
    itemCount += tree.items.length;
    const reachedEnd = !config.legacyPaged
      || tree.items.length === 0
      || tree.items.length < config.legacyPageSize
      || (totalMatches !== null && startingIndex >= totalMatches);
    const hitSafetyCeiling = itemCount > MAX_SCOPE_ITEMS
      || (!reachedEnd && itemCount >= MAX_SCOPE_ITEMS);
    const finished = reachedEnd && !hitSafetyCeiling;
    const checkpoint: ScopeCheckpoint = {
      version: 2,
      protocol: "maestro",
      updateId: generation,
      nextStartingIndex: startingIndex,
      totalMatches,
      itemCount,
      complete: finished,
      containerUpdateId: null,
    };
    await writeDeviceCacheStrict(target, checkpointResource(config.scope), checkpoint);
    report({
      phase: "syncing",
      scope: config.scope,
      scopeItems: itemCount,
      scopeTotal: totalMatches,
      itemCount: completedCount(scopeCounts, config.scope) + itemCount,
    });
    if (hitSafetyCeiling) {
      throw new Error(`${config.scope} exceeded the ${MAX_SCOPE_ITEMS.toLocaleString()}-item safety ceiling.`);
    }
    if (finished) {
      await completeSearchScope(target, config.scope, generation);
      return checkpoint;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 30));
  }
  throw new Error(`${config.scope} exceeded the ${MAX_SCOPE_ITEMS.toLocaleString()}-item safety ceiling.`);
}

async function syncLegacyCatalog(
  target: OliveDeviceTarget,
  report: (progress: LibraryCatalogProgress) => void,
  force: boolean,
  signal?: AbortSignal,
): Promise<LibraryCatalogManifest> {
  const existing = await readLibraryCatalogManifest(target);
  if (!force && existing?.protocol === "maestro" && existing.complete && Date.now() - existing.completedAt < LEGACY_REFRESH_AFTER_MS) {
    await ensureArtistIndex(target, existing);
    report({ phase: "complete", scope: null, scopeItems: 0, scopeTotal: null, itemCount: existing.itemCount });
    return existing;
  }
  const generation = !force && existing?.protocol === "maestro" && !existing.complete
    ? Object.values(existing.cursors)[0]?.nextStartingIndex !== undefined
      ? String(existing.updateId ?? `legacy-${existing.completedAt}`)
      : `legacy-${Date.now()}`
    : `legacy-${Date.now()}`;
  const resumable = !force && existing?.protocol === "maestro" && !existing.complete && existing.updateId === generation;
  const scopeCounts: Partial<Record<LibrarySearchScope, number>> = resumable ? { ...existing.scopes } : {};
  const cursors: Partial<Record<LibrarySearchScope, CatalogScopeCursor>> = resumable ? { ...existing.cursors } : {};
  let manifest: LibraryCatalogManifest = {
    version: 2,
    protocol: "maestro",
    deviceId: targetKey(target),
    updateId: generation,
    complete: false,
    completedAt: 0,
    itemCount: completedCount(scopeCounts),
    scopes: scopeCounts,
    cursors,
  };
  await writeDeviceCacheStrict(target, MANIFEST_RESOURCE, manifest);
  for (const scope of AUTOMATIC_CATALOG_SCOPES) {
    if (scopeCounts[scope] !== undefined && cursors[scope]?.complete) continue;
    const cursor = await crawlLegacyScope(target, SCOPE_CONFIGS[scope], generation, scopeCounts, report, signal);
    scopeCounts[scope] = cursor.itemCount;
    cursors[scope] = cursor;
    manifest = {
      ...manifest,
      scopes: { ...scopeCounts },
      cursors: { ...cursors },
      itemCount: completedCount(scopeCounts),
    };
    await writeDeviceCacheStrict(target, MANIFEST_RESOURCE, manifest);
    if (scope === "artists") await ensureArtistIndex(target, manifest);
  }
  const completed = {
    ...manifest,
    complete: true,
    completedAt: Date.now(),
    scopes: { ...scopeCounts },
    cursors: { ...cursors },
    itemCount: completedCount(scopeCounts),
  } satisfies LibraryCatalogManifest;
  await writeDeviceCacheStrict(target, MANIFEST_RESOURCE, completed);
  await ensureArtistIndex(target, completed);
  report({ phase: "complete", scope: null, scopeItems: 0, scopeTotal: null, itemCount: completed.itemCount });
  return completed;
}

export function cachedScopeMatchesProbe(
  cached: SearchDocument[],
  tree: MaestroTree,
  paged: boolean,
  pageSize: number,
): boolean {
  const observedCount = tree.totalItems ?? (!paged || tree.items.length < pageSize ? tree.items.length : null);
  if (observedCount === null || cached.length !== observedCount) return false;
  const cachedIds = new Set(cached.map((document) => document.item.id));
  return tree.items.every((item) => cachedIds.has(item.id));
}

export async function readLibraryCatalogManifest(target: OliveDeviceTarget): Promise<LibraryCatalogManifest | null> {
  return readDeviceCacheStrict<LibraryCatalogManifest>(target, MANIFEST_RESOURCE);
}

export function missingLibrarySearchScopes(manifest: LibraryCatalogManifest | null): LibrarySearchScope[] {
  return LIBRARY_SEARCH_SCOPES.filter((scope) =>
    manifest?.scopes[scope] === undefined || manifest.cursors[scope]?.complete !== true);
}

export async function libraryCatalogIsReady(target: OliveDeviceTarget): Promise<boolean> {
  const manifest = await readLibraryCatalogManifest(target);
  return manifest?.complete === true && missingLibrarySearchScopes(manifest).length === 0;
}

export async function syncLibraryCatalog(
  target: OliveDeviceTarget,
  report: (progress: LibraryCatalogProgress) => void,
  force = false,
  signal?: AbortSignal,
): Promise<LibraryCatalogManifest> {
  const stableKey = targetKey(target);
  const key = deviceRequestKey(target as StableOliveTarget);
  const running = activeSyncs.get(key);
  if (running) return running;
  activeCatalogEndpoints.set(stableKey, key);
  const task = (async () => {
    try {
      return targetSupportsContentDirectory(target as StableOliveTarget)
        ? await syncUpnpCatalog(target, report, force, signal)
        : await syncLegacyCatalog(target, report, force, signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      const itemCount = (await readLibraryCatalogManifest(target))?.itemCount ?? 0;
      const message = error instanceof Error ? error.message : "Library download paused.";
      report({ phase: "error", scope: null, scopeItems: 0, scopeTotal: null, itemCount, message });
      throw error;
    }
  })();
  activeSyncs.set(key, task);
  try { return await task; }
  finally {
    if (activeSyncs.get(key) === task) activeSyncs.delete(key);
    if (activeCatalogEndpoints.get(stableKey) === key) {
      activeCatalogEndpoints.delete(stableKey);
    }
  }
}
