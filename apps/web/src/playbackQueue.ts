import type { MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { deviceCacheNamespace, type StableOliveTarget } from "./deviceIdentity";
import { PLAYBACK_QUEUE_STORAGE_PREFIX } from "./deviceStorageMigration";

export interface QueuedTrack {
  queueId: string;
  itemId: string;
  title: string;
  artist: string;
  album: string;
  artworkPath: string;
  playbackIndex?: number;
  source?: "upnp";
  upnpId?: string;
  upnpRefId?: string;
  upnpParentId?: string;
  maestroId?: string;
  resourceUri?: string;
}

const key = (target: OliveDeviceTarget) =>
  `${PLAYBACK_QUEUE_STORAGE_PREFIX}${deviceCacheNamespace(target as StableOliveTarget)}`;

export function queueFromNode(node: MaestroTreeNode): QueuedTrack {
  const playbackIndex = node.userData.playbackIndex ? Number(node.userData.playbackIndex) : undefined;
  const source = node.userData.source === "upnp" ? "upnp" as const : undefined;
  const maestroId = node.userData.maestroId?.trim() || undefined;
  const upnpId = node.userData.upnpId?.trim() || (source ? node.id : undefined);
  return {
    queueId: crypto.randomUUID(), itemId: maestroId ?? node.id, title: node.title || "Untitled",
    artist: node.userData.artist ?? node.userData.interpreter ?? "", album: node.userData.album ?? node.userData.albumname ?? "",
    artworkPath: node.userData.albumart ?? node.userData.albumArt ?? node.userData.artwork ?? node.userData.artworkPath ?? node.userData.cover ?? "",
    ...(playbackIndex !== undefined && Number.isFinite(playbackIndex) ? { playbackIndex } : {}),
    ...(source ? { source } : {}),
    ...(upnpId ? { upnpId } : {}),
    ...(node.userData.upnpRefId ? { upnpRefId: node.userData.upnpRefId } : {}),
    ...(node.userData.upnpParentId ? { upnpParentId: node.userData.upnpParentId } : {}),
    ...(maestroId ? { maestroId } : {}),
    ...(node.userData.resourceUri ? { resourceUri: node.userData.resourceUri } : {}),
  };
}

export function queuedTrackNode(track: QueuedTrack): MaestroTreeNode {
  const userData: Record<string, string> = {
    type: "track",
    artist: track.artist,
    album: track.album,
  };
  if (track.artworkPath) userData.albumart = track.artworkPath;
  if (track.playbackIndex !== undefined) userData.playbackIndex = String(track.playbackIndex);
  if (track.source === "upnp") {
    userData.source = "upnp";
    userData.upnpId = track.upnpId || track.itemId;
    if (track.upnpRefId) userData.upnpRefId = track.upnpRefId;
    if (track.upnpParentId) userData.upnpParentId = track.upnpParentId;
    if (track.maestroId) userData.maestroId = track.maestroId;
    if (track.resourceUri) userData.resourceUri = track.resourceUri;
  }
  return {
    id: track.source === "upnp" ? track.upnpId || track.itemId : track.itemId,
    title: track.title,
    childCount: 0,
    userData,
  };
}

export function readQueue(target: OliveDeviceTarget): QueuedTrack[] {
  try { return JSON.parse(localStorage.getItem(key(target)) ?? "[]") as QueuedTrack[]; }
  catch { return []; }
}

export function writeQueue(target: OliveDeviceTarget, tracks: QueuedTrack[]) {
  try { localStorage.setItem(key(target), JSON.stringify(tracks)); }
  catch { /* Queue persistence is best effort. */ }
}
