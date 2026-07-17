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
  playCount: number | null;
  rating: number | null;
  raw: Record<string, unknown>;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
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
    items.push({
      id: item.id,
      title: decodeXml(item.title),
      childCount: item.isDir === true || item.isDir === "1" ? 1 : 0,
      userData: {
        type: item.isDir === true || item.isDir === "1" ? "compilation" : "track",
        ...(/^[0-9]+$/.test(entryKey) ? { playbackIndex: String(Math.max(0, startIndex) + Number(entryKey) + 1) } : {}),
      },
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
    for (const key of keys) if (typeof raw[key] === "string") return raw[key] as string;
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
    artworkPath: normalizeArtworkPath(stringValue("albumart", "albumArt", "artwork")),
    playCount: numericValue("playcount", "playCount"),
    rating: numericValue("myRating", "rating"),
    raw,
  };
}

function normalizeArtworkPath(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}
