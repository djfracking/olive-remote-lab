export interface UpnpXmlElement {
  readonly name: string;
  readonly localName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly (UpnpXmlElement | string)[];
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, token: string) => {
    const normalized = token.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const radix = normalized.startsWith("#x") ? 16 : 10;
    const digits = normalized.slice(radix === 16 ? 2 : 1);
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    attributes[name] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

interface MutableXmlElement {
  name: string;
  localName: string;
  attributes: Record<string, string>;
  children: Array<MutableXmlElement | string>;
}

const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_XML_TOKENS = 200_000;
const MAX_XML_ELEMENTS = 100_000;
const MAX_XML_DEPTH = 64;

/**
 * A deliberately small, non-validating XML reader for trusted-size UPnP
 * descriptors and responses. DTDs are rejected so device input cannot request
 * external entities or entity expansion.
 */
export function parseUpnpXml(source: string): UpnpXmlElement {
  if (source.length > MAX_XML_BYTES || new TextEncoder().encode(source).byteLength > MAX_XML_BYTES) {
    throw new Error("UPnP XML exceeded the 8 MiB safety limit.");
  }
  if (/<!DOCTYPE/i.test(source)) throw new Error("UPnP XML containing a DTD is not accepted.");
  const documentNode: MutableXmlElement = {
    name: "#document",
    localName: "#document",
    attributes: {},
    children: [],
  };
  const stack: MutableXmlElement[] = [documentNode];
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g) ?? [];
  if (tokens.length > MAX_XML_TOKENS) throw new Error("UPnP XML contained too many nodes.");
  let elementCount = 0;

  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    const current = stack[stack.length - 1];
    if (!current) throw new Error("Malformed UPnP XML.");
    if (token.startsWith("<![CDATA[")) {
      current.children.push(token.slice(9, -3));
      continue;
    }
    if (token.startsWith("</")) {
      const closingName = token.slice(2, -1).trim();
      const open = stack[stack.length - 1];
      if (!open || open.name !== closingName) throw new Error(`Malformed UPnP XML near </${closingName}>.`);
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    if (token.startsWith("<")) {
      elementCount += 1;
      if (elementCount > MAX_XML_ELEMENTS) throw new Error("UPnP XML contained too many elements.");
      const match = token.match(/^<\s*([^\s/>]+)([\s\S]*?)(\/?)>$/);
      if (!match?.[1]) throw new Error("Malformed UPnP XML element.");
      const name = match[1];
      const element: MutableXmlElement = {
        name,
        localName: name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name,
        attributes: parseAttributes(match[2] ?? ""),
        children: [],
      };
      current.children.push(element);
      if (match[3] !== "/") {
        if (stack.length > MAX_XML_DEPTH) throw new Error("UPnP XML nesting exceeded the safety limit.");
        stack.push(element);
      }
      continue;
    }
    current.children.push(decodeXmlEntities(token));
  }

  if (stack.length !== 1) throw new Error("Malformed UPnP XML: an element was not closed.");
  const roots = documentNode.children.filter((child): child is MutableXmlElement => typeof child !== "string");
  if (roots.length !== 1 || !roots[0]) throw new Error("UPnP XML must have exactly one root element.");
  return roots[0];
}

export function upnpXmlChildren(element: UpnpXmlElement, localName?: string): UpnpXmlElement[] {
  const children = element.children.filter((child): child is UpnpXmlElement => typeof child !== "string");
  if (!localName) return children;
  return children.filter((child) => child.localName.toLowerCase() === localName.toLowerCase());
}

export function upnpXmlChild(element: UpnpXmlElement, localName: string): UpnpXmlElement | undefined {
  return upnpXmlChildren(element, localName)[0];
}

export function upnpXmlDescendants(element: UpnpXmlElement, localName: string): UpnpXmlElement[] {
  const matches: UpnpXmlElement[] = [];
  for (const child of upnpXmlChildren(element)) {
    if (child.localName.toLowerCase() === localName.toLowerCase()) matches.push(child);
    matches.push(...upnpXmlDescendants(child, localName));
  }
  return matches;
}

export function upnpXmlText(element: UpnpXmlElement | undefined): string {
  if (!element) return "";
  return element.children.map((child) => typeof child === "string" ? child : upnpXmlText(child)).join("").trim();
}

export function upnpXmlChildText(element: UpnpXmlElement, localName: string): string {
  return upnpXmlText(upnpXmlChild(element, localName));
}

export function upnpXmlAttribute(element: UpnpXmlElement, localName: string): string | undefined {
  const direct = element.attributes[localName];
  if (direct !== undefined) return direct;
  const key = Object.keys(element.attributes).find((candidate) => {
    const candidateLocalName = candidate.includes(":") ? candidate.slice(candidate.lastIndexOf(":") + 1) : candidate;
    return candidateLocalName.toLowerCase() === localName.toLowerCase();
  });
  return key === undefined ? undefined : element.attributes[key];
}

export function escapeUpnpXml(value: string | number | boolean): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
