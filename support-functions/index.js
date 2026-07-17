import crypto from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import nodemailer from "nodemailer";
import { buildSupportEmail, sanitizeSupportRequest, SupportInputError } from "./support.js";

const smtpPassword = defineSecret("OLIVE_SUPPORT_SMTP_PASSWORD");
const supportMailbox = defineSecret("OLIVE_SUPPORT_MAILBOX");
const allowedOrigins = new Set([
  "https://olive-remote-lab.web.app",
  "https://olive-remote-lab.firebaseapp.com",
]);
const requestWindows = new Map();
const rateLimitWindowMs = 60 * 60 * 1_000;
const rateLimitMaximum = 5;

function requestAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.ip || "unknown").split(",")[0].trim().slice(0, 80);
}

function withinRateLimit(request, now = Date.now()) {
  const key = requestAddress(request);
  const current = requestWindows.get(key);
  const next = !current || now - current.startedAt >= rateLimitWindowMs ? { startedAt: now, count: 1 } : { ...current, count: current.count + 1 };
  requestWindows.set(key, next);
  if (requestWindows.size > 5_000) {
    for (const [address, window] of requestWindows) if (now - window.startedAt >= rateLimitWindowMs) requestWindows.delete(address);
  }
  return next.count <= rateLimitMaximum;
}

export const submitOliveSupport = onRequest(
  {
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    maxInstances: 2,
    concurrency: 20,
    secrets: [smtpPassword, supportMailbox],
  },
  async (request, response) => {
    response.set("Cache-Control", "no-store");
    response.set("X-Content-Type-Options", "nosniff");
    const origin = request.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json({ error: "Support requests must be sent from the Olive Remote support page." });
      return;
    }
    if (request.method !== "POST") {
      response.set("Allow", "POST");
      response.status(405).json({ error: "Method not allowed." });
      return;
    }
    if (!withinRateLimit(request)) {
      response.status(429).json({ error: "Too many support requests. Please try again later." });
      return;
    }

    try {
      const input = sanitizeSupportRequest(request.body);
      if (input.honeypot) {
        response.status(200).json({ ok: true });
        return;
      }
      const mailbox = supportMailbox.value();
      const password = smtpPassword.value();
      if (!mailbox || !password) throw new Error("Support mail is not configured.");
      const requestId = crypto.randomUUID();
      const mail = buildSupportEmail(input, requestId);
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
