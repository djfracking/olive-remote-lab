export type OliveModelId =
  | "symphony"
  | "symphony-2"
  | "musica"
  | "opus"
  | "opus-3"
  | "opus-4"
  | "opus-5"
  | "melody"
  | "melody-2"
  | "olive-2"
  | "olive-4"
  | "o2m"
  | "o3hd"
  | "o4hd"
  | "o5hd"
  | "o6hd"
  | "olive-one"
  | "unknown";

export type CapabilityEvidence = "verified" | "shared-firmware-marker" | "unverified";

export interface OliveModelCapabilities {
  readonly model: OliveModelId;
  readonly displayName: string;
  readonly role: "server" | "player" | "integrated" | "unknown";
  readonly protocolFamily: "early" | "maestro" | "hd" | "one" | "unknown";
  readonly maestroLibrary: CapabilityEvidence;
  readonly frontPanelApi: CapabilityEvidence;
  readonly playbackControl: CapabilityEvidence;
  readonly notes: string;
}

const unverified = (
  model: OliveModelId,
  displayName: string,
  role: OliveModelCapabilities["role"],
  protocolFamily: OliveModelCapabilities["protocolFamily"],
  notes: string,
): OliveModelCapabilities => ({
  model,
  displayName,
  role,
  protocolFamily,
  maestroLibrary: "unverified",
  frontPanelApi: "unverified",
  playbackControl: "unverified",
  notes,
});

/**
 * Full-family registry. A model's presence is not a compatibility claim: only
 * capabilities carrying verified evidence may be enabled automatically.
 */
export const OLIVE_MODEL_CAPABILITIES: readonly OliveModelCapabilities[] = [
  unverified("symphony", "Symphony", "server", "early", "First-generation music server; firmware evidence required."),
  unverified("symphony-2", "Symphony No.2", "player", "maestro", "Network player generation; firmware evidence required."),
  unverified("musica", "Musica", "server", "early", "First-generation music server; firmware evidence required."),
  unverified("opus", "OPUS", "server", "early", "First OPUS generation; firmware evidence required."),
  unverified("opus-3", "OPUS No.3", "server", "early", "OPUS generation; exact marketed variants remain to be confirmed."),
  unverified("opus-4", "OPUS No.4", "server", "maestro", "Maestro-era server; firmware evidence required."),
  unverified("opus-5", "OPUS No.5", "server", "maestro", "Audiophile OPUS generation; firmware evidence required."),
  unverified("melody", "MELODY", "player", "early", "Early network player; firmware evidence required."),
  unverified("melody-2", "MELODY No.2", "player", "maestro", "Network player; server-library behavior may differ."),
  unverified("olive-2", "Olive 2", "player", "hd", "Hi-Fi network player; firmware evidence required."),
  unverified("olive-4", "Olive 4", "server", "hd", "Non-HD server variant; firmware evidence required."),
  unverified("o2m", "O2M", "player", "hd", "Multi-room player; evidence required."),
  unverified("o3hd", "O3HD", "server", "hd", "Referenced by the observed shared front-panel source."),
  {
    model: "o4hd",
    displayName: "O4HD",
    role: "server",
    protocolFamily: "hd",
    maestroLibrary: "verified",
    frontPanelApi: "verified",
    playbackControl: "shared-firmware-marker",
    notes: "Verified against a real device on ports 80 and 8163.",
  },
  unverified("o5hd", "O5HD", "integrated", "hd", "Later-generation integrated system; evidence required."),
  unverified("o6hd", "O6HD", "server", "hd", "Referenced by the observed shared front-panel source."),
  unverified("olive-one", "Olive ONE", "integrated", "one", "Different platform; do not assume Maestro compatibility."),
  unverified("unknown", "Unknown Olive model", "unknown", "unknown", "Use discovery and read-only capability probes."),
] as const;

export function capabilitiesForModel(model: OliveModelId): OliveModelCapabilities {
  return OLIVE_MODEL_CAPABILITIES.find((entry) => entry.model === model)
    ?? OLIVE_MODEL_CAPABILITIES[OLIVE_MODEL_CAPABILITIES.length - 1]!;
}

export function detectOliveModel(markup: string): OliveModelId {
  const source = markup.toLowerCase();
  if (/opus4hd_code|olive\s*o?4hd/.test(source)) return "o4hd";
  if (/o6hd|06hd|opus6hd/.test(source)) return "o6hd";
  if (/o3hd|03hd|opus3hd/.test(source)) return "o3hd";
  if (/olive\s+one/.test(source)) return "olive-one";
  if (/olive\s*2(?:\s+hi-?fi)?/.test(source)) return "olive-2";
  if (/olive\s*4(?:\s+hi-?fi)?/.test(source)) return "olive-4";
  if (/symphony\s*(?:no\.?\s*)?2/.test(source)) return "symphony-2";
  if (/melody\s*(?:no\.?\s*)?2/.test(source)) return "melody-2";
  if (/melody/.test(source)) return "melody";
  if (/opus\s*(?:no\.?\s*)?5/.test(source)) return "opus-5";
  if (/opus\s*(?:no\.?\s*)?4/.test(source)) return "opus-4";
  if (/opus\s*(?:no\.?\s*)?3/.test(source)) return "opus-3";
  if (/opus/.test(source)) return "opus";
  if (/symphony/.test(source)) return "symphony";
  if (/musica/.test(source)) return "musica";
  return "unknown";
}
