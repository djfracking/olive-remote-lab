export interface ProtocolLogEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  error?: string;
  request?: unknown;
  responsePreview?: string;
}

const entries: ProtocolLogEntry[] = [];

export function addLog(entry: Omit<ProtocolLogEntry, "id" | "timestamp">): void {
  entries.unshift({ ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString() });
  if (entries.length > 500) entries.length = 500;
}

export function getLogs(): ProtocolLogEntry[] {
  return entries;
}

const sensitiveKey = /name|artist|album|title|email|user|owner|library|playlist/i;

export function redactForExport(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactForExport(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactForExport(child, childKey)]));
  }
  if (typeof value === "string") {
    return value
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
      .replace(/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b169\.254\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b/g, "[REDACTED_IP]")
      .replace(/([?&](?:name|artist|album|title|user|owner|library|playlist)=)[^&]*/gi, "$1[REDACTED]")
      .replace(/("(?:name|artist|album|title|user|owner|library|playlist)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
      .replace(/(<(name|artist|album|title|user|owner|library|playlist)(?:\s[^>]*)?>)[\s\S]*?(<\/\2>)/gi, "$1[REDACTED]$3");
  }
  return value;
}
