import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildDiagnosticEmail, buildSupportEmail, DIAGNOSTIC_CONSENT_VERSION, DIAGNOSTIC_SOURCE_CODES, MAX_SUPPORT_PAYLOAD_BYTES, resolveRateLimitAddress, sanitizeDiagnosticRequest, sanitizeSupportRequest, supportPayloadBytes, SupportInputError } from "../support.js";

const now = 2_000_000;

test("sanitizes a valid support request", () => {
  const input = sanitizeSupportRequest({ startedAt: now - 2_000, consent: "on", email: " Customer@Example.com ", topic: "connection", model: " O4HD\r\nInjected ", message: " The app cannot find my server. " }, now);
  assert.equal(input.email, "customer@example.com");
  assert.equal(input.topicLabel, "Connection");
  assert.equal(input.model, "O4HD Injected");
});

test("rejects invalid email and very short messages", () => {
  assert.throws(() => sanitizeSupportRequest({ startedAt: now - 2_000, consent: "on", email: "invalid", message: "This message is long enough." }, now), SupportInputError);
  assert.throws(() => sanitizeSupportRequest({ startedAt: now - 2_000, consent: "on", email: "a@example.com", message: "Too short" }, now), SupportInputError);
  assert.throws(() => sanitizeSupportRequest({ startedAt: now - 2_000, email: "a@example.com", message: "This message is long enough." }, now), SupportInputError);
});

test("builds mail without a configured recipient", () => {
  const input = sanitizeSupportRequest({ startedAt: now - 2_000, consent: "on", email: "a@example.com", topic: "playback", message: "Playback stops after one song." }, now);
  const mail = buildSupportEmail(input, "request-1");
  assert.match(mail.subject, /Olive Remote.*Playback/);
  assert.match(mail.text, /a@example.com/);
  assert.doesNotMatch(mail.text, /OLIVE_SUPPORT_MAILBOX/);
});

test("uses the load-balancer observed client address instead of a caller-supplied X-Forwarded-For prefix", () => {
  assert.equal(resolveRateLimitAddress("forged, 203.0.113.9, 35.1.2.3", "127.0.0.1"), "203.0.113.9");
  assert.equal(resolveRateLimitAddress("forged-only", "127.0.0.1"), "127.0.0.1");
  assert.equal(resolveRateLimitAddress("", ""), "unknown");
});

test("allows the documented diagnostic character limits within the UTF-8 payload cap", () => {
  const payload = {
    email: `${"ü".repeat(20)}@example.com`,
    firmware: "界".repeat(80),
    details: "界".repeat(4_000),
  };
  assert.ok(supportPayloadBytes(payload) < MAX_SUPPORT_PAYLOAD_BYTES);
  assert.ok(supportPayloadBytes({ details: "😀".repeat(4_000) }) < MAX_SUPPORT_PAYLOAD_BYTES);
});

test("sanitizes a valid owner diagnostic with consent and source attribution", () => {
  const input = sanitizeDiagnosticRequest({
    requestType: "diagnostic",
    startedAt: now - 2_000,
    website: "",
    email: " Owner@Example.com ",
    model: "o4hd",
    firmware: " 4.3.2\r\nInjected ",
    bootState: "waking-up",
    networkVisibility: "not-checked",
    issue: "startup",
    country: "GB",
    details: " The display has remained on Waking Up for twenty minutes. ",
    consent: "on",
    releaseConsent: "on",
    source: "whathifi-waking",
    referrer: "https://example.com/private-profile",
    utm_campaign: "not-retained",
  }, now);

  assert.equal(input.email, "owner@example.com");
  assert.equal(input.modelLabel, "Olive O4HD / 4HD");
  assert.equal(input.firmware, "4.3.2 Injected");
  assert.equal(input.bootStateLabel, "Stuck on Waking Up");
  assert.equal(input.countryLabel, "United Kingdom");
  assert.equal(input.source, "whathifi-waking");
  assert.equal(input.releaseConsent, true);
  assert.equal(input.consentVersion, DIAGNOSTIC_CONSENT_VERSION);
  assert.equal(Object.hasOwn(input, "referrer"), false);
  assert.equal(Object.hasOwn(input, "utm_campaign"), false);
});

test("defaults unknown attribution to direct without retaining arbitrary values", () => {
  const input = sanitizeDiagnosticRequest({
    startedAt: now - 2_000,
    consent: true,
    email: "owner@example.com",
    model: "unknown",
    bootState: "unknown",
    networkVisibility: "not-checked",
    issue: "other",
    country: "OTHER",
    details: "I am not sure which Olive model this is yet.",
    source: "some-profile-name",
  }, now);

  assert.equal(input.source, "direct");
  assert.equal(input.sourceLabel, "Direct / not tagged");
  assert.equal(input.releaseConsent, false);
});

test("rejects diagnostic requests with invalid enums, short details, or missing reply consent", () => {
  const valid = {
    startedAt: now - 2_000,
    consent: "on",
    email: "owner@example.com",
    model: "o4hd",
    bootState: "normal",
    networkVisibility: "visible",
    issue: "remote-app",
    country: "US",
    details: "The original remote application is no longer available.",
  };

  assert.throws(() => sanitizeDiagnosticRequest({ ...valid, model: "olive-tree" }, now), SupportInputError);
  assert.throws(() => sanitizeDiagnosticRequest({ ...valid, issue: "anything" }, now), SupportInputError);
  assert.throws(() => sanitizeDiagnosticRequest({ ...valid, details: "Too short" }, now), SupportInputError);
  assert.throws(() => sanitizeDiagnosticRequest({ ...valid, consent: false }, now), SupportInputError);
});

test("builds a structured diagnostic email with independent consent fields", () => {
  const input = sanitizeDiagnosticRequest({
    startedAt: now - 2_000,
    consent: "on",
    email: "owner@example.com",
    model: "o4hd",
    firmware: "4.3.2",
    bootState: "normal",
    networkVisibility: "visible",
    issue: "remote-app",
    country: "US",
    details: "The Olive starts normally but the original app is unavailable.",
    source: "site-remote-app",
  }, now);
  const mail = buildDiagnosticEmail(input, "diagnostic-1");

  assert.match(mail.subject, /Olive Remote diagnostic.*O4HD.*remote app/i);
  assert.match(mail.text, /Request ID: diagnostic-1/);
  assert.match(mail.text, /Reply consent: Yes/);
  assert.match(mail.text, /One-time release email consent: No/);
  assert.match(mail.text, /Remote app replacement guide \(site-remote-app\)/);
  assert.match(mail.text, new RegExp(DIAGNOSTIC_CONSENT_VERSION));
});

test("keeps browser and backend diagnostic source allowlists synchronized", async () => {
  const browserScript = await readFile(new URL("../../public-site/attribution.js", import.meta.url), "utf8");
  const allowedSourcesBlock = browserScript.match(/const allowedSources = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(allowedSourcesBlock, "browser source allowlist was not found");
  const browserSources = [...allowedSourcesBlock[1].matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(browserSources, [...DIAGNOSTIC_SOURCE_CODES].sort());
});
