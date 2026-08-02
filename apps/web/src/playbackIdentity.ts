import type { MaestroTree, MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { appFetch } from "./nativeApi";
import { readDeviceCache, writeDeviceCache } from "./deviceCache";
import type { StableOliveTarget } from "./deviceIdentity";
import {
  isUpnpTreeNode,
  maestroPlaybackId,
  targetSupportsContentDirectory,
  type UpnpCatalogPage,
  upnpPageToTree,
  withMaestroMapping,
} from "./upnpCatalog";

interface MaestroMapping {
  version: 1;
  upnpId: string;
  maestroId: string;
  fingerprint: string;
  mappedAt: number;
}

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fingerprint(item: MaestroTreeNode): string {
  return [
    normalize(item.title),
    normalize(item.userData.artist),
    normalize(item.userData.album),
  ].join("|");
}

function mappingResource(item: MaestroTreeNode): string {
  return `library:maestro-map:v1:${encodeURIComponent(item.userData.upnpId || item.id)}`;
}

/**
 * The O4 exposes the same numeric album/track identity through different
 * ContentDirectory trees. Album-context IDs can therefore be converted to the
 * canonical Maestro album tree without searching the whole legacy database.
 *
 * Physically verified on the target Olive:
 * ROOT_ALLAR_AR57411_AL57410_TR57414 -> ROOT_ALLAL_AL57410_TR57414.
 * IDs without both numeric album and track components remain quarantined.
 */
export function derivedMaestroPlaybackId(item: MaestroTreeNode): string | null {
  if (
    !isUpnpTreeNode(item)
    || item.userData.objectKind !== "item"
    || item.userData.type !== "track"
  ) return null;
  const upnpId = item.userData.upnpId || item.id;
  if (/^ROOT_ALLAL_AL[0-9]+_TR[0-9]+$/.test(upnpId)) return upnpId;
  const match = upnpId.match(/^ROOT_ALLAR_AR[0-9]+_AL([0-9]+)_TR([0-9]+)$/);
  return match ? `ROOT_ALLAL_AL${match[1]}_TR${match[2]}` : null;
}

export function uniqueExactMaestroMatch(
  item: MaestroTreeNode,
  candidates: readonly MaestroTreeNode[],
): MaestroTreeNode | null {
  const title = normalize(item.title);
  const artist = normalize(item.userData.artist);
  const album = normalize(item.userData.album);
  const matches = candidates.filter((candidate) => {
    if (!title || normalize(candidate.title) !== title) return false;
    const candidateArtist = normalize(candidate.userData.artist);
    const candidateAlbum = normalize(candidate.userData.album);
    if (artist && candidateArtist && candidateArtist !== artist) return false;
    if (album && candidateAlbum && candidateAlbum !== album) return false;
    return Boolean(candidate.id.trim());
  });
  const unique = [...new Map(matches.map((candidate) => [candidate.id, candidate])).values()];
  return unique.length === 1 ? unique[0]! : null;
}

export function uniqueCanonicalUpnpPlaybackMatch(
  item: MaestroTreeNode,
  candidates: readonly MaestroTreeNode[],
): MaestroTreeNode | null {
  const match = uniqueExactMaestroMatch(item, candidates);
  if (
    !match
    || !isUpnpTreeNode(match)
    || match.userData.objectKind !== "item"
    || match.userData.type !== "track"
    || !/^ROOT_ALLAL_AL[0-9]+_TR[0-9]+$/.test(match.userData.upnpId || match.id)
  ) return null;
  return match;
}

/**
 * Resolves a UPnP track to the legacy Maestro identifier used by the verified
 * playback endpoint. It never assumes that the two protocol IDs are equal.
 */
export async function resolveMaestroPlaybackNode(
  target: OliveDeviceTarget,
  item: MaestroTreeNode,
): Promise<MaestroTreeNode> {
  if (!isUpnpTreeNode(item)) return item;
  const mappedId = maestroPlaybackId(item);
  if (mappedId) return withMaestroMapping(item, mappedId);
  const expectedFingerprint = fingerprint(item);
  const cached = await readDeviceCache<MaestroMapping>(target, mappingResource(item));
  if (cached?.fingerprint === expectedFingerprint && cached.maestroId) {
    return withMaestroMapping(item, cached.maestroId);
  }
  const derivedId = derivedMaestroPlaybackId(item);
  if (derivedId) {
    await writeDeviceCache(target, mappingResource(item), {
      version: 1,
      upnpId: item.userData.upnpId || item.id,
      maestroId: derivedId,
      fingerprint: expectedFingerprint,
      mappedAt: Date.now(),
    } satisfies MaestroMapping);
    return withMaestroMapping(item, derivedId);
  }

  let match: MaestroTreeNode | null = null;
  if (targetSupportsContentDirectory(target as StableOliveTarget)) {
    try {
      const upnpResponse = await appFetch("/api/upnp/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target, term: item.title, requestedCount: 64 }),
      });
      const upnpData = await upnpResponse.json() as UpnpCatalogPage & { error?: string };
      if (upnpResponse.ok) {
        match = uniqueCanonicalUpnpPlaybackMatch(
          item,
          upnpPageToTree(target as StableOliveTarget, upnpData, "tracks").items,
        );
      }
    } catch {
      // Fall through to the older Maestro lookup for non-UPnP firmware and
      // transient ContentDirectory failures.
    }
  }

  if (!match) {
  const response = await appFetch("/api/library/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, term: item.title, scope: "tracks" }),
  });
  const data = await response.json() as MaestroTree & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Could not map this UPnP track for playback.");
    match = uniqueExactMaestroMatch(item, data.items);
  }
  if (!match) {
    throw new Error("This track could not be matched unambiguously to the Olive player yet.");
  }
  const mapping: MaestroMapping = {
    version: 1,
    upnpId: item.userData.upnpId || item.id,
    maestroId: match.id,
    fingerprint: expectedFingerprint,
    mappedAt: Date.now(),
  };
  await writeDeviceCache(target, mappingResource(item), mapping);
  return withMaestroMapping(item, match.id);
}
