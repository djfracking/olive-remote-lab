import crypto from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import nodemailer from "nodemailer";
import { buildDiagnosticEmail, buildSupportEmail, MAX_SUPPORT_PAYLOAD_BYTES, resolveRateLimitAddress, sanitizeDiagnosticRequest, sanitizeSupportRequest, supportPayloadBytes, SupportInputError } from "./support.js";

const smtpPassword = defineSecret("OLIVE_SUPPORT_SMTP_PASSWORD");
const supportMailbox = defineSecret("OLIVE_SUPPORT_MAILBOX");
const isFunctionsEmulator = process.env.FUNCTIONS_EMULATOR === "true";
const allowedOrigins = new Set([
  "https://olive-remote-lab.web.app",
  "https://olive-remote-lab.firebaseapp.com",
]);
const emulatorOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
]);
const clientRequestWindows = new Map();
const globalRequestWindows = new Map();
const rateLimitWindowMs = 60 * 60 * 1_000;
const rateLimitMaximum = 5;
const globalRateLimitMaximum = 30;

function requestAddress(request) {
  return resolveRateLimitAddress(request.headers["x-forwarded-for"], request.ip);
}

function purgeExpiredRateLimits(windows, now) {
  for (const [storedKey, window] of windows) {
    if (now - window.startedAt >= rateLimitWindowMs) windows.delete(storedKey);
  }
}

function rateLimitAvailable(windows, key, maximum) {
  return !windows.has(key) || windows.get(key).count < maximum;
}

function recordRateLimit(windows, key, now) {
  const current = windows.get(key);
  const next = current ? { ...current, count: current.count + 1 } : { startedAt: now, count: 1 };
  windows.set(key, next);
  if (windows.size > 5_000) {
    while (windows.size > 5_000) windows.delete(windows.keys().next().value);
  }
}

function withinRateLimit(request, now = Date.now()) {
  const addressHash = crypto.createHash("sha256").update(requestAddress(request)).digest("hex");
  purgeExpiredRateLimits(clientRequestWindows, now);
  purgeExpiredRateLimits(globalRequestWindows, now);
  if (!rateLimitAvailable(clientRequestWindows, addressHash, rateLimitMaximum)) return false;
  if (!rateLimitAvailable(globalRequestWindows, "global", globalRateLimitMaximum)) return false;
  recordRateLimit(clientRequestWindows, addressHash, now);
  recordRateLimit(globalRequestWindows, "global", now);
  return true;
}

export const submitOliveSupport = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 2,
    concurrency: 20,
    secrets: isFunctionsEmulator ? [] : [smtpPassword, supportMailbox],
  },
  async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      response.status(405).json({ error: "Method not allowed." });
      return;
    }
    const origin = request.get("origin");
    const emulatorOriginAllowed = isFunctionsEmulator && emulatorOrigins.has(origin);
    if (!allowedOrigins.has(origin) && !emulatorOriginAllowed) {
      response.status(403).json({ error: "Support requests must be sent from the Olive Remote support page." });
      return;
    }
    if (!request.is("application/json")) {
      response.status(415).json({ error: "Send the support request as JSON." });
      return;
    }
    if (supportPayloadBytes(request.body) > MAX_SUPPORT_PAYLOAD_BYTES) {
      response.status(413).json({ error: "The support request is too large." });
      return;
    }
    if (!withinRateLimit(request)) {
      response.status(429).json({ error: "Too many support requests. Please try again later." });
      return;
    }

    try {
      const isDiagnostic = request.body?.requestType === "diagnostic";
      const input = isDiagnostic ? sanitizeDiagnosticRequest(request.body) : sanitizeSupportRequest(request.body);
      if (input.honeypot) {
        response.status(200).json({ ok: true });
        return;
      }
      const requestId = crypto.randomUUID();
      const mail = isDiagnostic ? buildDiagnosticEmail(input, requestId) : buildSupportEmail(input, requestId);
      if (isFunctionsEmulator) {
        console.info("Olive support emulator accepted a dry-run request.", { requestId, requestType: isDiagnostic ? "diagnostic" : "support" });
        response.status(200).json({ ok: true, requestId, dryRun: true });
        return;
      }
      const mailbox = supportMailbox.value();
      const password = smtpPassword.value();
      if (!mailbox || !password) throw new Error("Support mail is not configured.");
      const transport = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: mailbox, pass: password },
      });
      await transport.sendMail({
        from: { name: "Olive Remote Support", address: mailbox },
        to: mailbox,
        replyTo: input.email,
        subject: mail.subject,
        text: mail.text,
      });
      response.status(200).json({ ok: true, requestId });
    } catch (error) {
      if (error instanceof SupportInputError) {
        response.status(400).json({ error: error.message });
        return;
      }
      console.error("Olive support delivery failed.", error instanceof Error ? error.message : "Unknown error");
      response.status(503).json({ error: "Support request could not be sent. Please try again later." });
    }
  },
);
