export type HttpMethod = "GET" | "POST";

export interface OliveDeviceTarget {
  host: string;
  port: number;
}

export interface TransportRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface TransportResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

/** Firmware-neutral boundary. Alternate transports can implement this later. */
export interface OliveTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

export interface EndpointProbe extends TransportResponse {
  contentType: string;
  preview: string;
  error?: string;
}

export interface ExplorerRequest {
  target: OliveDeviceTarget;
  method: HttpMethod;
  path: string;
  query?: Record<string, string>;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export type ParsedBodyKind = "json" | "xml" | "html" | "text";

export interface ParsedBody {
  kind: ParsedBodyKind;
  formatted: string;
}

export interface MaestroBrowseRequest {
  id: string;
  type: "albumname" | "artists" | "artist" | "album" | "compilation" | "composer" | "genre" | "playlist" | "track";
  startIndex?: number;
  index?: number;
}

export type PlaybackCommand =
  | { action: "play"; itemId: string; index?: number }
  | { action: "seek"; positionSeconds: number }
  | { action: "pause" | "stop" | "previous" | "next" | "volumeDown" | "mute" | "volumeUp" };

export type LibrarySearchScope = "albums" | "artists" | "composers" | "genres" | "tracks" | "playlists";

export type PlaybackTransportState = "playing" | "paused" | "stopped" | "unknown";
