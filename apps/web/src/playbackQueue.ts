import type { MaestroTreeNode, OliveDeviceTarget } from "@olive-remote-lab/olive-client";

export interface QueuedTrack {
  queueId: string;
  itemId: string;
  title: string;
  artist: string;
  album: string;
  artworkPath: string;
  playbackIndex?: number;
}

const key = (target: OliveDeviceTarget) => `olive:queue:${target.host.toLowerCase()}:${target.port}`;

export function queueFromNode(node: MaestroTreeNode): QueuedTrack {
  const playbackIndex = node.userData.playbackIndex ? Number(node.userData.playbackIndex) : undefined;
  return {
    queueId: crypto.randomUUID(), itemId: node.id, title: node.title || "Untitled",
    artist: node.userData.artist ?? node.userData.interpreter ?? "", album: node.userData.album ?? node.userData.albumname ?? "",
    artworkPath: node.userData.albumart ?? node.userData.albumArt ?? node.userData.artwork ?? node.userData.artworkPath ?? node.userData.cover ?? "",
    ...(playbackIndex !== undefined && Number.isFinite(playbackIndex) ? { playbackIndex } : {}),
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
