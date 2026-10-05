import test from "node:test";
import assert from "node:assert/strict";
import { effectiveDeadline } from "./host.js";

test("effectiveDeadline: the work's own budget, cut short to the invocation's deadline when that comes first", () => {
  const now = Date.now();
  const own = effectiveDeadline(60_000, {});
  assert.ok(own >= now + 60_000 && own <= Date.now() + 60_000, "no deadlineAt: the own budget");
  assert.equal(effectiveDeadline(60_000, { deadlineAt: now + 5_000 }), now + 5_000, "the invocation ends first");
  const later = effectiveDeadline(1_000, { deadlineAt: now + 60_000 });
  assert.ok(later <= Date.now() + 1_000, "the own budget ends first");
});
