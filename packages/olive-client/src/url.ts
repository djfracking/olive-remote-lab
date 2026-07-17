import type { OliveDeviceTarget } from "./types.js";

const HOST_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function normalizeHost(input: string): string {
  const host = input.trim().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!host || host.includes("/") || !HOST_PATTERN.test(host)) {
    throw new Error("Enter an IP address or local hostname without a path.");
  }
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be an integer from 1 to 65535.");
  }
  return port;
}

export function buildOliveUrl(
  target: OliveDeviceTarget,
  path = "/",
  query: Record<string, string> = {},
): string {
  const host = normalizeHost(target.host);
  const port = assertPort(target.port);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`http://${host}:${port}${safePath}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.append(key, value));
  return url.toString();
}

export function endpointProbeUrls(target: OliveDeviceTarget): string[] {
  const standardPaths = ["/", "/maestro.php", "/index.php"];
  return [
    ...standardPaths.map((path) => buildOliveUrl(target, path)),
    ...standardPaths.map((path) => buildOliveUrl({ ...target, port: 8163 }, path)),
  ];
}
