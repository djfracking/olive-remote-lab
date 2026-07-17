import assert from "node:assert/strict";
import test from "node:test";
import { buildSupportEmail, sanitizeSupportRequest, SupportInputError } from "../support.js";

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
