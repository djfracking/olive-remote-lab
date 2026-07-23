export interface MaestroTreeNode {
  id: string;
  title: string;
  childCount: number | null;
  userData: Record<string, string>;
}

export interface MaestroTree {
  id: string;
  totalItems: number | null;
  items: MaestroTreeNode[];
}

export interface MaestroTrackMetadata {
  id: string;
  title: string;
  album: string;
  artist: string;
  genre: string;
  artworkPath: string;
  durationSeconds: number | null;
  playCount: number | null;
  rating: number | null;
  raw: Record<string, unknown>;
}

export interface NowPlayingSnapshot {
  itemId: string;
  metadata: MaestroTrackMetadata | null;
  transportState: "playing" | "paused" | "stopped" | "unknown";
  positionSeconds: number | null;
  durationSeconds: number | null;
  sampledAt: number;
}

function decodeXml(value: string): string {
  let decoded = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
      .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function attributes(input: string): Record<string, string> {
  return Object.fromEntries(
    [...input.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
      .map((match) => [match[1] ?? "", decodeXml(match[3] ?? "")])
      .filter(([key]) => Boolean(key)),
  );
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseMaestroTree(xml: string): MaestroTree {
  const treeMatch = xml.match(/<tree\b([^>]*)>/i);
  if (!treeMatch) throw new Error("Response did not contain a Maestro tree.");
  const treeAttributes = attributes(treeMatch[1] ?? "");
  const items = [...xml.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>|<item\b([^>]*)\/>/gi)].map((match) => {
    const itemAttributes = attributes(match[1] ?? match[3] ?? "");
    const body = match[2] ?? "";
    const userData: Record<string, string> = {};
    for (const dataMatch of body.matchAll(/<userdata\b([^>]*)>([\s\S]*?)<\/userdata>/gi)) {
      const dataAttributes = attributes(dataMatch[1] ?? "");
      if (dataAttributes.name) userData[dataAttributes.name] = decodeXml((dataMatch[2] ?? "").trim());
    }
    return {
      id: itemAttributes.id ?? "",
      title: itemAttributes.text ?? "",
      childCount: numberOrNull(itemAttributes.child),
      userData,
    };
  });
  return {
    id: treeAttributes.id ?? "",
    totalItems: numberOrNull(treeAttributes.totalItems),
    items,
  };
}

export function parseCurrentPlayingId(body: string): string | null {
  const match = body.match(/inf_showcurrentplaying\(\s*(["'])(.*?)\1\s*\)/i);
  return match?.[2]?.trim() || null;
}

export function parseMaestroTrackList(body: string): MaestroTree {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("Track list was not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Track list had an unexpected shape.");
  const root = parsed as Record<string, unknown>;
  const items: MaestroTreeNode[] = [];
  const startIndex = typeof root.startindex === "number" ? root.startindex
    : typeof root.startindex === "string" && Number.isFinite(Number(root.startindex)) ? Number(root.startindex)
      : 0;
  for (const [entryKey, value] of Object.entries(root)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.title !== "string") continue;
    const userData: Record<string, string> = {
      type: item.isDir === true || item.isDir === "1" ? "compilation" : "track",
      ...(/^[0-9]+$/.test(entryKey) ? { playbackIndex: String(Math.max(0, startIndex) + Number(entryKey) + 1) } : {}),
    };
    for (const key of [
      "artist", "interpreter", "performer", "album", "albumname", "genre", "major_genre",
      "albumart", "albumArt", "artwork", "artworkPath", "cover", "duration", "trackDuration", "TrackDuration",
    ]) {
      if (typeof item[key] === "string") userData[key] = decodeXml(item[key] as string);
    }
    items.push({
      id: item.id,
      title: decodeXml(item.title),
      childCount: item.isDir === true || item.isDir === "1" ? 1 : 0,
      userData,
    });
  }
  const totalItems = typeof root.totalItems === "number" ? root.totalItems
    : typeof root.totalItems === "string" && Number.isFinite(Number(root.totalItems)) ? Number(root.totalItems)
      : null;
  return { id: "tracks", totalItems, items };
}

export function parseTrackMetadata(body: string): MaestroTrackMetadata | null {
  const match = body.match(/new_info\(\s*'([\s\S]*)'\s*\)\s*;?/i);
  if (!match?.[1]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].replace(/\\'/g, "'"));
  } catch {
    throw new Error("Current-track metadata was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const raw = root.track && typeof root.track === "object" ? root.track as Record<string, unknown> : root;
  const stringValue = (...keys: string[]): string => {
    for (const key of keys) if (typeof raw[key] === "string") return decodeXml(raw[key] as string);
    return "";
  };
  const numericValue = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) return Number(value);
    }
    return null;
  };
  return {
    id: stringValue("id"),
    title: stringValue("title", "track", "name"),
    album: stringValue("album", "albumname"),
    artist: stringValue("artist", "interpreter", "performer"),
    genre: stringValue("genre", "major_genre"),
    artworkPath: normalizeArtworkPath(stringValue("albumart", "albumArt", "artwork", "artworkPath", "cover")),
    durationSeconds: parseTimeSeconds(stringValue("duration", "trackDuration", "TrackDuration")),
    playCount: numericValue("playcount", "playCount"),
    rating: numericValue("myRating", "rating"),
    raw,
  };
}

export function parseTimeSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) return null;
  const values = parts.map(Number);
  const seconds = parts.length === 3
    ? (values[0] ?? 0) * 3600 + (values[1] ?? 0) * 60 + (values[2] ?? 0)
    : (values[0] ?? 0) * 60 + (values[1] ?? 0);
  return Number.isFinite(seconds) ? seconds : null;
}

export function parsePlaybackStatus(body: string): {
  transportState: "playing" | "paused" | "stopped" | "unknown";
  positionSeconds: number | null;
  durationSeconds: number | null;
} {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { transportState: "unknown", positionSeconds: null, durationSeconds: null }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { transportState: "unknown", positionSeconds: null, durationSeconds: null };
  }
  const root = parsed as Record<string, unknown>;
  const media = root.playmediainfo && typeof root.playmediainfo === "object" && !Array.isArray(root.playmediainfo)
    ? root.playmediainfo as Record<string, unknown>
    : root;
  const rawState = typeof media.TransportState === "string" ? media.TransportState
    : typeof root.TransportState === "string" ? root.TransportState
      : "";
  const normalized = rawState.toUpperCase();
  const transportState = normalized === "PLAYING" ? "playing"
    : normalized === "PAUSED_PLAYBACK" || normalized === "PAUSED" ? "paused"
      : normalized === "STOPPED" ? "stopped"
        : "unknown";
  const firstTime = (keys: string[]): number | null => {
    for (const key of keys) {
      const seconds = parseTimeSeconds(media[key] ?? root[key]);
      if (seconds !== null) return seconds;
    }
    return null;
  };
  return {
    transportState,
    positionSeconds: firstTime(["RelativeTimePosition", "relativeTimePosition", "RelTime", "position"]),
    durationSeconds: firstTime(["TrackDuration", "CurrentTrackDuration", "trackDuration", "duration"]),
  };
}

function normalizeArtworkPath(value: string): string {
  if (!value || /artworknotfound\.gif(?:$|\?)/i.test(value)) return "";
  if (!/^https?:\/\//i.test(value)) return value.startsWith("/") ? value : `/${value.replace(/^\.\//, "")}`;
  try {
    const url = new URL(value);
    return url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}
