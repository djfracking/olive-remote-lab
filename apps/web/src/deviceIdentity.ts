import type { OliveDeviceTarget, UpnpServiceDescription } from "@olive-remote-lab/olive-client";

/**
 * Network coordinates can change independently from the physical Olive.
 * `deviceId` is the canonical UPnP identity (normally the MediaServer UDN);
 * `host` and `port` always remain the current controller endpoint.
 */
export interface StableOliveTarget extends OliveDeviceTarget {
  deviceId?: string;
  udn?: string;
  usn?: string;
  descriptionUrl?: string;
  descriptionUrls?: string[];
  services?: readonly UpnpServiceDescription[];
  serviceTypes?: string[];
  /** Service-owner UDNs accepted from Olive-verified device descriptors. */
  approvedServiceDeviceIds?: string[];
}

export function normalizeDeviceIdentity(value: string | null | undefined): string | null {
  let normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (normalized.startsWith("upnp:")) normalized = normalized.slice("upnp:".length);
  normalized = normalized.split("::", 1)[0]?.trim() ?? "";
  if (normalized.startsWith("urn:uuid:")) normalized = `uuid:${normalized.slice("urn:uuid:".length)}`;
  return /^uuid:[a-z0-9][a-z0-9._:-]*$/i.test(normalized) ? normalized : null;
}

export function stableDeviceIdentity(target: StableOliveTarget): string | null {
  return normalizeDeviceIdentity(target.deviceId)
    ?? normalizeDeviceIdentity(target.udn)
    ?? normalizeDeviceIdentity(target.usn);
}

export function deviceEndpointKey(target: OliveDeviceTarget): string {
  return `${target.host.trim().toLowerCase()}:${target.port}`;
}

/** Stable cache identity stays separate from the currently callable endpoint. */
export function deviceRequestKey(target: StableOliveTarget): string {
  const serviceEndpoints = (target.services ?? [])
    .map((service) => service.controlUrl?.trim().toLowerCase() ?? "")
    .filter(Boolean)
    .sort();
  return [deviceEndpointKey(target), ...serviceEndpoints].join("|");
}

export function deviceCacheNamespace(target: StableOliveTarget): string {
  const identity = stableDeviceIdentity(target);
  return identity ? `upnp:${identity}` : deviceEndpointKey(target);
}

export function deviceSelectionKey(target: StableOliveTarget): string {
  const identity = stableDeviceIdentity(target);
  return identity ? `device:${identity}` : `endpoint:${deviceEndpointKey(target)}`;
}

/**
 * A stable-ID mismatch always wins over an endpoint match. A legacy record
 * without an ID may be upgraded only while it is still at the same endpoint.
 */
export function devicesReferToSameOlive(left: StableOliveTarget, right: StableOliveTarget): boolean {
  const leftIdentity = stableDeviceIdentity(left);
  const rightIdentity = stableDeviceIdentity(right);
  if (leftIdentity && rightIdentity) return leftIdentity === rightIdentity;
  return deviceEndpointKey(left) === deviceEndpointKey(right);
}

export function canAdoptDeviceCache(source: StableOliveTarget, destination: StableOliveTarget): boolean {
  const destinationIdentity = stableDeviceIdentity(destination);
  if (!destinationIdentity) return false;
  const sourceIdentity = stableDeviceIdentity(source);
  if (sourceIdentity) return sourceIdentity === destinationIdentity;
  return deviceEndpointKey(source) === deviceEndpointKey(destination);
}

export function withCanonicalDeviceIdentity<T extends StableOliveTarget>(target: T): T {
  const identity = stableDeviceIdentity(target);
  if (!identity || target.deviceId === identity) return target;
  return { ...target, deviceId: identity };
}

/**
 * Service control URLs are tied to the discovered address. If a known Olive
 * moves to a new DHCP address and descriptor enrichment is temporarily
 * incomplete, never carry the old address's SOAP endpoints into the new
 * target. A later successful discovery can safely add the fresh services.
 */
export function mergeStableOliveTarget<T extends StableOliveTarget>(prior: T, incoming: T): T {
  const endpointChanged = deviceEndpointKey(prior) !== deviceEndpointKey(incoming);
  const merged = { ...prior, ...incoming } as T;
  if (!endpointChanged || incoming.services?.length) return merged;

  const {
    services: _services,
    serviceTypes: _serviceTypes,
    approvedServiceDeviceIds: _approvedServiceDeviceIds,
    descriptionUrl: _descriptionUrl,
    descriptionUrls: _descriptionUrls,
    ...withoutEndpointMetadata
  } = merged;
  return {
    ...withoutEndpointMetadata,
    ...(incoming.descriptionUrl ? { descriptionUrl: incoming.descriptionUrl } : {}),
    ...(incoming.descriptionUrls?.length ? { descriptionUrls: incoming.descriptionUrls } : {}),
  } as T;
}

/**
 * Replaces every saved address for the same stable device with the newly
 * observed endpoint, while retaining unrelated Olives even if DHCP reordered
 * their addresses.
 */
export function upsertSavedDevice<T extends StableOliveTarget>(items: readonly T[], incoming: T): T[] {
  const matches = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => devicesReferToSameOlive(item, incoming));
  if (!matches.length) return [...items, incoming];

  const insertionIndex = matches[0]?.index ?? items.length;
  const prior = matches[0]?.item;
  const merged = prior ? mergeStableOliveTarget(prior, incoming) : incoming;
  const next = items.filter((item) => !devicesReferToSameOlive(item, incoming));
  next.splice(Math.min(insertionIndex, next.length), 0, merged);
  return next;
}
