import type { OliveDeviceTarget } from "@olive-remote-lab/olive-client";
import { isNativeApp } from "./nativeApi";

export function artworkUrl(target: OliveDeviceTarget, value: string): string {
  if (!value) return "";
  let host = target.host;
  let port = target.port;
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:") return "";
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : 80;
      path = `${parsed.pathname}${parsed.search}`;
      if (isNativeApp) return value;
    } catch { return ""; }
  }
  if (!path.startsWith("/")) return "";
  if (isNativeApp) return `http://${host}:${port}${path}`;
  return `/api/artwork?host=${encodeURIComponent(host)}&port=${port}&path=${encodeURIComponent(path)}`;
}
