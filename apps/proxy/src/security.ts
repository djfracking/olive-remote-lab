import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0] = octets;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isLocalAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateIpv4(address);
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
  }
  return false;
}

export async function assertLocalUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "http:") throw new Error("Only local HTTP targets are allowed.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) === 6) {
    if (!hostname.startsWith("fe80:") && hostname !== "::1") throw new Error("Only local IPv6 targets are allowed.");
    return url;
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isLocalAddress(address))) {
    throw new Error("Target must resolve only to a private local-network address.");
  }
  return url;
}
