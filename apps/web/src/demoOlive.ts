import {
  capabilitiesForModel,
  type EndpointProbe,
  type LibrarySearchScope,
  type MaestroBrowseRequest,
  type MaestroTrackMetadata,
  type MaestroTree,
  type MaestroTreeNode,
  type NowPlayingSnapshot,
  type OliveDeviceTarget,
  type PlaybackCommand,
  type TransportResponse,
} from "@olive-remote-lab/olive-client";

export const DEMO_TARGET = { host: "demo.olive.local", port: 80 } as const satisfies OliveDeviceTarget;

export function isDemoTarget(target: OliveDeviceTarget): boolean {
  return target.host.trim().toLowerCase() === DEMO_TARGET.host;
}

interface DemoTrack extends MaestroTrackMetadata { albumId: string; artistId: string }

const tracks: DemoTrack[] = [
  { id: "demo-track-1", title: "Morning Light", artist: "Avery Lane", album: "Open Window", genre: "Acoustic", artworkPath: "/demo-art/open-window.svg", durationSeconds: 224, playCount: 12, rating: 5, raw: {}, albumId: "demo-album-1", artistId: "demo-artist-1" },
  { id: "demo-track-2", title: "Paper Satellites", artist: "Avery Lane", album: "Open Window", genre: "Acoustic", artworkPath: "/demo-art/open-window.svg", durationSeconds: 198, playCount: 8, rating: 4, raw: {}, albumId: "demo-album-1", artistId: "demo-artist-1" },
  { id: "demo-track-3", title: "Still Water", artist: "North Harbor", album: "Tidal Rooms", genre: "Ambient", artworkPath: "/demo-art/tidal-rooms.svg", durationSeconds: 286, playCount: 21, rating: 5, raw: {}, albumId: "demo-album-2", artistId: "demo-artist-2" },
  { id: "demo-track-4", title: "Blue Current", artist: "North Harbor", album: "Tidal Rooms", genre: "Ambient", artworkPath: "/demo-art/tidal-rooms.svg", durationSeconds: 251, playCount: 15, rating: 4, raw: {}, albumId: "demo-album-2", artistId: "demo-artist-2" },
  { id: "demo-track-5", title: "Northern Lines", artist: "Juniper Vale", album: "Night Routes", genre: "Electronic", artworkPath: "/demo-art/night-routes.svg", durationSeconds: 242, playCount: 17, rating: 5, raw: {}, albumId: "demo-album-3", artistId: "demo-artist-3" },
  { id: "demo-track-6", title: "Signal Fires", artist: "Juniper Vale", album: "Night Routes", genre: "Electronic", artworkPath: "/demo-art/night-routes.svg", durationSeconds: 217, playCount: 10, rating: 4, raw: {}, albumId: "demo-album-3", artistId: "demo-artist-3" },
  { id: "demo-track-7", title: "Quiet Hours", artist: "The Common Field", album: "Small Hours", genre: "Jazz", artworkPath: "/demo-art/small-hours.svg", durationSeconds: 307, playCount: 25, rating: 5, raw: {}, albumId: "demo-album-4", artistId: "demo-artist-4" },
  { id: "demo-track-8", title: "First Train Home", artist: "The Common Field", album: "Small Hours", genre: "Jazz", artworkPath: "/demo-art/small-hours.svg", durationSeconds: 274, playCount: 19, rating: 5, raw: {}, albumId: "demo-album-4", artistId: "demo-artist-4" },
];

const albums = [
  { id: "demo-album-1", title: "Open Window", artistId: "demo-artist-1", artworkPath: "/demo-art/open-window.svg" },
  { id: "demo-album-2", title: "Tidal Rooms", artistId: "demo-artist-2", artworkPath: "/demo-art/tidal-rooms.svg" },
  { id: "demo-album-3", title: "Night Routes", artistId: "demo-artist-3", artworkPath: "/demo-art/night-routes.svg" },
  { id: "demo-album-4", title: "Small Hours", artistId: "demo-artist-4", artworkPath: "/demo-art/small-hours.svg" },
];

const artists = [
  { id: "demo-artist-1", title: "Avery Lane" },
  { id: "demo-artist-2", title: "North Harbor" },
  { id: "demo-artist-3", title: "Juniper Vale" },
  { id: "demo-artist-4", title: "The Common Field" },
];

const genres = ["Acoustic", "Ambient", "Electronic", "Jazz"];
const playlists = [
  { id: "demo-playlist-1", title: "Sunday Morning", trackIds: ["demo-track-1", "demo-track-3", "demo-track-7"] },
  { id: "demo-playlist-2", title: "After Dark", trackIds: ["demo-track-5", "demo-track-6", "demo-track-8"] },
];

function tree(id: string, items: MaestroTreeNode[]): MaestroTree {
  return { id, totalItems: items.length, items };
}

function trackNode(track: DemoTrack, index: number): MaestroTreeNode {
  return {
    id: track.id,
    title: track.title,
    childCount: 0,
    userData: {
      type: "track",
      artist: track.artist,
      album: track.album,
      genre: track.genre,
      albumart: track.artworkPath,
      playbackIndex: String(index + 1),
    },
  };
}

function albumNodes(filterArtistId?: string): MaestroTreeNode[] {
  return albums.filter((album) => !filterArtistId || album.artistId === filterArtistId).map((album) => ({
    id: album.id,
    title: album.title,
    childCount: tracks.filter((track) => track.albumId === album.id).length,
    userData: { type: "compilation", albumart: album.artworkPath },
  }));
}

function artistNodes(): MaestroTreeNode[] {
  return artists.map((artist) => ({
    id: artist.id,
    title: artist.title,
    childCount: albums.filter((album) => album.artistId === artist.id).length,
    userData: { type: "artist" },
  }));
}

function genreNodes(): MaestroTreeNode[] {
  return genres.map((genre) => ({ id: `demo-genre-${genre.toLowerCase()}`, title: genre, childCount: tracks.filter((track) => track.genre === genre).length, userData: { type: "genre" } }));
}

function playlistNodes(): MaestroTreeNode[] {
  return playlists.map((playlist) => ({ id: playlist.id, title: playlist.title, childCount: playlist.trackIds.length, userData: { type: "playlist" } }));
}

function browse(input: MaestroBrowseRequest): MaestroTree {
  if (input.id === "albumname") return tree("demo-albums", albumNodes());
  if (input.id === "artists") return tree("demo-artists", artistNodes());
  if (input.id === "genres") return tree("demo-genres", genreNodes());
  if (input.id === "tracks") return tree("demo-tracks", tracks.map(trackNode));
  if (input.id === "playlists") return tree("demo-playlists", playlistNodes());
  const album = albums.find((item) => item.id === input.id);
  if (album) return tree(album.id, tracks.filter((track) => track.albumId === album.id).map(trackNode));
  const artist = artists.find((item) => item.id === input.id);
  if (artist) return tree(artist.id, albumNodes(artist.id));
  const genre = genres.find((item) => `demo-genre-${item.toLowerCase()}` === input.id);
  if (genre) return tree(input.id, tracks.filter((track) => track.genre === genre).map(trackNode));
  const playlist = playlists.find((item) => item.id === input.id);
  if (playlist) return tree(playlist.id, playlist.trackIds.map((id) => tracks.find((track) => track.id === id)).filter((track): track is DemoTrack => Boolean(track)).map(trackNode));
  return tree(input.id, []);
}

function search(term: string, scope: LibrarySearchScope): MaestroTree {
  const query = term.trim().toLowerCase();
  if (scope === "tracks") return tree("demo-search-tracks", tracks.filter((track) => [track.title, track.artist, track.album, track.genre].some((value) => value.toLowerCase().includes(query))).map(trackNode));
  if (scope === "albums") return tree("demo-search-albums", albumNodes().filter((item) => item.title.toLowerCase().includes(query)));
  if (scope === "artists") return tree("demo-search-artists", artistNodes().filter((item) => item.title.toLowerCase().includes(query)));
  if (scope === "genres") return tree("demo-search-genres", genreNodes().filter((item) => item.title.toLowerCase().includes(query)));
  return tree("demo-search-playlists", playlistNodes().filter((item) => item.title.toLowerCase().includes(query)));
}

let currentIndex = 0;
let transportState: NowPlayingSnapshot["transportState"] = "playing";
let positionSeconds = 38;
let sampledAt = Date.now();

function updatePosition(): void {
  if (transportState !== "playing") return;
  positionSeconds += Math.max(0, (Date.now() - sampledAt) / 1_000);
  const duration = tracks[currentIndex]?.durationSeconds ?? 240;
  if (positionSeconds >= duration) { currentIndex = (currentIndex + 1) % tracks.length; positionSeconds = 0; }
  sampledAt = Date.now();
}

function nowPlaying(): NowPlayingSnapshot {
  updatePosition();
  if (transportState === "stopped") return { itemId: "", metadata: null, transportState, positionSeconds: null, durationSeconds: null, sampledAt: Date.now() };
  const track = tracks[currentIndex]!;
  return { itemId: track.id, metadata: track, transportState, positionSeconds, durationSeconds: track.durationSeconds, sampledAt: Date.now() };
}

function playback(command: PlaybackCommand): { status: number; durationMs: number; ok: true } {
  updatePosition();
  if (command.action === "play") {
    const index = tracks.findIndex((track) => track.id === command.itemId);
    if (index >= 0) currentIndex = index;
    positionSeconds = 0;
    transportState = "playing";
  } else if (command.action === "next" || command.action === "previous") {
    currentIndex = (currentIndex + (command.action === "next" ? 1 : tracks.length - 1)) % tracks.length;
    positionSeconds = 0;
    transportState = "playing";
  } else if (command.action === "pause") {
    transportState = transportState === "playing" ? "paused" : "playing";
  } else {
    transportState = "stopped";
    positionSeconds = 0;
  }
  sampledAt = Date.now();
  return { ok: true, status: 200, durationMs: 18 };
}

function response(path: string, body: string, contentType = "text/html"): TransportResponse {
  return { url: `http://${DEMO_TARGET.host}${path}`, status: 200, statusText: "OK", headers: { "content-type": contentType }, body, durationMs: 12 };
}

function probes(): EndpointProbe[] {
  return ["/", "/maestro.php", "/index.php"].flatMap((path) => [80, 8163].map((port) => ({
    ...response(path, `<html><title>Preview Library</title><body>Reviewer preview endpoint on port ${port}</body></html>`),
    url: `http://${DEMO_TARGET.host}:${port}${path}`,
    contentType: "text/html",
    preview: "Reviewer demo endpoint — no network request was made.",
  })));
}

function targetFrom(path: string, body: unknown): OliveDeviceTarget | undefined {
  if (!body || typeof body !== "object") return undefined;
  const input = body as Record<string, unknown>;
  const candidate = path === "/api/device/identify" || path === "/api/library/navigation" || path === "/api/now-playing" || path === "/api/probe"
    ? input
    : input.target;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate as OliveDeviceTarget;
}

export function handleDemoApi(path: string, body: unknown): { handled: false } | { handled: true; value: unknown } {
  const target = targetFrom(path, body);
  if (!target || !isDemoTarget(target)) return { handled: false };
  const input = body as Record<string, unknown>;
  switch (path) {
    case "/api/device/identify": return { handled: true, value: { ...capabilitiesForModel("o4hd"), displayName: "Preview Library" } };
    case "/api/probe": return { handled: true, value: probes() };
    case "/api/library/navigation": return { handled: true, value: tree("demo-root", [
      { id: "albumname", title: "Albums", childCount: albums.length, userData: { type: "albumname" } },
      { id: "artists", title: "Artists", childCount: artists.length, userData: { type: "artists" } },
      { id: "genres", title: "Genres", childCount: genres.length, userData: { type: "genre" } },
      { id: "tracks", title: "Tracks", childCount: tracks.length, userData: { type: "track" } },
      { id: "playlists", title: "Playlists", childCount: playlists.length, userData: { type: "playlist" } },
    ]) };
    case "/api/library/browse": return { handled: true, value: browse(input.browse as MaestroBrowseRequest) };
    case "/api/library/item-metadata": return { handled: true, value: tracks.find((track) => track.id === input.itemId) ?? null };
    case "/api/library/search": return { handled: true, value: search(String(input.term ?? ""), input.scope as LibrarySearchScope) };
    case "/api/now-playing": return { handled: true, value: nowPlaying() };
    case "/api/playback": return { handled: true, value: playback(input.command as PlaybackCommand) };
    case "/api/request": return { handled: true, value: response(String(input.path ?? "/"), "Reviewer demo response. No request left this device.", "text/plain") };
    default: return { handled: false };
  }
}
