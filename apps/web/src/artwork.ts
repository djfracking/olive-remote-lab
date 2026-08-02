import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { CapacitorHttp } from "@capacitor/core";
import { isNativeApp } from "./nativeApi";
import { isDemoTarget } from "./demoOlive";
import { stableDeviceIdentity, type StableOliveTarget } from "./deviceIdentity";

const MAX_NATIVE_ARTWORK_BYTES = 6 * 1024 * 1024;
const MAX_NATIVE_ARTWORK_CACHE = 12;
const nativeArtworkCache = new Map<string, Promise<string>>();

function privateArtworkUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.trim().toLowerCase();
    const privateIpv4 = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
    if (url.protocol !== "http:" || url.username || url.password) return null;
    if (!privateIpv4.test(host) && !host.endsWith(".local")) return null;
    return url;
  } catch {
    return null;
  }
}

function responseContentType(headers: Record<string, string>, url: URL): string {
  const header = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1]?.split(";")[0]?.trim().toLowerCase();
  if (header?.startsWith("image/")) return header;
  if (/\.png(?:$|\?)/i.test(url.pathname)) return "image/png";
  if (/\.gif(?:$|\?)/i.test(url.pathname)) return "image/gif";
  if (/\.webp(?:$|\?)/i.test(url.pathname)) return "image/webp";
  return "image/jpeg";
}

/**
 * Native WebViews can reject otherwise valid LAN artwork URLs. Fetch the image
 * through Capacitor's native HTTP stack and hand the WebView a local data URL.
 */
export async function resolveArtworkSource(source: string): Promise<string> {
  if (!isNativeApp || !source.startsWith("http://")) return source;
  const url = privateArtworkUrl(source);
  if (!url) return "";
  const cached = nativeArtworkCache.get(source);
  if (cached) return cached;

  let request: Promise<string>;
  request = (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await CapacitorHttp.get({
          url: url.toString(),
          responseType: "blob",
          connectTimeout: 3_000,
          readTimeout: 5_000,
          disableRedirects: true,
        });
        if (response.status >= 200 && response.status < 400 && typeof response.data === "string") {
          const compact = response.data.replace(/\s+/g, "");
          if (compact && compact.length <= Math.ceil(MAX_NATIVE_ARTWORK_BYTES * 4 / 3) + 4) {
            return `data:${responseContentType(response.headers ?? {}, url)};base64,${compact}`;
          }
        }
      } catch {
        // One retry covers the common case where the Olive is waking its disk.
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return "";
  })().then((resolved) => {
    if (!resolved && nativeArtworkCache.get(source) === request) nativeArtworkCache.delete(source);
    return resolved;
  });

  nativeArtworkCache.set(source, request);
  while (nativeArtworkCache.size > MAX_NATIVE_ARTWORK_CACHE) {
    const oldest = nativeArtworkCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    nativeArtworkCache.delete(oldest);
  }
  return request;
}

export function artworkUrl(target: OliveDeviceTarget, value: string): string {
  if (!value) return "";
  if (isDemoTarget(target) && value.startsWith("/demo-art/")) return value;
  let host = target.host;
  let port = target.port;
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:") return "";
      host = stableDeviceIdentity(target as StableOliveTarget) ? target.host : parsed.hostname;
      port = parsed.port ? Number(parsed.port) : 80;
      path = `${parsed.pathname}${parsed.search}`;
    } catch { return ""; }
  }
  if (!path.startsWith("/")) return "";
  if (isNativeApp) return `http://${host}:${port}${path}`;
  return `/api/artwork?host=${encodeURIComponent(host)}&port=${port}&path=${encodeURIComponent(path)}`;
}
