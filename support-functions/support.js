const topicLabels = {
  connection: "Connection",
  playback: "Playback",
  library: "Library or search",
  compatibility: "Device compatibility",
  other: "Other",
};

const diagnosticModelLabels = {
  o4hd: "Olive O4HD / 4HD",
  o3hd: "Olive O3HD / 3HD",
  o5hd: "Olive O5HD / 5HD",
  o6hd: "Olive O6HD / 6HD",
  olive4: "Olive 4",
  olive2: "Olive 2",
  o2m: "Olive O2M",
  opus4: "Olive OPUS No. 4",
  opus: "Olive OPUS / OPUS No. 3 / No. 5",
  musica: "Olive Musica",
  symphony: "Olive Symphony",
  melody: "Olive Melody",
  one: "Olive ONE",
  other: "Another Olive model",
  unknown: "Model not known",
};

const bootStateLabels = {
  normal: "Starts normally",
  "waking-up": "Stuck on Waking Up",
  "starting-up": "Stuck on System Starting Up",
  "screen-problem": "Screen is blank, white, or frozen",
  "will-not-boot": "Will not start",
  unknown: "Not sure",
};

const networkVisibilityLabels = {
  visible: "Visible on the local network",
  "not-visible": "Not visible on the local network",
  "not-checked": "Not checked / not sure",
};

const diagnosticIssueLabels = {
  "remote-app": "Original remote app missing or unusable",
  startup: "Startup, freeze, or wake problem",
  "drive-recovery": "Hard-drive / SSD failure or recovery",
  "library-export": "Library backup, export, or migration",
  firmware: "Firmware or recovery image",
  network: "Wi-Fi, Ethernet, SMB, NAS, DLNA, or discovery",
  display: "Display or touchscreen",
  "cd-metadata": "CD drive, ripping, metadata, or artwork",
  "internet-radio": "Internet radio or discontinued online service",
  other: "Something else",
};

const countryLabels = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  PL: "Poland",
  DK: "Denmark",
  TW: "Taiwan",
  ES: "Spain",
  IT: "Italy",
  GR: "Greece",
  BE: "Belgium",
  CH: "Switzerland",
  AT: "Austria",
  SE: "Sweden",
  NO: "Norway",
  HK: "Hong Kong",
  OTHER: "Other / not listed",
};

const sourceLabels = {
  direct: "Direct / not tagged",
  "site-home": "Olive Remote homepage",
  "site-o4hd": "O4HD rescue page",
  "site-remote-app": "Remote app replacement guide",
  "site-waking-up": "Waking Up guide",
  "site-library-recovery": "Library recovery guide",
  "diyaudio-one": "diyAudio Olive ONE thread",
  "stereonet-olive4": "StereoNET Olive 4 thread",
  "avs-official": "AVSForum official Olive thread",
  "martinlogan-firmware": "MartinLogan Owners firmware thread",
  "whathifi-waking": "What Hi-Fi O4HD Waking Up thread",
  "reddit-o4hd-ssd": "Reddit O4HD SSD thread",
  "reddit-one-update": "Reddit Olive ONE update thread",
  "forumhifi-opus4": "Forum-HiFi Opus 4 thread",
  "ls35a-o3hd": "LS3/5a O3HD thread",
  "audiostereo-o4hd": "AudioStereo O4HD thread",
  "youtube-o4hd": "YouTube O4HD content",
  "youtube-one": "YouTube Olive ONE content",
};

export const DIAGNOSTIC_CONSENT_VERSION = "2026-07-18";
export const DIAGNOSTIC_SOURCE_CODES = Object.freeze(Object.keys(sourceLabels));
export const MAX_SUPPORT_PAYLOAD_BYTES = 24 * 1024;

export class SupportInputError extends Error {}

export function supportPayloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function cleanSingleLine(value, maxLength) {
  return cleanText(value, maxLength).replace(/\s+/g, " ");
}

export function resolveRateLimitAddress(forwardedFor, fallbackAddress = "unknown") {
  const forwardedAddresses = String(forwardedFor ?? "")
    .split(",")
    .map((address) => cleanSingleLine(address, 80))
    .filter(Boolean);
  // Google external HTTP load balancers append the observed client address and
  // then the load-balancer address. Values before that trusted suffix can be
  // supplied by the caller and must not be used as a rate-limit key.
  if (forwardedAddresses.length >= 2) return forwardedAddresses.at(-2);
  return cleanSingleLine(fallbackAddress, 80) || "unknown";
}

function validateStartedAt(value, now) {
  const startedAt = Number(value);
  if (!Number.isFinite(startedAt) || now - startedAt < 1_500 || now - startedAt > 6 * 60 * 60 * 1_000) {
    throw new SupportInputError("Reload the support page and try again.");
  }
}

function requireConsent(value) {
  if (value !== "on" && value !== true) throw new SupportInputError("Confirm that we may use your details to answer this request.");
}

function cleanEmail(value) {
  const email = cleanSingleLine(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SupportInputError("Enter a valid reply email address.");
  return email;
}

function requiredEnum(labels, value, message) {
  const key = cleanSingleLine(value, 80);
  if (!Object.hasOwn(labels, key)) throw new SupportInputError(message);
  return { key, label: labels[key] };
}

export function sanitizeSupportRequest(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SupportInputError("Enter your support details and try again.");
  validateStartedAt(value.startedAt, now);

  requireConsent(value.consent);
  const email = cleanEmail(value.email);
  const message = cleanText(value.message, 4_000);
  if (message.length < 20) throw new SupportInputError("Describe the problem in at least 20 characters.");
  const topic = Object.hasOwn(topicLabels, value.topic) ? value.topic : "other";

  return {
    name: cleanSingleLine(value.name, 100),
    email,
    topic,
    topicLabel: topicLabels[topic],
    model: cleanSingleLine(value.model, 100),
    message,
    honeypot: cleanSingleLine(value.website, 200),
  };
}

export function sanitizeDiagnosticRequest(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SupportInputError("Enter your Olive details and try again.");
  validateStartedAt(value.startedAt, now);
  requireConsent(value.consent);

  const email = cleanEmail(value.email);
  const model = requiredEnum(diagnosticModelLabels, value.model, "Choose the Olive model, or select that you are not sure.");
  const bootState = requiredEnum(bootStateLabels, value.bootState, "Choose what happens when the Olive starts.");
  const networkVisibility = requiredEnum(networkVisibilityLabels, value.networkVisibility, "Choose whether the Olive is visible on your local network.");
  const issue = requiredEnum(diagnosticIssueLabels, value.issue, "Choose the main problem you want help with.");
  const country = requiredEnum(countryLabels, value.country, "Choose your country, or select Other / not listed.");
  const details = cleanText(value.details, 4_000);
  if (details.length < 20) throw new SupportInputError("Describe the problem in at least 20 characters.");
  const requestedSource = cleanSingleLine(value.source, 80).toLowerCase();
  const source = Object.hasOwn(sourceLabels, requestedSource) ? requestedSource : "direct";

  return {
    requestType: "diagnostic",
    email,
    model: model.key,
    modelLabel: model.label,
    firmware: cleanSingleLine(value.firmware, 80),
    bootState: bootState.key,
    bootStateLabel: bootState.label,
    networkVisibility: networkVisibility.key,
    networkVisibilityLabel: networkVisibility.label,
    issue: issue.key,
    issueLabel: issue.label,
    country: country.key,
    countryLabel: country.label,
    details,
    releaseConsent: value.releaseConsent === "on" || value.releaseConsent === true,
    replyConsent: true,
    consentVersion: DIAGNOSTIC_CONSENT_VERSION,
    receivedAt: new Date(now).toISOString(),
    source,
    sourceLabel: sourceLabels[source],
    honeypot: cleanSingleLine(value.website, 200),
  };
}

export function buildSupportEmail(input, requestId) {
  const subject = `[Olive Remote] ${input.topicLabel}${input.model ? ` · ${input.model}` : ""}`.slice(0, 180);
  const text = [
    `Request ID: ${requestId}`,
    `Topic: ${input.topicLabel}`,
    `Olive model: ${input.model || "Not supplied"}`,
    `Customer name: ${input.name || "Not supplied"}`,
    `Reply address: ${input.email}`,
    "",
    "Message:",
    input.message,
  ].join("\n");
  return { subject, text };
}

export function buildDiagnosticEmail(input, requestId) {
  const subject = `[Olive Remote diagnostic] ${input.modelLabel} · ${input.issueLabel} · ${input.sourceLabel}`.slice(0, 180);
  const text = [
    `Request ID: ${requestId}`,
    `Received: ${input.receivedAt}`,
    `Request type: Owner diagnostic`,
    `Olive model: ${input.modelLabel}`,
    `Firmware: ${input.firmware || "Not supplied"}`,
    `Boot state: ${input.bootStateLabel}`,
    `Network visibility: ${input.networkVisibilityLabel}`,
    `Main issue: ${input.issueLabel}`,
    `Country: ${input.countryLabel}`,
    `Reply address: ${input.email}`,
    `Source: ${input.sourceLabel} (${input.source})`,
    `Reply consent: Yes`,
    `One-time release email consent: ${input.releaseConsent ? "Yes" : "No"}`,
    `Consent notice version: ${input.consentVersion}`,
    "",
    "Owner description:",
    input.details,
  ].join("\n");
  return { subject, text };
}
