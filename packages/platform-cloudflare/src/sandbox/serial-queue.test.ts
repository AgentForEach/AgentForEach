import test from "node:test";
import assert from "node:assert/strict";

import { SerialQueue } from "./serial-queue.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("work runs one at a time in order: a forget queued during a sleep runs after it", async () => {
  const queue = new SerialQueue();
  const events: string[] = [];
  const sleep = queue.run(async () => {
    events.push("sleep:start");
    await tick(30); // snapshotting
    events.push("sleep:snapshot-saved");
  });
  const forget = queue.run(async () => {
    events.push("forget");
    return true;
  });
  await Promise.all([sleep, forget]);
  assert.deepEqual(events, ["sleep:start", "sleep:snapshot-saved", "forget"]);
});

test("a failure is reported to its caller and doesn't block what follows", async () => {
  const queue = new SerialQueue();
  const failed = queue.run(async () => {
    throw new Error("start timed out");
  });
  const next = queue.run(async () => "started");
  await assert.rejects(failed, /start timed out/);
  assert.equal(await next, "started");
});
