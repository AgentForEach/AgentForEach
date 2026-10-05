import test from "node:test";
import assert from "node:assert/strict";
import { background, currentScope, type ScheduleDef } from "@agentforeach/platform";
import { createLambdaScheduleHandler, type ScheduleTickEvent } from "./schedule.js";

const context = (remainingMs = 60_000) => ({ awsRequestId: "tick-1", getRemainingTimeInMillis: () => remainingMs });
const tick = (scheduledTime?: string): ScheduleTickEvent => ({ source: "agentforeach.schedule", version: 1, scheduledTime });

test("a tick runs the schedules due in its scheduled minute (UTC), each in its own scope", async () => {
  const ran: string[] = [];
  const schedules: ScheduleDef[] = [
    { name: "every5", schedule: "0 */5 * * * *", handler: async (ctx) => void ran.push(`every5:${currentScope()!.kind}:${ctx.invocationId}`) },
    { name: "every15", schedule: "0 */15 * * * *", handler: async () => void ran.push("every15") },
    { name: "weekdays", schedule: "0 30 9 * * MON-FRI", handler: async () => void ran.push("weekdays") },
  ];
  const handler = createLambdaScheduleHandler({ schedules: () => schedules });

  assert.deepEqual(await handler(tick("2026-10-05T10:15:42Z"), context()), { ran: ["every5", "every15"] });
  assert.deepEqual(ran.sort(), ["every15", `every5:schedule:every5-${Date.parse("2026-10-05T10:15:00Z")}`]);

  ran.length = 0;
  assert.deepEqual((await handler(tick("2026-10-05T09:30:00Z"), context())).ran, ["every5", "every15", "weekdays"], "a Monday");
  assert.deepEqual((await handler(tick("2026-10-04T09:31:00Z"), context())).ran, [], "a Sunday, a minute nothing is due");
});

test("a schedule that fails is logged and the others still run; background work is awaited before the tick returns", async (t) => {
  const errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void errors.push(args));
  const done: string[] = [];
  const handler = createLambdaScheduleHandler({
    schedules: () => [
      { name: "fails", schedule: "0 * * * * *", handler: async () => Promise.reject(new Error("boom")) },
      {
        name: "sweeps",
        schedule: "0 * * * * *",
        handler: async (ctx) => {
          assert.equal(typeof ctx.deadlineAt, "number");
          background(new Promise((resolve) => setTimeout(resolve, 30)).then(() => done.push("sweep finished")));
        },
      },
    ],
  });
  assert.deepEqual((await handler(tick("2026-10-05T10:00:00Z"), context())).ran, ["fails", "sweeps"]);
  assert.deepEqual(done, ["sweep finished"]);
  assert.equal(errors.length, 1);
});

test("without a scheduled time, the tick runs the current minute", async () => {
  const handler = createLambdaScheduleHandler({ schedules: () => [{ name: "always", schedule: "0 * * * * *", handler: async () => {} }] });
  assert.deepEqual((await handler(tick(), context())).ran, ["always"]);
});

test("an event that isn't a schedule tick, and a schedule that can't run on whole minutes, are refused", async () => {
  const handler = createLambdaScheduleHandler({ schedules: () => [] });
  await assert.rejects(handler({ source: "aws.events" } as unknown as ScheduleTickEvent, context()), /Not a schedule tick/);
  await assert.rejects(handler(tick("yesterday"), context()), /isn't a time/);

  const bad = createLambdaScheduleHandler({ schedules: () => [{ name: "odd", schedule: "30 * * * * *", handler: async () => {} }] });
  await assert.rejects(bad(tick(), context()), /second 30; EventBridge Scheduler ticks fire on whole minutes/);
});
