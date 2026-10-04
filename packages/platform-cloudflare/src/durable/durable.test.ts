/**
 * The Cloudflare Durable passes the durable conformance suite in Node: each
 * instance id gets an engine over an in-memory stand-in for a Durable
 * Object's storage, whose alarm fires on a timer the way Cloudflare's does
 * (one alarm per object; setting it replaces the previous one; it doesn't
 * fire again while it's running, and fires once more if set meanwhile).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DurableRegistry } from "@agentforeach/platform";
import { runDurableConformance } from "@agentforeach/platform/durable/conformance";
import { CloudflareDurable, type DurableInstanceRpc } from "./client.js";
import { DurableInstanceEngine, type EngineOptions, type InstanceStorage } from "./engine.js";

class FakeObject implements InstanceStorage {
  readonly data = new Map<string, unknown>();
  engine!: DurableInstanceEngine;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private alarmAt: number | null = null;
  private running = false;
  private pending: number | undefined;
  /** Make the next `put` throw (a storage failure). */
  failNextPut = false;
  /** Make the n-th `put` from now throw (1 = the next one). */
  failPutIn = 0;
  /** Make the next read of the input throw. */
  failNextInputGet = false;

  async get<T>(key: string): Promise<T | undefined> {
    if (this.failNextInputGet && key.startsWith("input:")) {
      this.failNextInputGet = false;
      throw new Error("simulated storage failure");
    }
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(entries: Record<string, unknown>): Promise<void> {
    if (this.failNextPut || (this.failPutIn > 0 && --this.failPutIn === 0)) {
      this.failNextPut = false;
      throw new Error("simulated storage failure");
    }
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async getAlarm(): Promise<number | null> {
    return this.running ? (this.pending ?? null) : this.alarmAt;
  }
  async delete(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.data.delete(k)) n++;
    return n;
  }
  async setAlarm(at: number): Promise<void> {
    if (this.running) {
      this.pending = at;
      return;
    }
    this.arm(at);
  }
  async deleteAlarm(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.alarmAt = null;
    this.pending = undefined;
  }
  private arm(at: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.alarmAt = at;
    this.timer = setTimeout(() => void this.fire(), Math.max(0, at - Date.now()));
    // Retention alarms are an hour out; they mustn't keep the test process alive.
    this.timer.unref?.();
  }
  private async fire(): Promise<void> {
    this.timer = undefined;
    this.alarmAt = null;
    this.running = true;
    try {
      await this.engine.alarm();
    } finally {
      this.running = false;
      if (this.pending !== undefined) {
        const at = this.pending;
        this.pending = undefined;
        this.arm(at);
      }
    }
  }
}

function fakeNamespace(registry: DurableRegistry, options: EngineOptions = {}) {
  const objects = new Map<string, FakeObject>();
  const resolve = (id: string): DurableInstanceRpc => {
    let object = objects.get(id);
    if (!object) {
      object = new FakeObject();
      object.engine = new DurableInstanceEngine(object, registry, options);
      objects.set(id, object);
    }
    const e = object.engine;
    return {
      start: (...a) => e.start(...a),
      signal: (...a) => e.signal(...a),
      ensureAlarm: (...a) => e.ensureAlarm(...a),
      wake: () => e.wake(),
      terminate: () => e.terminate(),
      status: () => e.status(),
    };
  };
  return { resolve, objects };
}

runDurableConformance({
  name: "cloudflare (engine on simulated Durable Objects)",
  create: (registry) => new CloudflareDurable(fakeNamespace(registry).resolve),
});

test("a large input is stored in chunks and read back whole", async () => {
  let seen: unknown;
  let chunksWhileRunning = 0;
  const registry = new DurableRegistry().defineJob<{ blob: string }>({
    kind: "big",
    async run(input) {
      seen = input;
      chunksWhileRunning = [...ns.objects.get("big-1")!.data.keys()].filter((k) => k.startsWith("input:")).length;
    },
  });
  const ns = fakeNamespace(registry);
  const durable = new CloudflareDurable(ns.resolve);
  const blob = "x".repeat(3 * 1024 * 1024 + 17);
  await durable.startJob("big", { blob }, "big-1");
  for (let i = 0; i < 200 && (await durable.status("big-1"))?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal((seen as { blob: string }).blob.length, blob.length);
  assert.ok(chunksWhileRunning >= 7, `stored in chunks (${chunksWhileRunning})`);
});

test("a finished instance drops its input, and replacing it stores only the new one", async () => {
  const registry = new DurableRegistry().defineJob({ kind: "j", run: async () => {} });
  const ns = fakeNamespace(registry);
  const durable = new CloudflareDurable(ns.resolve);
  await durable.startJob("j", { n: 1 }, "j-1");
  for (let i = 0; i < 100 && (await durable.status("j-1"))?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([...ns.objects.get("j-1")!.data.keys()].filter((k) => k.startsWith("input:")), [], "deleted on finish");
  await durable.startJob("j", { n: 2 }, "j-1");
  const keys = [...ns.objects.get("j-1")!.data.keys()].filter((k) => k.startsWith("input:"));
  assert.deepEqual(keys, ["input:2:0"]);
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("timed out");
}

test("a finished instance's object is cleared after its retention", async () => {
  const registry = new DurableRegistry().defineWait({ kind: "w", event: "e", onEvent: async () => {}, onTimeout: async () => {} });
  const ns = fakeNamespace(registry, { retentionMs: 40 });
  const durable = new CloudflareDurable(ns.resolve);
  await durable.startWait("w", "w-1", { secret: "form data" }, 5000);
  await until(async () => (await durable.signal("w-1", "e", { answer: "private" })) === true);
  await until(async () => (await durable.status("w-1"))?.status === "completed");
  const stored = JSON.stringify([...ns.objects.get("w-1")!.data.values()]);
  assert.ok(!stored.includes("form data") && !stored.includes("private"), "input and answer gone on finish");
  await until(async () => (await durable.status("w-1")) === null);
  assert.equal(ns.objects.get("w-1")!.data.size, 0);
});

test("a storage failure after the handler re-arms the alarm, and finishing doesn't re-run the handler", async () => {
  let runs = 0;
  const registry = new DurableRegistry().defineJob({
    kind: "j",
    async run() {
      runs++;
      if (runs === 1) ns.objects.get("j-1")!.failPutIn = 2; // the handler's result is recorded, then finishing fails once
    },
  });
  const ns = fakeNamespace(registry, { retryBaseMs: 10 });
  const durable = new CloudflareDurable(ns.resolve);
  await durable.startJob("j", {}, "j-1");
  await until(async () => (await durable.status("j-1"))?.status === "completed");
  assert.equal(runs, 1, "a failure after the handler returned finishes without running it again");
});

test("an active instance with no alarm and no progress counts as dead, so it can be started again", async () => {
  let now = Date.now(); // a clock the test moves forward; the fake alarm timers use the real one
  const registry = new DurableRegistry().defineAlarm({ kind: "a", tick: async () => Date.now() + 60_000 });
  const ns = fakeNamespace(registry, { now: () => now, staleMs: 1000 });
  const durable = new CloudflareDurable(ns.resolve);
  // A record that claims to be running, with no alarm: what an alarm whose retries ran out leaves.
  const object = (ns.resolve("a-1"), ns.objects.get("a-1")!);
  await object.put({
    record: { id: "a-1", type: "alarm", kind: "a", status: "running", createdAt: now, updatedAt: now, generation: 1, inputChunks: 0, ticking: true },
  });
  assert.equal(await durable.ensureAlarm("a", "a-1", {}), "running", "recent progress: still alive");
  now += 5000;
  assert.equal(await durable.wakeAlarm("a-1"), false, "dead: nothing to wake");
  assert.equal(await durable.ensureAlarm("a", "a-1", {}), "started", "dead: the health check restarts it");
  await durable.terminate("a-1", "test done");
});

test("a job re-run after an interruption sees attempt 2", async () => {
  const attempts: Array<number | undefined> = [];
  const registry = new DurableRegistry().defineJob({ kind: "j", run: async (_i, ctx) => void attempts.push(ctx.attempt) });
  const object = new FakeObject();
  const engine = new DurableInstanceEngine(object, registry);
  object.engine = engine;
  // What a cut-off first run leaves: the record says running, attempt 1.
  await object.put({
    record: { id: "j-1", type: "job", kind: "j", status: "running", createdAt: Date.now(), updatedAt: Date.now(), generation: 1, inputChunks: 1, attempts: 1 },
    "input:1:0": "{}",
  });
  await engine.alarm();
  assert.deepEqual(attempts, [2]);
  assert.equal((await engine.status())?.status, "completed");
});

test("a failed read of the input is retried without counting an attempt", async () => {
  const attempts: Array<number | undefined> = [];
  const registry = new DurableRegistry().defineJob({ kind: "j", run: async (_i, ctx) => void attempts.push(ctx.attempt) });
  const ns = fakeNamespace(registry, { retryBaseMs: 10 });
  const durable = new CloudflareDurable(ns.resolve);
  ns.resolve("j-1");
  ns.objects.get("j-1")!.failNextInputGet = true;
  await durable.startJob("j", {}, "j-1");
  await until(async () => (await durable.status("j-1"))?.status === "completed");
  assert.deepEqual(attempts, [1], "the run that read its input is the first");
});

test("a wait refuses an answer once its outcome is decided", async () => {
  let release!: () => void;
  const registry = new DurableRegistry().defineWait({
    kind: "w",
    event: "e",
    onEvent: async () => {},
    onTimeout: () => new Promise<void>((r) => (release = r)),
  });
  const ns = fakeNamespace(registry);
  const durable = new CloudflareDurable(ns.resolve);
  await durable.startWait("w", "w-late", {}, 30);
  await until(() => typeof release === "function"); // onTimeout is running
  assert.equal(await durable.signal("w-late", "e", "too late"), false, "refused, not accepted and dropped");
  release();
  await until(async () => (await durable.status("w-late"))?.status === "completed");
});
