import assert from "node:assert/strict";
import { test } from "node:test";
import { DurableRegistry } from "@agentforeach/platform";
import { AzureDurable, MAX_TIMER_MS, ORCHESTRATIONS, registerDurable, type DurableApp, type DurableClientLike } from "./durable.js";

// ---------------------------------------------------------------------------
// A fake Durable Functions client
// ---------------------------------------------------------------------------

type Raw = { name?: string; runtimeStatus?: string; createdTime?: string; lastUpdatedTime?: string };

function fakeClient(instances: Record<string, Raw> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const client: DurableClientLike = {
    async getStatus(id) {
      calls.push(["getStatus", id]);
      const raw = instances[id];
      if (!raw) throw new Error("The operation failed with an unexpected status code: 404");
      return raw;
    },
    async startNew(name, options) {
      calls.push(["startNew", name, options]);
      const id = options?.instanceId ?? "generated";
      if (instances[id]?.runtimeStatus === "Running") throw new Error(`An instance with ID '${id}' already exists.`);
      instances[id] = { name, runtimeStatus: "Pending" };
      return id;
    },
    async raiseEvent(id, event, data) {
      calls.push(["raiseEvent", id, event, data]);
    },
    async terminate(id, reason) {
      calls.push(["terminate", id, reason]);
      instances[id] = { ...instances[id], runtimeStatus: "Terminated" };
    },
    async purgeInstanceHistory(id) {
      calls.push(["purge", id]);
      delete instances[id];
    },
  };
  return { client, calls, instances };
}

const registry = new DurableRegistry()
  .defineJob({ kind: "J", run: async () => {} })
  .defineWait({ kind: "W", event: "answer", onEvent: async () => {}, onTimeout: async () => {} })
  .defineAlarm({ kind: "A", tick: async () => 0 });

const names = (calls: Array<[string, ...unknown[]]>) => calls.map((c) => c[0]);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

test("startJob starts an id with no instance, under the generic job orchestration", async () => {
  const f = fakeClient();
  const durable = new AzureDurable(registry, () => f.client);
  assert.deepEqual(await durable.startJob("J", { a: 1 }, "chat-1"), { started: true, id: "chat-1" });
  assert.deepEqual(f.calls.at(-1), ["startNew", ORCHESTRATIONS.job, { instanceId: "chat-1", input: { kind: "J", input: { a: 1 } } }]);
});

test("startJob starts nothing while the id is pending or running, and replaces a finished one", async () => {
  for (const runtimeStatus of ["Pending", "Running"]) {
    const f = fakeClient({ "chat-1": { runtimeStatus } });
    assert.equal((await new AzureDurable(registry, () => f.client).startJob("J", {}, "chat-1")).started, false);
    assert.ok(!names(f.calls).includes("startNew"));
  }
  for (const runtimeStatus of ["Completed", "Failed", "Terminated"]) {
    const f = fakeClient({ "chat-1": { runtimeStatus } });
    assert.equal((await new AzureDurable(registry, () => f.client).startJob("J", {}, "chat-1")).started, true);
  }
});

test("startJob treats losing a start race as a duplicate", async () => {
  const f = fakeClient();
  f.client.startNew = async () => {
    throw new Error("An instance with ID 'chat-1' already exists.");
  };
  assert.equal((await new AzureDurable(registry, () => f.client).startJob("J", {}, "chat-1")).started, false);
});

test("startWait carries the kind's event and the timeout", async () => {
  const f = fakeClient();
  await new AzureDurable(registry, () => f.client).startWait("W", "hitl-1", { r: 1 }, 5000);
  assert.deepEqual(f.calls.at(-1), [
    "startNew",
    ORCHESTRATIONS.wait,
    { instanceId: "hitl-1", input: { kind: "W", input: { r: 1 }, event: "answer", timeoutMs: 5000 } },
  ]);
});

test("signal raises the event only for a pending or running instance", async () => {
  const f = fakeClient({ "hitl-1": { runtimeStatus: "Running" }, "hitl-2": { runtimeStatus: "Completed" } });
  const durable = new AzureDurable(registry, () => f.client);
  assert.equal(await durable.signal("hitl-1", "answer", { ok: true }), true);
  assert.deepEqual(f.calls.at(-1), ["raiseEvent", "hitl-1", "answer", { ok: true }]);
  assert.equal(await durable.signal("hitl-2", "answer", {}), false);
  assert.equal(await durable.signal("hitl-none", "answer", {}), false);
  assert.equal(f.calls.filter((c) => c[0] === "raiseEvent").length, 1);
});

test("ensureAlarm starts a missing alarm and leaves a running one alone", async () => {
  const f = fakeClient();
  const durable = new AzureDurable(registry, () => f.client);
  assert.equal(await durable.ensureAlarm("A", "sched-0", { shardId: 0 }), "started");
  assert.deepEqual(f.calls.at(-1), ["startNew", ORCHESTRATIONS.alarm, { instanceId: "sched-0", input: { kind: "A", input: { shardId: 0 } } }]);
  f.instances["sched-0"] = { name: ORCHESTRATIONS.alarm, runtimeStatus: "Running" };
  assert.equal(await durable.ensureAlarm("A", "sched-0", { shardId: 0 }), "running");
});

test("ensureAlarm purges a finished alarm before starting it again, and leaves a suspended one", async () => {
  const f = fakeClient({ "sched-0": { name: ORCHESTRATIONS.alarm, runtimeStatus: "Failed" }, "sched-1": { runtimeStatus: "Suspended" } });
  const durable = new AzureDurable(registry, () => f.client);
  assert.equal(await durable.ensureAlarm("A", "sched-0", {}), "started");
  assert.deepEqual(names(f.calls), ["getStatus", "purge", "startNew"]);
  assert.equal(await durable.ensureAlarm("A", "sched-1", {}), "suspended");
});

test("ensureAlarm replaces an instance of the pre-platform CronScheduler holding the id", async () => {
  const f = fakeClient({ "agentforeach-cron-scheduler": { name: "CronScheduler", runtimeStatus: "Running" } });
  const durable = new AzureDurable(registry, () => f.client, { stopCheck: { attempts: 3, delayMs: 0 } });
  assert.equal(await durable.wakeAlarm("agentforeach-cron-scheduler"), false, "the old orchestration can't be woken");
  assert.equal(await durable.ensureAlarm("A", "agentforeach-cron-scheduler", { shardId: 0 }), "started");
  assert.deepEqual(names(f.calls).slice(-5), ["getStatus", "terminate", "getStatus", "purge", "startNew"]);
});

test("wakeAlarm raises the wake event on a running alarm only", async () => {
  const f = fakeClient({ "sched-0": { name: ORCHESTRATIONS.alarm, runtimeStatus: "Running" } });
  const durable = new AzureDurable(registry, () => f.client);
  assert.equal(await durable.wakeAlarm("sched-0"), true);
  assert.deepEqual(f.calls.at(-1), ["raiseEvent", "sched-0", "wake", {}]);
  assert.equal(await durable.wakeAlarm("sched-9"), false);
});

test("status maps Durable Functions statuses and dates, and is null for a missing instance", async () => {
  const f = fakeClient({
    a: { runtimeStatus: "ContinuedAsNew", createdTime: "2026-10-02T10:00:00Z", lastUpdatedTime: "2026-10-02T10:05:00Z" },
    b: { runtimeStatus: "Canceled" },
  });
  const durable = new AzureDurable(registry, () => f.client);
  const a = await durable.status("a");
  assert.equal(a?.status, "running");
  assert.equal(a?.createdAt?.toISOString(), "2026-10-02T10:00:00.000Z");
  assert.equal((await durable.status("b"))?.status, "terminated");
  assert.equal(await durable.status("missing"), null);
});

test("terminate stops only an instance that is still going", async () => {
  const f = fakeClient({ a: { runtimeStatus: "Running" }, b: { runtimeStatus: "Completed" } });
  const durable = new AzureDurable(registry, () => f.client);
  await durable.terminate("a", "stop");
  await durable.terminate("b", "stop");
  await durable.terminate("c", "stop");
  assert.deepEqual(f.calls.filter((c) => c[0] === "terminate"), [["terminate", "a", "stop"]]);
});

test("operations refuse an unknown kind before calling Durable Functions", async () => {
  const f = fakeClient();
  const durable = new AzureDurable(registry, () => f.client);
  await assert.rejects(durable.startJob("nope", {}, "x"), /Unknown durable job kind/);
  await assert.rejects(durable.ensureAlarm("nope", "x", {}), /Unknown durable alarm kind/);
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Orchestration shapes (driven by hand, as the Durable runtime would replay them)
// ---------------------------------------------------------------------------

function captureApp() {
  const orchestrations = new Map<string, (ctx: unknown) => Generator<unknown, unknown, unknown>>();
  const activities = new Map<string, unknown>();
  const app: DurableApp = {
    orchestration: (name, handler) => void orchestrations.set(name, handler as never),
    activity: (name, options) => void activities.set(name, options),
  };
  return { app, orchestrations, activities };
}

function fakeOrchestrationContext(input: unknown, now = 1_000_000) {
  const yielded: unknown[] = [];
  let continued: unknown;
  const timer = { kind: "timer", isCompleted: false, cancelled: false, cancel() { this.cancelled = true; } };
  const event = { kind: "event", isCompleted: false, result: undefined as unknown };
  const ctx = {
    df: {
      instanceId: "inst-1",
      currentUtcDateTime: new Date(now),
      getInput: () => input,
      callActivity: (name: string, arg: unknown) => ({ kind: "activity", name, arg }),
      createTimer: (at: Date) => Object.assign(timer, { at }),
      waitForExternalEvent: (name: string) => Object.assign(event, { name }),
      Task: { any: (tasks: unknown[]) => ({ kind: "any", tasks }) },
      continueAsNew: (next: unknown) => (continued = next),
    },
  };
  return { ctx, yielded, timer, event, continued: () => continued };
}

function drive(gen: Generator<unknown, unknown, unknown>, onYield: (value: any) => unknown): unknown[] {
  const seen: unknown[] = [];
  let step = gen.next();
  while (!step.done) {
    seen.push(step.value);
    step = gen.next(onYield(step.value));
  }
  return seen;
}

test("the job orchestration calls its run activity once, with the instance id", () => {
  const { app, orchestrations, activities } = captureApp();
  registerDurable(registry, app);
  assert.deepEqual([...activities.keys()].sort(), ["DurableAlarmTick", "DurableJobRun", "DurableWaitEvent", "DurableWaitStart", "DurableWaitTimeout"]);
  const f = fakeOrchestrationContext({ kind: "J", input: { a: 1 } });
  const seen = drive(orchestrations.get(ORCHESTRATIONS.job)!(f.ctx), () => undefined);
  assert.deepEqual(seen, [{ kind: "activity", name: "DurableJobRun", arg: { kind: "J", input: { a: 1 }, instanceId: "inst-1" } }]);
});

test("the wait orchestration runs the event activity when the event wins, cancelling the timer", () => {
  const { app, orchestrations } = captureApp();
  const withStart = new DurableRegistry().defineWait({
    kind: "W",
    event: "answer",
    start: async () => {},
    onEvent: async () => {},
    onTimeout: async () => {},
  });
  registerDurable(withStart, app);
  const f = fakeOrchestrationContext({ kind: "W", input: { r: 1 }, event: "answer", timeoutMs: 300_000 });
  const seen = drive(orchestrations.get(ORCHESTRATIONS.wait)!(f.ctx), (v) => {
    if (v.kind === "any") Object.assign(f.event, { isCompleted: true, result: { ok: 1 } });
    return undefined;
  });
  const activityNames = seen.filter((v: any) => v.kind === "activity").map((v: any) => v.name);
  assert.deepEqual(activityNames, ["DurableWaitStart", "DurableWaitEvent"]);
  assert.deepEqual((seen.at(-1) as any).arg.payload, { ok: 1 });
  assert.equal(f.timer.cancelled, true);
  assert.equal((f.timer as any).at.getTime(), 1_000_000 + 300_000);
  assert.equal((f.event as any).name, "answer");
});

test("the wait orchestration runs the timeout activity when the timer wins", () => {
  const { app, orchestrations } = captureApp();
  registerDurable(registry, app);
  const f = fakeOrchestrationContext({ kind: "W", input: {}, event: "answer", timeoutMs: 1000 });
  const seen = drive(orchestrations.get(ORCHESTRATIONS.wait)!(f.ctx), (v) => {
    if (v.kind === "any") f.timer.isCompleted = true;
    return undefined;
  });
  assert.deepEqual(seen.filter((v: any) => v.kind === "activity").map((v: any) => v.name), ["DurableWaitTimeout"]);
});

test("the alarm orchestration ticks, sleeps until the tick's time or a wake (capped), then continues as new", () => {
  const { app, orchestrations } = captureApp();
  registerDurable(registry, app);
  const now = 1_000_000;
  for (const [next, expected] of [
    [now + 60_000, now + 60_000],
    [now - 5, now],
    [now + MAX_TIMER_MS * 2, now + MAX_TIMER_MS],
  ] as const) {
    const f = fakeOrchestrationContext({ kind: "A", input: { shardId: 3 } }, now);
    const seen = drive(orchestrations.get(ORCHESTRATIONS.alarm)!(f.ctx), (v) => (v.kind === "activity" ? next : undefined));
    assert.equal((seen[0] as any).name, "DurableAlarmTick");
    assert.equal((f.timer as any).at.getTime(), expected);
    assert.equal((f.event as any).name, "wake");
    assert.equal(f.timer.cancelled, true, "an unfinished timer is cancelled before continueAsNew");
    assert.deepEqual(f.continued(), { kind: "A", input: { shardId: 3 } });
  }
});

test("ensureAlarm waits for a queued termination to land before taking the id", async () => {
  const id = "agentforeach-cron-scheduler";
  const f = fakeClient({ [id]: { name: "CronScheduler", runtimeStatus: "Running" } });
  let checksAfterTerminate = 0;
  f.client.terminate = async (i, reason) => {
    f.calls.push(["terminate", i, reason]);
  };
  const getStatus = f.client.getStatus;
  f.client.getStatus = async (i) => {
    if (f.calls.some((c) => c[0] === "terminate") && ++checksAfterTerminate === 3) {
      f.instances[i] = { name: "CronScheduler", runtimeStatus: "Terminated" };
    }
    return getStatus(i);
  };
  const durable = new AzureDurable(registry, () => f.client, { stopCheck: { attempts: 5, delayMs: 0 } });
  assert.equal(await durable.ensureAlarm("A", id, { shardId: 0 }), "started");
  assert.deepEqual(names(f.calls).slice(-3), ["getStatus", "purge", "startNew"]);
});

test("ensureAlarm leaves the id alone when the old instance doesn't stop in time", async () => {
  const id = "agentforeach-cron-scheduler";
  const f = fakeClient({ [id]: { name: "CronScheduler", runtimeStatus: "Running" } });
  f.client.terminate = async (i, reason) => void f.calls.push(["terminate", i, reason]);
  const durable = new AzureDurable(registry, () => f.client, { stopCheck: { attempts: 2, delayMs: 0 } });
  assert.equal(await durable.ensureAlarm("A", id, {}), "running");
  assert.ok(!names(f.calls).includes("startNew"));
  assert.ok(!names(f.calls).includes("purge"));
});

test("the pre-platform CronScheduler is registered only as an orchestration that ends at once", async () => {
  const { registerLegacyOrchestrations } = await import("./legacy.js");
  const { app, orchestrations, activities } = captureApp();
  registerLegacyOrchestrations(new DurableRegistry().defineAlarm({ kind: "CronScheduler", tick: async () => 0 }), app);
  assert.deepEqual([...orchestrations.keys()], ["CronScheduler"]);
  assert.equal(activities.size, 0);
  const gen = orchestrations.get("CronScheduler")!(fakeOrchestrationContext({}).ctx);
  assert.equal(gen.next().done, true);
});

test("a status error other than a 404 is thrown, except when starting a job", async () => {
  const f = fakeClient({ busy: { runtimeStatus: "Running" } });
  f.client.getStatus = async () => {
    throw new Error("DurableClient error: Durable Functions extension replied with HTTP 503 response.");
  };
  const durable = new AzureDurable(registry, () => f.client);
  await assert.rejects(durable.signal("busy", "answer", {}), /503/);
  await assert.rejects(durable.status("busy"), /503/);
  // Starting a job keeps its old leniency: it tries the start.
  assert.equal((await durable.startJob("J", {}, "fresh")).started, true);
});
