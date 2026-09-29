import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeUserCronPatch } from "./api-guards.js";

test("a user's cron PATCH keeps the fields users may set", () => {
  const r = sanitizeUserCronPatch({
    name: "Daily digest",
    enabled: false,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    maxRuns: 5,
    sessionId: "s1",
  });
  assert.deepEqual(r, {
    ok: true,
    patch: {
      name: "Daily digest",
      enabled: false,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      maxRuns: 5,
      sessionId: "s1",
    },
  });
});

test("scheduler state and bookkeeping can't be patched by a user", () => {
  // Forcing an immediate run, resetting runCount past maxRuns, or taking the
  // running claim all go through `state`.
  const r = sanitizeUserCronPatch({
    enabled: true,
    state: { nextRunAtMs: 0, runningToken: "x", runCount: 0 },
    shardId: 3,
    version: 99,
    userId: "victim",
    createdAtMs: 0,
  });
  assert.deepEqual(r, { ok: true, patch: { enabled: true } });
});

test("invalid bodies and session ids are rejected", () => {
  assert.equal(sanitizeUserCronPatch(null).ok, false);
  assert.equal(sanitizeUserCronPatch([1]).ok, false);
  assert.equal(sanitizeUserCronPatch({ sessionId: "../../x" }).ok, false);
});
