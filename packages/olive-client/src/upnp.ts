import type { OliveTransport, TransportResponse } from "./types.js";
import {
  escapeUpnpXml,
  parseUpnpXml,
  upnpXmlAttribute,
  upnpXmlChild,
  upnpXmlChildText,
  upnpXmlChildren,
  upnpXmlDescendants,
  upnpXmlText,
  type UpnpXmlElement,
} from "./upnpXml.js";

export type UpnpServiceFamily = "ContentDirectory" | "AVTransport" | "RenderingControl";
export type UpnpActionRisk = "read-only" | "playback-mutation" | "rendering-mutation" | "quarantined";
export type UpnpReadOnlyAction =
  | "GetSystemUpdateID"
  | "GetSearchCapabilities"
  | "GetSortCapabilities"
  | "Browse"
  | "Search"
  | "GetPositionInfo"
  | "GetTransportInfo"
  | "GetMediaInfo"
  | "GetVolume"
  | "GetMute";

export interface UpnpServiceDescription {
  readonly serviceType: string;
  readonly serviceId: string;
  readonly rawScpdUrl: string;
  readonly rawControlUrl: string;
  readonly rawEventSubUrl: string;
  readonly scpdUrl: string | null;
  readonly controlUrl: string | null;
  readonly eventSubUrl: string | null;
  readonly deviceUdn: string | null;
}

export interface UpnpDeviceIcon {
  readonly mimeType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly depth: number | null;
  readonly rawUrl: string;
  readonly url: string | null;
}

export interface UpnpDevice {
  readonly deviceType: string;
  readonly friendlyName: string;
  readonly manufacturer: string;
  readonly manufacturerUrl: string;
  readonly modelDescription: string;
  readonly modelName: string;
  readonly modelNumber: string;
  readonly modelUrl: string;
  readonly serialNumber: string;
  readonly udn: string | null;
  readonly upc: string;
  readonly presentationUrl: string | null;
  readonly services: readonly UpnpServiceDescription[];
  readonly icons: readonly UpnpDeviceIcon[];
  readonly embeddedDevices: readonly UpnpDevice[];
}

export interface UpnpDeviceDescription {
  readonly descriptionUrl: string;
  readonly urlBase: string | null;
  readonly specVersion: { readonly major: number; readonly minor: number } | null;
  readonly rootDevice: UpnpDevice;
  readonly services: readonly UpnpServiceDescription[];
  readonly udn: string | null;
  readonly ssdpUsn: string | null;
  readonly stableIdentity: string | null;
}

export interface ParseUpnpDeviceDescriptionOptions {
  readonly descriptionUrl: string;
  readonly ssdpUsn?: string;
}

export interface UpnpActionArgument {
  readonly name: string;
  readonly direction: "in" | "out" | string;
  readonly relatedStateVariable: string;
  readonly isReturnValue: boolean;
}

export interface UpnpActionDefinition {
  readonly name: string;
  readonly arguments: readonly UpnpActionArgument[];
}

export interface UpnpStateVariable {
  readonly name: string;
  readonly dataType: string;
  readonly sendEvents: boolean | null;
  readonly multicast: boolean | null;
  readonly defaultValue: string | null;
  readonly allowedValues: readonly string[];
  readonly allowedValueRange: {
    readonly minimum: string | null;
    readonly maximum: string | null;
    readonly step: string | null;
  } | null;
}

export interface UpnpScpd {
  readonly specVersion: { readonly major: number; readonly minor: number } | null;
  readonly actions: readonly UpnpActionDefinition[];
  readonly stateVariables: readonly UpnpStateVariable[];
}

export interface UpnpCatalogIdentifiers {
  /** Legacy Maestro identifier, populated only after an explicit mapping. */
  readonly maestroId: string | null;
  /** Exact DIDL object identifier returned by the Olive. */
  readonly upnpId: string;
  /** Exact DIDL reference identifier returned by the Olive, when present. */
  readonly upnpRefId: string | null;
  /** Exact DIDL parent identifier returned by the Olive, when present. */
  readonly upnpParentId: string | null;
}

export interface UpnpResource {
  readonly uri: string;
  readonly protocolInfo: string;
  readonly duration: string | null;
  readonly durationSeconds: number | null;
  readonly size: number | null;
  readonly bitrate: number | null;
  readonly sampleFrequency: number | null;
  readonly bitsPerSample: number | null;
  readonly nrAudioChannels: number | null;
  readonly resolution: string | null;
}

export interface UpnpDidlObject {
  readonly kind: "container" | "item";
  readonly identifiers: UpnpCatalogIdentifiers;
  readonly id: string;
  readonly refId: string | null;
  readonly parentId: string | null;
  readonly restricted: boolean | null;
  readonly searchable: boolean | null;
  readonly childCount: number | null;
  readonly className: string;
  readonly title: string;
  readonly artist: string | null;
  readonly artists: readonly string[];
  readonly album: string | null;
  readonly genre: string | null;
  readonly genres: readonly string[];
  readonly creator: string | null;
  readonly albumArtUri: string | null;
  readonly resources: readonly UpnpResource[];
  readonly resourceUri: string | null;
  readonly resourceProtocolInfo: string | null;
  readonly duration: string | null;
  readonly durationSeconds: number | null;
}

export interface UpnpBrowseInput {
  readonly objectId: string;
  readonly browseFlag?: "BrowseMetadata" | "BrowseDirectChildren";
  readonly filter?: string;
  readonly startingIndex?: number;
  readonly requestedCount?: number;
  readonly sortCriteria?: string;
  readonly timeoutMs?: number;
}

export interface UpnpSearchInput {
  readonly containerId: string;
  readonly searchCriteria: string;
  readonly filter?: string;
  readonly startingIndex?: number;
  readonly requestedCount?: number;
  readonly sortCriteria?: string;
}

/**
 * Builds one bounded exact-title query. The observed O4HD performs unbounded
 * `contains`/cross-field scans in several seconds, but its indexed equality
 * lookup returns containers in well under a second. Three case variants cover
 * common lowercase keyboard input while the incremental local index supplies
 * partial-word and cross-field matches.
 */
export function buildOliveUpnpSearchCriteria(
  term: string,
  searchCapabilities?: readonly string[],
): string {
  const normalized = term.trim().replace(/[\u0000-\u001f\u007f]/g, " ");
  if (!normalized || normalized.length > 200) {
    throw new Error("Search text must be between 1 and 200 characters.");
  }
  if (searchCapabilities) {
    const advertised = new Set(searchCapabilities.map((value) => value.trim().toLowerCase()));
    if (!advertised.has("*") && !advertised.has("dc:title")) {
      throw new Error("This Olive does not advertise title search.");
    }
  }
  const escaped = normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const titleCase = escaped.replace(/\S+/g, (word) =>
    `${word.charAt(0).toLocaleUpperCase()}${word.slice(1).toLocaleLowerCase()}`);
  const variants = [...new Set([escaped, escaped.toLocaleUpperCase(), titleCase])];
  return variants.map((value) => `dc:title = "${value}"`).join(" or ");
}

export interface UpnpContentResult {
  readonly objects: readonly UpnpDidlObject[];
  readonly numberReturned: number;
  readonly totalMatches: number;
  readonly updateId: string;
  readonly rawDidl: string;
}

export interface UpnpCapabilities {
  readonly raw: string;
  readonly values: readonly string[];
}

export interface UpnpPositionInfo {
  readonly track: number | null;
  readonly trackDuration: string | null;
  readonly trackDurationSeconds: number | null;
  readonly trackMetadata: readonly UpnpDidlObject[];
  readonly trackUri: string | null;
  readonly relativeTime: string | null;
  readonly relativeTimeSeconds: number | null;
  readonly absoluteTime: string | null;
  readonly absoluteTimeSeconds: number | null;
  readonly relativeCount: number | null;
  readonly absoluteCount: number | null;
}

export interface UpnpTransportInfo {
  readonly currentTransportState: string;
  readonly currentTransportStatus: string;
  readonly currentSpeed: string;
}

export interface UpnpMediaInfo {
  readonly numberOfTracks: number | null;
  readonly mediaDuration: string | null;
  readonly mediaDurationSeconds: number | null;
  readonly currentUri: string | null;
  readonly currentUriMetadata: readonly UpnpDidlObject[];
  readonly nextUri: string | null;
  readonly nextUriMetadata: readonly UpnpDidlObject[];
  readonly playMedium: string | null;
  readonly recordMedium: string | null;
  readonly writeStatus: string | null;
}

export interface UpnpVolume {
  readonly channel: string;
  readonly value: number;
}

export interface UpnpMute {
  readonly channel: string;
  readonly value: boolean;
}

export type UpnpMutation =
  | { readonly service: "AVTransport"; readonly action: "SetAVTransportURI" | "SetNextAVTransportURI" | "Play" | "Pause" | "Stop" | "Seek" | "Next" | "Previous" }
  | { readonly service: "RenderingControl"; readonly action: "SetVolume" | "SetMute" };

export const UPNP_MUTATING_ACTIONS = [
  { service: "AVTransport", action: "SetAVTransportURI", risk: "playback-mutation" },
  { service: "AVTransport", action: "SetNextAVTransportURI", risk: "playback-mutation" },
  { service: "AVTransport", action: "Play", risk: "playback-mutation" },
  { service: "AVTransport", action: "Pause", risk: "playback-mutation" },
  { service: "AVTransport", action: "Stop", risk: "playback-mutation" },
  { service: "AVTransport", action: "Seek", risk: "playback-mutation" },
  { service: "AVTransport", action: "Next", risk: "playback-mutation" },
  { service: "AVTransport", action: "Previous", risk: "playback-mutation" },
  { service: "RenderingControl", action: "SetVolume", risk: "rendering-mutation" },
  { service: "RenderingControl", action: "SetMute", risk: "rendering-mutation" },
] as const satisfies readonly (UpnpMutation & { readonly risk: Exclude<UpnpActionRisk, "read-only" | "quarantined"> })[];

const READ_ONLY_ACTIONS: Readonly<Record<UpnpServiceFamily, ReadonlySet<string>>> = {
  ContentDirectory: new Set(["GetSystemUpdateID", "GetSearchCapabilities", "GetSortCapabilities", "Browse", "Search"]),
  AVTransport: new Set(["GetPositionInfo", "GetTransportInfo", "GetMediaInfo"]),
  RenderingControl: new Set(["GetVolume", "GetMute"]),
};

export class UpnpSoapFault extends Error {
  public override readonly name = "UpnpSoapFault";

  public constructor(
    message: string,
    public readonly faultCode: string,
    public readonly faultString: string,
    public readonly upnpErrorCode: string | null,
    public readonly upnpErrorDescription: string | null,
    public readonly httpStatus: number | null,
  ) {
    super(message);
  }
}

function nullable(value: string): string | null {
  return value === "" || value === "NOT_IMPLEMENTED" ? null : value;
}

function parseInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = parseInteger(value);
  if (parsed === null || parsed < 0) throw new Error(`Invalid ${label} in UPnP response.`);
  return parsed;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === undefined || value === "") return null;
  if (value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes") return true;
  if (value === "0" || value.toLowerCase() === "false" || value.toLowerCase() === "no") return false;
  return null;
}

export function parseUpnpDuration(value: string | null | undefined): number | null {
  if (!value || value === "NOT_IMPLEMENTED") return null;
  const match = value.trim().match(/^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function isPrivateUpnpHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local")) return true;
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/.test(part))) {
    const values = octets.map(Number);
    if (values.some((value) => value > 255)) return false;
    const [first = -1, second = -1] = values;
    return first === 10
      || first === 127
      || first === 192 && second === 168
      || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31;
  }
  if (!host.includes(":") || !/^[0-9a-f:]+$/.test(host)) return false;
  if (host === "::1") return true;
  const firstHextet = Number.parseInt(host.split(":", 1)[0] || "0", 16);
  return firstHextet >= 0xfc00 && firstHextet <= 0xfdff
    || firstHextet >= 0xfe80 && firstHextet <= 0xfebf;
}

export function resolveUpnpServiceUrl(descriptionUrl: string, reference: string, urlBase?: string | null): string {
  const description = new URL(descriptionUrl);
  if (description.protocol !== "http:" || !isPrivateUpnpHost(description.hostname)) {
    throw new Error("UPnP descriptions must come from a private HTTP host.");
  }
  if (description.username || description.password) throw new Error("UPnP URLs may not contain credentials.");

  let base = description;
  if (urlBase?.trim()) {
    const candidateBase = new URL(urlBase.trim(), description);
    if (
      candidateBase.protocol === "http:"
      && candidateBase.hostname.toLowerCase() === description.hostname.toLowerCase()
      && !candidateBase.username
      && !candidateBase.password
    ) {
      base = candidateBase;
    }
  }
  const resolved = new URL(reference, base);
  if (
    resolved.protocol !== "http:"
    || resolved.hostname.toLowerCase() !== description.hostname.toLowerCase()
    || resolved.username
    || resolved.password
  ) {
    throw new Error("A UPnP service URL attempted to leave the discovered device host.");
  }
  resolved.hash = "";
  return resolved.toString();
}

function optionalResolvedUrl(descriptionUrl: string, reference: string, urlBase: string | null): string | null {
  if (!reference.trim()) return null;
  try {
    return resolveUpnpServiceUrl(descriptionUrl, reference.trim(), urlBase);
  } catch {
    return null;
  }
}

export function deriveStableUpnpIdentity(input: { readonly udn?: string | null; readonly usn?: string | null }): string | null {
  const candidate = input.udn?.trim() || input.usn?.split("::")[0]?.trim() || "";
  if (!candidate) return null;
  const canonical = /^uuid:/i.test(candidate)
    ? `uuid:${candidate.slice(candidate.indexOf(":") + 1).toLowerCase()}`
    : candidate.toLowerCase();
  return `upnp:${canonical}`;
}

function parseSpecVersion(root: UpnpXmlElement): { major: number; minor: number } | null {
  const version = upnpXmlChild(root, "specVersion");
  if (!version) return null;
  const major = parseInteger(upnpXmlChildText(version, "major"));
  const minor = parseInteger(upnpXmlChildText(version, "minor"));
  return major === null || minor === null ? null : { major, minor };
}

function parseService(
  element: UpnpXmlElement,
  descriptionUrl: string,
  urlBase: string | null,
  deviceUdn: string | null,
): UpnpServiceDescription {
  const rawScpdUrl = upnpXmlChildText(element, "SCPDURL");
  const rawControlUrl = upnpXmlChildText(element, "controlURL");
  const rawEventSubUrl = upnpXmlChildText(element, "eventSubURL");
  return {
    serviceType: upnpXmlChildText(element, "serviceType"),
    serviceId: upnpXmlChildText(element, "serviceId"),
    rawScpdUrl,
    rawControlUrl,
    rawEventSubUrl,
    scpdUrl: optionalResolvedUrl(descriptionUrl, rawScpdUrl, urlBase),
    controlUrl: optionalResolvedUrl(descriptionUrl, rawControlUrl, urlBase),
    eventSubUrl: optionalResolvedUrl(descriptionUrl, rawEventSubUrl, urlBase),
    deviceUdn,
  };
}

function parseIcon(element: UpnpXmlElement, descriptionUrl: string, urlBase: string | null): UpnpDeviceIcon {
  const rawUrl = upnpXmlChildText(element, "url");
  return {
    mimeType: upnpXmlChildText(element, "mimetype"),
    width: parseInteger(upnpXmlChildText(element, "width")),
    height: parseInteger(upnpXmlChildText(element, "height")),
    depth: parseInteger(upnpXmlChildText(element, "depth")),
    rawUrl,
    url: optionalResolvedUrl(descriptionUrl, rawUrl, urlBase),
  };
}

function parseDevice(element: UpnpXmlElement, descriptionUrl: string, urlBase: string | null): UpnpDevice {
  const udn = nullable(upnpXmlChildText(element, "UDN"));
  const services = upnpXmlChildren(upnpXmlChild(element, "serviceList") ?? element, "service")
    .map((service) => parseService(service, descriptionUrl, urlBase, udn));
  const icons = upnpXmlChildren(upnpXmlChild(element, "iconList") ?? element, "icon")
    .map((icon) => parseIcon(icon, descriptionUrl, urlBase));
  const embeddedDevices = upnpXmlChildren(upnpXmlChild(element, "deviceList") ?? element, "device")
    .map((device) => parseDevice(device, descriptionUrl, urlBase));
  const rawPresentationUrl = upnpXmlChildText(element, "presentationURL");
  return {
    deviceType: upnpXmlChildText(element, "deviceType"),
    friendlyName: upnpXmlChildText(element, "friendlyName"),
    manufacturer: upnpXmlChildText(element, "manufacturer"),
    manufacturerUrl: upnpXmlChildText(element, "manufacturerURL"),
    modelDescription: upnpXmlChildText(element, "modelDescription"),
    modelName: upnpXmlChildText(element, "modelName"),
    modelNumber: upnpXmlChildText(element, "modelNumber"),
    modelUrl: upnpXmlChildText(element, "modelURL"),
    serialNumber: upnpXmlChildText(element, "serialNumber"),
    udn,
    upc: upnpXmlChildText(element, "UPC"),
    presentationUrl: optionalResolvedUrl(descriptionUrl, rawPresentationUrl, urlBase),
    services,
    icons,
    embeddedDevices,
  };
}

function flattenServices(device: UpnpDevice): UpnpServiceDescription[] {
  return [...device.services, ...device.embeddedDevices.flatMap(flattenServices)];
}

export function parseUpnpDeviceDescription(
  xml: string,
  options: ParseUpnpDeviceDescriptionOptions,
): UpnpDeviceDescription {
  const root = parseUpnpXml(xml);
  if (root.localName.toLowerCase() !== "root") throw new Error("Not a UPnP device description.");
  // Validate the discovery URL even when the descriptor has no services.
  resolveUpnpServiceUrl(options.descriptionUrl, "");
  const rawUrlBase = upnpXmlChildText(root, "URLBase");
  let urlBase: string | null = null;
  if (rawUrlBase) {
    try {
      urlBase = resolveUpnpServiceUrl(options.descriptionUrl, rawUrlBase);
    } catch {
      // Ignore an unsafe URLBase and resolve each local path against LOCATION.
    }
  }
  const deviceElement = upnpXmlChild(root, "device");
  if (!deviceElement) throw new Error("UPnP device description has no root device.");
  const rootDevice = parseDevice(deviceElement, options.descriptionUrl, urlBase);
  const ssdpUsn = options.ssdpUsn?.trim() || null;
  return {
    descriptionUrl: options.descriptionUrl,
    urlBase,
    specVersion: parseSpecVersion(root),
    rootDevice,
    services: flattenServices(rootDevice),
    udn: rootDevice.udn,
    ssdpUsn,
    stableIdentity: deriveStableUpnpIdentity({ udn: rootDevice.udn, usn: ssdpUsn }),
  };
}

export function findUpnpService(
  description: UpnpDeviceDescription,
  family: UpnpServiceFamily,
): UpnpServiceDescription | undefined {
  return description.services.find((service) =>
    new RegExp(`:service:${family}:\\d+$`, "i").test(service.serviceType));
}

export function parseUpnpScpd(xml: string): UpnpScpd {
  const root = parseUpnpXml(xml);
  if (root.localName.toLowerCase() !== "scpd") throw new Error("Not a UPnP service description.");
  const actionList = upnpXmlChild(root, "actionList");
  const stateTable = upnpXmlChild(root, "serviceStateTable");
  const actions = actionList ? upnpXmlChildren(actionList, "action").map((action): UpnpActionDefinition => {
    const argumentList = upnpXmlChild(action, "argumentList");
    return {
      name: upnpXmlChildText(action, "name"),
      arguments: argumentList ? upnpXmlChildren(argumentList, "argument").map((argument): UpnpActionArgument => ({
        name: upnpXmlChildText(argument, "name"),
        direction: upnpXmlChildText(argument, "direction"),
        relatedStateVariable: upnpXmlChildText(argument, "relatedStateVariable"),
        isReturnValue: Boolean(upnpXmlChild(argument, "retval")),
      })) : [],
    };
  }) : [];
  const stateVariables = stateTable ? upnpXmlChildren(stateTable, "stateVariable").map((variable): UpnpStateVariable => {
    const allowedValueList = upnpXmlChild(variable, "allowedValueList");
    const range = upnpXmlChild(variable, "allowedValueRange");
    return {
      name: upnpXmlChildText(variable, "name"),
      dataType: upnpXmlChildText(variable, "dataType"),
      sendEvents: parseBoolean(upnpXmlAttribute(variable, "sendEvents")),
      multicast: parseBoolean(upnpXmlAttribute(variable, "multicast")),
      defaultValue: nullable(upnpXmlChildText(variable, "defaultValue")),
      allowedValues: allowedValueList
        ? upnpXmlChildren(allowedValueList, "allowedValue").map(upnpXmlText)
        : [],
      allowedValueRange: range ? {
        minimum: nullable(upnpXmlChildText(range, "minimum")),
        maximum: nullable(upnpXmlChildText(range, "maximum")),
        step: nullable(upnpXmlChildText(range, "step")),
      } : null,
    };
  }) : [];
  return { specVersion: parseSpecVersion(root), actions, stateVariables };
}

export function upnpScpdSupportsAction(scpd: UpnpScpd, action: string): boolean {
  return scpd.actions.some((definition) => definition.name === action);
}

function serviceFamily(serviceType: string): UpnpServiceFamily | null {
  for (const family of Object.keys(READ_ONLY_ACTIONS) as UpnpServiceFamily[]) {
    if (new RegExp(`:service:${family}:\\d+$`, "i").test(serviceType)) return family;
  }
  return null;
}

export function classifyUpnpAction(serviceType: string, action: string): UpnpActionRisk {
  const family = serviceFamily(serviceType);
  if (family && READ_ONLY_ACTIONS[family].has(action)) return "read-only";
  const mutation = UPNP_MUTATING_ACTIONS.find((entry) => entry.service === family && entry.action === action);
  return mutation?.risk ?? "quarantined";
}

function buildUpnpSoapRequest(
  serviceType: string,
  action: string,
  arguments_: Readonly<Record<string, string | number | boolean>>,
): string {
  const argumentsXml = Object.entries(arguments_).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error("Invalid UPnP SOAP argument name.");
    return `<${name}>${escapeUpnpXml(value)}</${name}>`;
  }).join("");
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:${action} xmlns:u="${escapeUpnpXml(serviceType)}">${argumentsXml}</u:${action}></s:Body></s:Envelope>`;
}

/** Builds an envelope only for the audited getter allow-list. */
export function buildReadOnlyUpnpSoapRequest(
  serviceType: string,
  action: UpnpReadOnlyAction,
  arguments_: Readonly<Record<string, string | number | boolean>>,
): string {
  if (classifyUpnpAction(serviceType, action) !== "read-only") {
    throw new Error(`UPnP action ${action} is not allowed for this service.`);
  }
  return buildUpnpSoapRequest(serviceType, action, arguments_);
}

function soapFault(root: UpnpXmlElement, status: number | null): UpnpSoapFault | null {
  const fault = upnpXmlDescendants(root, "Fault")[0];
  if (!fault) return null;
  const faultCode = upnpXmlChildText(fault, "faultcode");
  const faultString = upnpXmlChildText(fault, "faultstring");
  const upnpError = upnpXmlDescendants(fault, "UPnPError")[0];
  const errorCode = upnpError ? nullable(upnpXmlChildText(upnpError, "errorCode")) : null;
  const errorDescription = upnpError ? nullable(upnpXmlChildText(upnpError, "errorDescription")) : null;
  const detail = errorCode ? `UPnP ${errorCode}${errorDescription ? `: ${errorDescription}` : ""}` : faultString || faultCode;
  return new UpnpSoapFault(detail || "UPnP SOAP fault.", faultCode, faultString, errorCode, errorDescription, status);
}

export function parseUpnpSoapResponse(
  xml: string,
  action: string,
  httpStatus: number | null = null,
): Readonly<Record<string, string>> {
  const root = parseUpnpXml(xml);
  const fault = soapFault(root, httpStatus);
  if (fault) throw fault;
  const response = upnpXmlDescendants(root, `${action}Response`)[0];
  if (!response) throw new Error(`UPnP SOAP response did not contain ${action}Response.`);
  return Object.fromEntries(upnpXmlChildren(response).map((child) => [child.localName, upnpXmlText(child)]));
}

function parseDidlResource(element: UpnpXmlElement): UpnpResource {
  const duration = nullable(upnpXmlAttribute(element, "duration") ?? "");
  return {
    uri: upnpXmlText(element),
    protocolInfo: upnpXmlAttribute(element, "protocolInfo") ?? "",
    duration,
    durationSeconds: parseUpnpDuration(duration),
    size: parseInteger(upnpXmlAttribute(element, "size") ?? ""),
    bitrate: parseInteger(upnpXmlAttribute(element, "bitrate") ?? ""),
    sampleFrequency: parseInteger(upnpXmlAttribute(element, "sampleFrequency") ?? ""),
    bitsPerSample: parseInteger(upnpXmlAttribute(element, "bitsPerSample") ?? ""),
    nrAudioChannels: parseInteger(upnpXmlAttribute(element, "nrAudioChannels") ?? ""),
    resolution: nullable(upnpXmlAttribute(element, "resolution") ?? ""),
  };
}

function parseDidlObject(element: UpnpXmlElement): UpnpDidlObject {
  const id = upnpXmlAttribute(element, "id") ?? "";
  const refId = nullable(upnpXmlAttribute(element, "refID") ?? "");
  const parentId = nullable(upnpXmlAttribute(element, "parentID") ?? "");
  const artistElements = upnpXmlChildren(element, "artist");
  const genreElements = upnpXmlChildren(element, "genre");
  const artists = artistElements.map(upnpXmlText).filter(Boolean);
  const genres = genreElements.map(upnpXmlText).filter(Boolean);
  const resources = upnpXmlChildren(element, "res").map(parseDidlResource);
  const firstResource = resources[0];
  return {
    kind: element.localName.toLowerCase() === "container" ? "container" : "item",
    identifiers: { maestroId: null, upnpId: id, upnpRefId: refId, upnpParentId: parentId },
    id,
    refId,
    parentId,
    restricted: parseBoolean(upnpXmlAttribute(element, "restricted")),
    searchable: parseBoolean(upnpXmlAttribute(element, "searchable")),
    childCount: parseInteger(upnpXmlAttribute(element, "childCount") ?? ""),
    className: upnpXmlChildText(element, "class"),
    title: upnpXmlChildText(element, "title"),
    artist: artists[0] ?? null,
    artists,
    album: nullable(upnpXmlChildText(element, "album")),
    genre: genres[0] ?? null,
    genres,
    creator: nullable(upnpXmlChildText(element, "creator")),
    albumArtUri: nullable(upnpXmlChildText(element, "albumArtURI")),
    resources,
    resourceUri: firstResource?.uri ?? null,
    resourceProtocolInfo: firstResource?.protocolInfo || null,
    duration: firstResource?.duration ?? null,
    durationSeconds: firstResource?.durationSeconds ?? null,
  };
}

export function parseDidlLite(xml: string): UpnpDidlObject[] {
  if (!xml.trim()) return [];
  const root = parseUpnpXml(xml);
  if (root.localName.toLowerCase() !== "didl-lite") throw new Error("Not a DIDL-Lite document.");
  return upnpXmlChildren(root)
    .filter((element) => ["container", "item"].includes(element.localName.toLowerCase()))
    .map(parseDidlObject);
}

function parseMetadata(value: string | undefined): UpnpDidlObject[] {
  const metadata = nullable(value ?? "");
  if (!metadata) return [];
  try {
    return parseDidlLite(metadata);
  } catch {
    return [];
  }
}

function serviceTypeFor(service: UpnpServiceDescription, family: UpnpServiceFamily): string {
  if (serviceFamily(service.serviceType) !== family) {
    throw new Error(`Expected a ${family} UPnP service.`);
  }
  if (!service.controlUrl) throw new Error(`${family} has no safe control URL.`);
  return service.serviceType;
}

function validatePageIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}

function validateRequestedCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error("RequestedCount must be an integer between 1 and 64.");
  }
}

function validateCatalogIdentifier(value: string, label: string): void {
  if (!value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function parseCapabilities(raw: string): UpnpCapabilities {
  return {
    raw,
    values: raw.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function parseContentResult(values: Readonly<Record<string, string>>): UpnpContentResult {
  const rawDidl = values.Result ?? "";
  return {
    objects: parseDidlLite(rawDidl),
    numberReturned: parseNonNegativeInteger(values.NumberReturned ?? "", "NumberReturned"),
    totalMatches: parseNonNegativeInteger(values.TotalMatches ?? "", "TotalMatches"),
    updateId: values.UpdateID ?? "",
    rawDidl,
  };
}

export class OliveUpnpClient {
  public constructor(private readonly transport: OliveTransport) {}

  public async getDeviceDescription(
    descriptionUrl: string,
    options: { readonly ssdpUsn?: string; readonly timeoutMs?: number } = {},
  ): Promise<UpnpDeviceDescription> {
    // Validation happens before transport so discovery input cannot escape the LAN.
    resolveUpnpServiceUrl(descriptionUrl, "");
    const response = await this.transport.request({
      method: "GET",
      url: descriptionUrl,
      timeoutMs: options.timeoutMs ?? 4_000,
    });
    this.assertHttpSuccess(response, "UPnP device description");
    return parseUpnpDeviceDescription(response.body, {
      descriptionUrl,
      ...(options.ssdpUsn ? { ssdpUsn: options.ssdpUsn } : {}),
    });
  }

  public async getScpd(service: UpnpServiceDescription, timeoutMs = 4_000): Promise<UpnpScpd> {
    if (!service.scpdUrl) throw new Error("UPnP service has no safe SCPD URL.");
    const response = await this.transport.request({ method: "GET", url: service.scpdUrl, timeoutMs });
    this.assertHttpSuccess(response, "UPnP service description");
    return parseUpnpScpd(response.body);
  }

  public async getSystemUpdateId(service: UpnpServiceDescription): Promise<string> {
    serviceTypeFor(service, "ContentDirectory");
    const values = await this.invokeReadOnly(service, "GetSystemUpdateID", {});
    // UPnP defines `Id`; the observed O4HD firmware returns
    // `SystemUpdateID`. Preserve both without accepting an arbitrary field.
    return values.Id ?? values.SystemUpdateID ?? "";
  }

  public async getSearchCapabilities(service: UpnpServiceDescription): Promise<UpnpCapabilities> {
    serviceTypeFor(service, "ContentDirectory");
    const values = await this.invokeReadOnly(service, "GetSearchCapabilities", {});
    return parseCapabilities(values.SearchCaps ?? "");
  }

  public async getSortCapabilities(service: UpnpServiceDescription): Promise<UpnpCapabilities> {
    serviceTypeFor(service, "ContentDirectory");
    const values = await this.invokeReadOnly(service, "GetSortCapabilities", {});
    return parseCapabilities(values.SortCaps ?? "");
  }

  public async browse(service: UpnpServiceDescription, input: UpnpBrowseInput): Promise<UpnpContentResult> {
    serviceTypeFor(service, "ContentDirectory");
    const startingIndex = input.startingIndex ?? 0;
    const requestedCount = input.requestedCount ?? 64;
    validateCatalogIdentifier(input.objectId, "ObjectID");
    validatePageIndex(startingIndex, "StartingIndex");
    validateRequestedCount(requestedCount);
    const timeoutMs = input.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15_000) {
      throw new Error("Browse timeout must be between 1000 and 15000 milliseconds.");
    }
    const values = await this.invokeReadOnly(service, "Browse", {
      ObjectID: input.objectId,
      BrowseFlag: input.browseFlag ?? "BrowseDirectChildren",
      Filter: input.filter ?? "*",
      StartingIndex: startingIndex,
      RequestedCount: requestedCount,
      SortCriteria: input.sortCriteria ?? "",
    }, timeoutMs);
    return parseContentResult(values);
  }

  public async search(service: UpnpServiceDescription, input: UpnpSearchInput): Promise<UpnpContentResult> {
    serviceTypeFor(service, "ContentDirectory");
    const startingIndex = input.startingIndex ?? 0;
    const requestedCount = input.requestedCount ?? 64;
    validateCatalogIdentifier(input.containerId, "ContainerID");
    if (!input.searchCriteria.trim() || input.searchCriteria.length > 1_000) {
      throw new Error("SearchCriteria is invalid.");
    }
    validatePageIndex(startingIndex, "StartingIndex");
    validateRequestedCount(requestedCount);
    const values = await this.invokeReadOnly(service, "Search", {
      ContainerID: input.containerId,
      SearchCriteria: input.searchCriteria,
      Filter: input.filter ?? "*",
      StartingIndex: startingIndex,
      RequestedCount: requestedCount,
      SortCriteria: input.sortCriteria ?? "",
    });
    return parseContentResult(values);
  }

  public async getPositionInfo(service: UpnpServiceDescription, instanceId = 0): Promise<UpnpPositionInfo> {
    serviceTypeFor(service, "AVTransport");
    validatePageIndex(instanceId, "InstanceID");
    const values = await this.invokeReadOnly(service, "GetPositionInfo", { InstanceID: instanceId });
    const trackDuration = nullable(values.TrackDuration ?? "");
    const relativeTime = nullable(values.RelTime ?? "");
    const absoluteTime = nullable(values.AbsTime ?? "");
    return {
      track: parseInteger(values.Track ?? ""),
      trackDuration,
      trackDurationSeconds: parseUpnpDuration(trackDuration),
      trackMetadata: parseMetadata(values.TrackMetaData),
      trackUri: nullable(values.TrackURI ?? ""),
      relativeTime,
      relativeTimeSeconds: parseUpnpDuration(relativeTime),
      absoluteTime,
      absoluteTimeSeconds: parseUpnpDuration(absoluteTime),
      relativeCount: parseInteger(values.RelCount ?? ""),
      absoluteCount: parseInteger(values.AbsCount ?? ""),
    };
  }

  public async getTransportInfo(service: UpnpServiceDescription, instanceId = 0): Promise<UpnpTransportInfo> {
    serviceTypeFor(service, "AVTransport");
    validatePageIndex(instanceId, "InstanceID");
    const values = await this.invokeReadOnly(service, "GetTransportInfo", { InstanceID: instanceId });
    return {
      currentTransportState: values.CurrentTransportState ?? "",
      currentTransportStatus: values.CurrentTransportStatus ?? "",
      currentSpeed: values.CurrentSpeed ?? "",
    };
  }

  public async getMediaInfo(service: UpnpServiceDescription, instanceId = 0): Promise<UpnpMediaInfo> {
    serviceTypeFor(service, "AVTransport");
    validatePageIndex(instanceId, "InstanceID");
    const values = await this.invokeReadOnly(service, "GetMediaInfo", { InstanceID: instanceId });
    const mediaDuration = nullable(values.MediaDuration ?? "");
    return {
      numberOfTracks: parseInteger(values.NrTracks ?? ""),
      mediaDuration,
      mediaDurationSeconds: parseUpnpDuration(mediaDuration),
      currentUri: nullable(values.CurrentURI ?? ""),
      currentUriMetadata: parseMetadata(values.CurrentURIMetaData),
      nextUri: nullable(values.NextURI ?? ""),
      nextUriMetadata: parseMetadata(values.NextURIMetaData),
      playMedium: nullable(values.PlayMedium ?? ""),
      recordMedium: nullable(values.RecordMedium ?? ""),
      writeStatus: nullable(values.WriteStatus ?? ""),
    };
  }

  public async getVolume(
    service: UpnpServiceDescription,
    instanceId = 0,
    channel = "Master",
  ): Promise<UpnpVolume> {
    serviceTypeFor(service, "RenderingControl");
    validatePageIndex(instanceId, "InstanceID");
    const values = await this.invokeReadOnly(service, "GetVolume", { InstanceID: instanceId, Channel: channel });
    const value = parseNonNegativeInteger(values.CurrentVolume ?? "", "CurrentVolume");
    return { channel, value };
  }

  public async getMute(
    service: UpnpServiceDescription,
    instanceId = 0,
    channel = "Master",
  ): Promise<UpnpMute> {
    serviceTypeFor(service, "RenderingControl");
    validatePageIndex(instanceId, "InstanceID");
    const values = await this.invokeReadOnly(service, "GetMute", { InstanceID: instanceId, Channel: channel });
    const value = parseBoolean(values.CurrentMute);
    if (value === null) throw new Error("Invalid CurrentMute in UPnP response.");
    return { channel, value };
  }

  /**
   * Sends the physically verified RenderingControl setter once, then rereads
   * the device. Callers receive only the confirmed level, never an optimistic
   * or inferred percentage.
   */
  public async setVolume(
    service: UpnpServiceDescription,
    desiredVolume: number,
    instanceId = 0,
    channel = "Master",
  ): Promise<UpnpVolume> {
    serviceTypeFor(service, "RenderingControl");
    validatePageIndex(instanceId, "InstanceID");
    if (!Number.isInteger(desiredVolume) || desiredVolume < 0 || desiredVolume > 100) {
      throw new Error("DesiredVolume must be an integer between 0 and 100.");
    }
    await this.invokeVerifiedMutation(service, "SetVolume", {
      InstanceID: instanceId,
      Channel: channel,
      DesiredVolume: desiredVolume,
    });
    const confirmed = await this.getVolume(service, instanceId, channel);
    if (confirmed.value !== desiredVolume) {
      throw new Error(`The Olive reported volume ${confirmed.value} after setting ${desiredVolume}.`);
    }
    return confirmed;
  }

  /**
   * Sends the physically verified RenderingControl setter once, then rereads
   * the device so mute state is always truthful.
   */
  public async setMute(
    service: UpnpServiceDescription,
    desiredMute: boolean,
    instanceId = 0,
    channel = "Master",
  ): Promise<UpnpMute> {
    serviceTypeFor(service, "RenderingControl");
    validatePageIndex(instanceId, "InstanceID");
    await this.invokeVerifiedMutation(service, "SetMute", {
      InstanceID: instanceId,
      Channel: channel,
      DesiredMute: desiredMute ? 1 : 0,
    });
    const confirmed = await this.getMute(service, instanceId, channel);
    if (confirmed.value !== desiredMute) {
      throw new Error(`The Olive reported mute ${confirmed.value ? "on" : "off"} after setting ${desiredMute ? "on" : "off"}.`);
    }
    return confirmed;
  }

  private async invokeVerifiedMutation(
    service: UpnpServiceDescription,
    action: "SetVolume" | "SetMute",
    arguments_: Readonly<Record<string, string | number | boolean>>,
  ): Promise<void> {
    if (classifyUpnpAction(service.serviceType, action) !== "rendering-mutation") {
      throw new Error(`UPnP action ${action} is quarantined and cannot be invoked.`);
    }
    if (!service.controlUrl) throw new Error("UPnP service has no safe control URL.");
    const response = await this.transport.request({
      method: "POST",
      url: service.controlUrl,
      headers: {
        "content-type": 'text/xml; charset="utf-8"',
        soapaction: `"${service.serviceType}#${action}"`,
      },
      body: buildUpnpSoapRequest(service.serviceType, action, arguments_),
      timeoutMs: 10_000,
    });
    if (response.body.length > 8 * 1024 * 1024) {
      throw new Error(`UPnP ${action} response exceeded the 8 MiB safety limit.`);
    }
    try {
      parseUpnpSoapResponse(response.body, action, response.status);
      this.assertHttpSuccess(response, `UPnP ${action}`);
    } catch (error) {
      if (error instanceof UpnpSoapFault) throw error;
      this.assertHttpSuccess(response, `UPnP ${action}`);
      throw error;
    }
  }

  private async invokeReadOnly(
    service: UpnpServiceDescription,
    action: UpnpReadOnlyAction,
    arguments_: Readonly<Record<string, string | number | boolean>>,
    timeoutMs = 5_000,
  ): Promise<Readonly<Record<string, string>>> {
    if (classifyUpnpAction(service.serviceType, action) !== "read-only") {
      throw new Error(`UPnP action ${action} is quarantined and cannot be invoked.`);
    }
    if (!service.controlUrl) throw new Error("UPnP service has no safe control URL.");
    const response = await this.transport.request({
      method: "POST",
      url: service.controlUrl,
      headers: {
        "content-type": 'text/xml; charset="utf-8"',
        soapaction: `"${service.serviceType}#${action}"`,
      },
      body: buildReadOnlyUpnpSoapRequest(service.serviceType, action, arguments_),
      timeoutMs,
    });
    if (response.body.length > 8 * 1024 * 1024) {
      throw new Error(`UPnP ${action} response exceeded the 8 MiB safety limit.`);
    }
    try {
      const values = parseUpnpSoapResponse(response.body, action, response.status);
      this.assertHttpSuccess(response, `UPnP ${action}`);
      return values;
    } catch (error) {
      if (error instanceof UpnpSoapFault) throw error;
      this.assertHttpSuccess(response, `UPnP ${action}`);
      throw error;
    }
  }

  private assertHttpSuccess(response: TransportResponse, label: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${label} failed (${response.status} ${response.statusText}).`);
    }
  }
}
