const topicLabels = {
  connection: "Connection",
  playback: "Playback",
  library: "Library or search",
  compatibility: "Device compatibility",
  other: "Other",
};

export class SupportInputError extends Error {}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function cleanSingleLine(value, maxLength) {
  return cleanText(value, maxLength).replace(/\s+/g, " ");
}

export function sanitizeSupportRequest(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SupportInputError("Enter your support details and try again.");
  const startedAt = Number(value.startedAt);
  if (!Number.isFinite(startedAt) || now - startedAt < 1_500 || now - startedAt > 6 * 60 * 60 * 1_000) {
    throw new SupportInputError("Reload the support page and try again.");
  }

  if (value.consent !== "on" && value.consent !== true) throw new SupportInputError("Confirm that we may use your details to answer this request.");
  const email = cleanSingleLine(value.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new SupportInputError("Enter a valid reply email address.");
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
