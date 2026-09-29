import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { describeText, redactId } from "./redact.js";

test("redactId is stable, short and doesn't contain the identifier", () => {
  const a = redactId("+15551234567");
  assert.equal(a, redactId("+15551234567"));
  assert.notEqual(a, redactId("+15557654321"));
  assert.ok(!a.includes("5551234567"));
  assert.equal(redactId(undefined), "none");
});

test("redactId is keyed: an unkeyed hash of the number doesn't match it", () => {
  const saved = process.env.LOG_REDACTION_KEY;
  try {
    process.env.LOG_REDACTION_KEY = "deployment-key-1";
    const first = redactId("+15551234567");
    const unkeyed = createHash("sha256").update("+15551234567").digest("hex");
    assert.ok(!unkeyed.startsWith(first.slice(1)));
    process.env.LOG_REDACTION_KEY = "deployment-key-2";
    assert.notEqual(redactId("+15551234567"), first);
  } finally {
    if (saved === undefined) delete process.env.LOG_REDACTION_KEY;
    else process.env.LOG_REDACTION_KEY = saved;
  }
});

test("describeText reports only the length", () => {
  assert.equal(describeText("my bank password is hunter2"), "27 chars");
});
