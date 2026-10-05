/**
 * The failure classifier behind the chat error frame.
 *
 * Every run failure used to reach the app as "Request failed. Please retry.",
 * so a rate limit and a dead model looked identical and the only detail lived
 * in the server log. These assert the two things the UI actually acts on: a
 * cause it can distinguish, and whether repeating the send is worth offering.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyRunFailure } from "./runner.js";

function withStatus(status: number, message = "boom"): Error {
  return Object.assign(new Error(message), { status });
}

test("classifier — a rate limit is retryable and says to wait", () => {
  const byStatus = classifyRunFailure(withStatus(429));
  assert.equal(byStatus.code, "rate_limited");
  assert.equal(byStatus.retryable, true);

  // Providers that surface it as prose rather than a status must land here too.
  const byText = classifyRunFailure(new Error("Rate limit reached for model"));
  assert.equal(byText.code, "rate_limited");
});

test("classifier — config failures are not offered as retryable", () => {
  // Retrying these fails identically every time; saying so beats a button
  // that cannot work.
  for (const err of [
    withStatus(401),
    withStatus(403),
    withStatus(404, "model_not_found: the model does not exist"),
  ]) {
    const result = classifyRunFailure(err);
    assert.equal(result.retryable, false, result.code);
  }

  assert.equal(classifyRunFailure(withStatus(404)).code, "model_unavailable");
  assert.equal(classifyRunFailure(withStatus(401)).code, "auth");
});

test("classifier — an exhausted context window sends the user to a new chat", () => {
  const result = classifyRunFailure(
    new Error("This model's maximum context length is 200000 tokens"),
  );
  assert.equal(result.code, "context_length");
  assert.equal(result.retryable, false);
  assert.match(result.message, /new chat/i);
});

test("classifier — transport and 5xx faults are worth retrying", () => {
  for (const err of [
    withStatus(503, "upstream unavailable"),
    withStatus(500),
    new Error("socket hang up"),
    new Error("fetch failed"),
    new Error("Request timed out"),
  ]) {
    assert.equal(classifyRunFailure(err).retryable, true, String(err));
  }
  assert.equal(classifyRunFailure(new Error("Request timed out")).code, "timeout");
});

test("classifier — an unrecognised failure still gets a usable answer", () => {
  const result = classifyRunFailure(new Error("something odd"));
  assert.equal(result.code, "internal");
  assert.equal(result.retryable, true);
  assert.ok(result.message.length > 0);
});

test("classifier — messages stay free of internals", () => {
  // These reach the user verbatim, so a leaked model id, status code or stack
  // would be a product rule violation, not just noise.
  const leaky = Object.assign(
    new Error("gpt-5.6-luna failed: 500 at /v1/responses\n  at Foo.bar"),
    { status: 500 },
  );
  const { message } = classifyRunFailure(leaky);
  assert.doesNotMatch(message, /gpt-|claude-|\/v1\/|\bat \w+\.\w+|\b500\b/);
});

test("classifier — a daily token quota is not the context window, and AWS throttling is a rate limit", () => {
  const quota = classifyRunFailure(
    Object.assign(new Error("Too many tokens per day, please wait before trying again."), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
    }),
  );
  assert.equal(quota.code, "quota_exhausted");
  assert.equal(quota.retryable, false);
  assert.doesNotMatch(quota.message, /new chat|conversation/i);
  assert.equal(classifyRunFailure(Object.assign(new Error("capacity exhausted"), { $metadata: { httpStatusCode: 429 } })).code, "rate_limited");
  assert.equal(classifyRunFailure(Object.assign(new Error("capacity exhausted"), { name: "ThrottlingException" })).code, "rate_limited");
});
