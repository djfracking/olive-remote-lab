import type { MaestroTreeNode } from "@olive-remote-lab/olive-client";
import { playbackTrackFromNode } from "./playbackState";

export type PlaybackCollectionScope = "explicit" | "automatic";

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase();
}

function uniqueNodes(nodes: MaestroTreeNode[]): MaestroTreeNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

/**
 * Keeps broad track/search listings from becoming one accidental global queue.
 * A deliberately opened collection (album, artist, playlist, and so on) keeps
 * its visible order. A broad listing is narrowed to the selected album first,
 * then to the selected artist when album metadata is unavailable.
 */
export function playbackContextForSelection(
  selected: MaestroTreeNode,
  candidates: MaestroTreeNode[],
  scope: PlaybackCollectionScope,
): MaestroTreeNode[] {
  const ordered = uniqueNodes(candidates);
  if (!ordered.some((node) => node.id === selected.id)) return [selected];
  if (scope === "explicit") return ordered;

  const selectedMetadata = playbackTrackFromNode(selected).metadata;
  const selectedAlbum = normalized(selectedMetadata.album);
  const selectedArtist = normalized(selectedMetadata.artist);

  if (selectedAlbum) {
    const albumTracks = ordered.filter((candidate) => {
      const metadata = playbackTrackFromNode(candidate).metadata;
      if (normalized(metadata.album) !== selectedAlbum) return false;
      return !selectedArtist || normalized(metadata.artist) === selectedArtist;
    });
    if (albumTracks.length) return albumTracks;
  }

  if (selectedArtist) {
    const artistTracks = ordered.filter((candidate) => (
      normalized(playbackTrackFromNode(candidate).metadata.artist) === selectedArtist
    ));
    if (artistTracks.length) return artistTracks;
  }

  return [selected];
}
