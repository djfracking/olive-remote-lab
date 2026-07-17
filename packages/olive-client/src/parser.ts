import type { ParsedBody } from "./types.js";

function indentMarkup(input: string): string {
  const normalized = input.replace(/>\s*</g, "><").trim();
  let depth = 0;
  return normalized
    .replace(/(<[^>]+>)/g, "$1\n")
    .split("\n")
    .filter(Boolean)
    .map((token) => {
      if (/^<\//.test(token)) depth = Math.max(0, depth - 1);
      const line = `${"  ".repeat(depth)}${token}`;
      if (/^<[^!?/][^>]*[^/]?>$/.test(token) && !/<\/[^>]+>$/.test(token)) depth += 1;
      return line;
    })
    .join("\n");
}

export function parseResponseBody(body: string, contentType = ""): ParsedBody {
  const trimmed = body.trim();
  const lowerType = contentType.toLowerCase();

  if (lowerType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", formatted: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch {
      // Invalid JSON is safer to display as text.
    }
  }
  if (lowerType.includes("html") || /<!doctype html|<html[\s>]/i.test(trimmed)) {
    return { kind: "html", formatted: indentMarkup(body) };
  }
  if (lowerType.includes("xml") || /^<\?xml|^<[\w:-]+[\s>]/i.test(trimmed)) {
    return { kind: "xml", formatted: indentMarkup(body) };
  }
  return { kind: "text", formatted: body };
}
