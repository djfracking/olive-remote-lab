import type {
  LibrarySearchScope,
  MaestroTree,
  MaestroTreeNode,
  UpnpContentResult,
  UpnpDidlObject,
  UpnpServiceDescription,
} from "@olive-remote-lab/olive-client";
import type { StableOliveTarget } from "./deviceIdentity";

export const UPNP_CATALOG_ROOTS = {
  artists: "ROOT_ALLAR",
  albums: "ROOT_ALLAL",
  tracks: "ROOT_ALLAU",
  genres: "ROOT_ALLGE",
  playlists: "ROOT_ALLPL",
  composers: "ROOT_ALLCO",
} as const satisfies Record<LibrarySearchScope, string>;

export interface UpnpCatalogPage extends Omit<UpnpContentResult, "rawDidl"> {
  readonly objectId: string;
  readonly rawDidl?: string;
}

export type UpnpPageKind = "search" | "browse";

/**
 * Keeps UPnP pagination independent from a requested page size. Older Olive
 * firmware may cap RequestedCount, so the only safe next cursor is
 * StartingIndex + NumberReturned.
 */
export interface UpnpPageCursor {
  readonly kind: UpnpPageKind;
  readonly requestIdentity: string;
  readonly startingIndex: number;
  readonly requestedCount: number;
  readonly numberReturned: number;
  readonly nextStartingIndex: number;
  readonly totalMatches: number | null;
  readonly complete: boolean;
}

export function upnpPageCursor(
  kind: UpnpPageKind,
  requestIdentity: string,
  startingIndex: number,
  requestedCount: number,
  page: Pick<UpnpCatalogPage, "numberReturned" | "totalMatches" | "objects">,
): UpnpPageCursor {
  if (!requestIdentity.trim()) throw new Error("A UPnP page identity is required.");
  if (!Number.isSafeInteger(startingIndex) || startingIndex < 0) throw new Error("Invalid UPnP StartingIndex.");
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) throw new Error("Invalid UPnP RequestedCount.");
  if (!Number.isSafeInteger(page.numberReturned) || page.numberReturned < 0) throw new Error("Invalid UPnP NumberReturned.");
  if (!Number.isSafeInteger(page.totalMatches) || page.totalMatches < 0) throw new Error("Invalid UPnP TotalMatches.");
  if (page.numberReturned !== page.objects.length) throw new Error("UPnP page count did not match its objects.");
  const totalMatches = page.totalMatches === 0 && page.numberReturned > 0
    ? null
    : page.totalMatches;
  if (page.numberReturned === 0 && totalMatches !== null && startingIndex < totalMatches) {
    throw new Error("UPnP returned an empty page before the reported end.");
  }
  const nextStartingIndex = startingIndex + page.numberReturned;
  const complete = page.numberReturned === 0
    ? true
    : totalMatches !== null
      ? nextStartingIndex >= totalMatches
      : page.numberReturned < requestedCount;
  return {
    kind,
    requestIdentity,
    startingIndex,
    requestedCount,
    numberReturned: page.numberReturned,
    nextStartingIndex,
    totalMatches,
    complete,
  };
}

export function shouldApplyUpnpPageResponse(
  expectedRevision: number,
  currentRevision: number,
  expectedTargetIdentity: string,
  currentTargetIdentity: string,
  expectedRequestIdentity: string,
  currentRequestIdentity: string | null,
): boolean {
  return expectedRevision === currentRevision
    && expectedTargetIdentity === currentTargetIdentity
    && expectedRequestIdentity === currentRequestIdentity;
}

export function targetUpnpService(
  target: StableOliveTarget,
  family: "ContentDirectory" | "AVTransport" | "RenderingControl",
): UpnpServiceDescription | null {
  return target.services?.find((service) =>
    new RegExp(`:service:${family}:\\d+$`, "i").test(service.serviceType)
    && Boolean(service.controlUrl)) ?? null;
}

export function targetSupportsContentDirectory(target: StableOliveTarget): boolean {
  return targetUpnpService(target, "ContentDirectory") !== null;
}

export function normalizeUpnpArtworkUri(target: StableOliveTarget, value: string | null): string {
  const raw = value?.trim() ?? "";
  if (!raw || /artworknotfound\.gif(?:$|\?)/i.test(raw)) return "";
  if (!/^https?:\/\//i.test(raw)) return raw.startsWith("/") ? raw : `/${raw.replace(/^\.\//, "")}`;
  try {
    const url = new URL(raw);
    // Keep the advertised artwork port. `artworkUrl()` rebases this host to
    // the current endpoint whenever the target has a stable device identity.
    if (url.hostname.toLowerCase() === target.host.trim().toLowerCase()) return url.toString();
    return url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function scopeType(scope: LibrarySearchScope): string {
  if (scope === "albums") return "compilation";
  if (scope === "artists") return "artists";
  if (scope === "composers") return "composer";
  if (scope === "genres") return "genre";
  if (scope === "playlists") return "playlist";
  return "track";
}

export function libraryScopeLabel(scope: LibrarySearchScope): string {
  if (scope === "artists") return "artist";
  if (scope === "albums") return "album";
  if (scope === "composers") return "composer";
  if (scope === "genres") return "genre";
  if (scope === "playlists") return "playlist";
  return "track";
}

export function scopeForUpnpIdentity(value: string | null | undefined): LibrarySearchScope | null {
  const identity = value?.trim().toUpperCase() ?? "";
  if (!identity) return null;
  for (const [scope, root] of Object.entries(UPNP_CATALOG_ROOTS) as Array<[LibrarySearchScope, string]>) {
    const normalizedRoot = root.toUpperCase();
    if (
      identity === normalizedRoot
      || identity.startsWith(`${normalizedRoot}_`)
      || identity.startsWith(`${normalizedRoot}/`)
      || identity.startsWith(`${normalizedRoot}:`)
    ) {
      return scope;
    }
  }
  return null;
}

function scopeFromUpnpMetadata(
  kind: "container" | "item",
  classNameValue: string,
  parentIdentity: string | null | undefined,
  fallback: LibrarySearchScope,
): LibrarySearchScope {
  const className = classNameValue.toLowerCase();
  const parentScope = scopeForUpnpIdentity(parentIdentity);
  if (className.includes("musicalbum") || className.includes("album")) return "albums";
  if (className.endsWith(".composer") || className.includes("musiccomposer")) return "composers";
  if (className.endsWith(".artist") || className.includes("musicartist") || className.includes("person")) {
    return parentScope === "composers" || fallback === "composers" ? "composers" : "artists";
  }
  if (className.includes("playlist")) return "playlists";
  if (className.includes("genre")) return "genres";
  if (className.includes("audioitem") || className.includes("musictrack") || className.endsWith(".audios") || kind === "item") return "tracks";
  if (parentScope) return parentScope;
  return fallback;
}

export function scopeForUpnpObject(object: UpnpDidlObject, fallback: LibrarySearchScope): LibrarySearchScope {
  return scopeFromUpnpMetadata(
    object.kind,
    object.className,
    object.identifiers.upnpParentId,
    fallback,
  );
}

export function scopeForUpnpTreeNode(
  item: MaestroTreeNode,
  fallback: LibrarySearchScope,
): LibrarySearchScope {
  if (!isUpnpTreeNode(item)) return fallback;
  return scopeFromUpnpMetadata(
    item.userData.objectKind === "item" ? "item" : "container",
    item.userData.upnpClass ?? "",
    item.userData.upnpParentId,
    fallback,
  );
}

export function upnpObjectToTreeNode(
  target: StableOliveTarget,
  object: UpnpDidlObject,
  fallback: LibrarySearchScope,
): MaestroTreeNode {
  const scope = scopeForUpnpObject(object, fallback);
  const userData: Record<string, string> = {
    type: scopeType(scope),
    source: "upnp",
    objectKind: object.kind,
    upnpId: object.identifiers.upnpId,
    upnpClass: object.className,
  };
  if (object.identifiers.maestroId) userData.maestroId = object.identifiers.maestroId;
  if (object.identifiers.upnpRefId) userData.upnpRefId = object.identifiers.upnpRefId;
  if (object.identifiers.upnpParentId) userData.upnpParentId = object.identifiers.upnpParentId;
  if (object.artist) userData.artist = object.artist;
  if (object.album) userData.album = object.album;
  if (object.genre) userData.genre = object.genre;
  if (object.creator) userData.composer = object.creator;
  const artwork = normalizeUpnpArtworkUri(target, object.albumArtUri);
  if (artwork) userData.albumart = artwork;
  if (object.duration) userData.duration = object.duration;
  if (object.resourceUri) userData.resourceUri = object.resourceUri;
  return {
    id: object.identifiers.upnpId,
    title: object.title,
    childCount: object.childCount,
    userData,
  };
}

export function upnpPageToTree(
  target: StableOliveTarget,
  page: UpnpCatalogPage,
  fallback: LibrarySearchScope,
): MaestroTree {
  return {
    id: page.objectId,
    totalItems: page.totalMatches === 0 && page.numberReturned > 0 ? null : page.totalMatches,
    items: page.objects.map((object) => upnpObjectToTreeNode(target, object, fallback)),
  };
}

export function isUpnpTreeNode(item: MaestroTreeNode): boolean {
  return item.userData.source === "upnp" && Boolean(item.userData.upnpId);
}

/** Returns null until a concrete Maestro mapping has been established. */
export function maestroPlaybackId(item: MaestroTreeNode): string | null {
  if (!isUpnpTreeNode(item)) return item.id.trim() || null;
  return item.userData.maestroId?.trim() || null;
}

export function withMaestroMapping(item: MaestroTreeNode, maestroId: string): MaestroTreeNode {
  const normalized = maestroId.trim();
  if (!normalized) return item;
  return { ...item, id: normalized, userData: { ...item.userData, maestroId: normalized } };
}
