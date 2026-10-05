/**
 * AgentForEach Platform — Durable conformance suite
 *
 * One `node:test` suite every Durable implementation must pass, so the
 * gateway's chat turns, HITL waits and cron scheduler behave the same on
 * every cloud.
 *
 * ```ts
 * import { runDurableConformance } from "@agentforeach/platform/durable/conformance";
 *
 * runDurableConformance({
 *   name: "memory",
 *   create: (registry) => new InMemoryDurable(registry),
 * });
 * ```
 *
 * The suite defines its own kinds (prefixed `conformance-`) in the registry
 * it passes to `create`. Instance ids are unique per run, so a suite can
 * share a backend with other work.
 *
 * A backend running elsewhere (a Worker) defines the same kinds with
 * `defineConformanceKinds` (./conformance-kinds.ts, no Node imports) and is
 * reached with `connect` instead, which also returns the recorder the
 * suite reads its handlers' calls from.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";
import {
  defineConformanceKinds,
  MemoryConformanceRecorder,
  type ConformanceCall,
  type ConformanceRecorder,
} from "./conformance-kinds.js";
import { DurableRegistry } from "./registry.js";
import type { Durable } from "./types.js";

export {
  defineConformanceKinds,
  MemoryConformanceRecorder,
  CONFORMANCE_ALARM,
  CONFORMANCE_EVENT,
  CONFORMANCE_JOB,
  CONFORMANCE_WAIT,
  type ConformanceCall,
  type ConformanceHooks,
  type ConformanceRecorder,
} from "./conformance-kinds.js";

export type DurableConformanceOptions = {
  /** Shown in the suite name. */
  name: string;
  /**
   * The unit for timeouts and alarm intervals, in ms. Backends with coarse
   * timers (Durable Functions polls its queues) need a larger one. Default 40.
   */
  unitMs?: number;
  /** How long to wait for something that should happen. Default 5000 ms. */
  patienceMs?: number;
  /**
   * Cut off an instance's running handler the way the host would (a restart,
   * a deploy, an invocation that timed out), so the host runs it again with
   * `attempt > 1`. The handler is held while this runs; call `release` to let
   * it (and its re-run) go on. Hosts that can't tell a re-run leave it unset,
   * and that test is skipped.
   */
  interrupt?: (instanceId: string, release: () => Promise<void>) => Promise<void>;
} & (
  | {
      /** Build the implementation under test, running the kinds in `registry` in this process. */
      create: (registry: DurableRegistry) => Durable | Promise<Durable>;
      connect?: never;
    }
  | {
      /**
       * Reach an implementation running elsewhere (a Worker), whose host
       * defines the kinds itself with `defineConformanceKinds` and serves
       * their recorder.
       */
      connect: () => Promise<{ durable: Durable; recorder: ConformanceRecorder }>;
      create?: never;
    }
);

export function runDurableConformance(options: DurableConformanceOptions): void {
  const unit = options.unitMs ?? 40;
  const patience = options.patienceMs ?? 5000;
  const run = randomUUID().slice(0, 8);
  const id = (name: string) => `conf-${run}-${name}`;

  let durable: Durable;
  let recorder: ConformanceRecorder;

  const callsFor = async (instanceId: string, kind?: string): Promise<ConformanceCall[]> =>
    (await recorder.calls(instanceId)).filter((c) => !kind || c.kind === kind);
  const count = async (instanceId: string, kind?: string): Promise<number> => (await callsFor(instanceId, kind)).length;

  async function eventually(what: string, check: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + patience;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
      await sleep(Math.min(unit, 25));
    }
  }

  async function statusOf(instanceId: string) {
    return (await durable.status(instanceId))?.status;
  }

  describe(`durable conformance: ${options.name}`, () => {
    before(async () => {
      if (options.connect) {
        ({ durable, recorder } = await options.connect());
        return;
      }
      const local = new MemoryConformanceRecorder();
      recorder = local;
      const registry = defineConformanceKinds(new DurableRegistry(), {
        record: (call) => local.record(call),
        gate: (key) => local.gate(key),
        nextTickIn: (instanceId) => local.nextTickIn(instanceId),
        durable: () => durable,
        unitMs: unit,
      });
      durable = await options.create(registry);
    });

    describe("jobs", () => {
      it("runs the handler once with its input, then completes", async () => {
        const jobId = id("job-basic");
        const input = { value: { nested: [1, "two", { three: true }], empty: null } };
        assert.deepEqual(await durable.startJob("conformance-job", input, jobId), { started: true, id: jobId });
        await eventually("job completes", async () => (await statusOf(jobId)) === "completed");
        assert.equal(await count(jobId), 1);
        assert.deepEqual((await callsFor(jobId))[0].input, input);
        const info = await durable.status(jobId);
        assert.ok(info?.createdAt instanceof Date, "createdAt is a Date");
        assert.ok([undefined, 1].includes((await callsFor(jobId))[0].attempt), "a first run is attempt 1, where the host tells");
      });

      it("round-trips a large input (256 KiB) intact", async () => {
        const jobId = id("job-large");
        // 10 bytes of UTF-8 per repeat, characters of 1 to 4 bytes (one outside the BMP).
        const big = "aé✓𝄞".repeat(Math.ceil((256 * 1024) / 10));
        assert.equal((await durable.startJob("conformance-job", { value: big }, jobId)).started, true);
        await eventually("job completes", async () => (await statusOf(jobId)) === "completed");
        const recorded = (await callsFor(jobId))[0].input as { value: string };
        assert.equal(recorded.value.length, big.length);
        assert.ok(recorded.value === big, "the input arrives unchanged");
      });

      it(
        "runs a handler that was cut off mid-way again, with attempt > 1",
        { skip: options.interrupt ? false : "the host can't tell a re-run" },
        async () => {
          const jobId = id("job-rerun");
          const hold = `hold-${jobId}`;
          await durable.startJob("conformance-job", { value: 1, hold }, jobId);
          await eventually("job is running", () => recorder.gateHeld(hold));
          await options.interrupt!(jobId, () => recorder.release(hold));
          await eventually("job completes", async () => (await statusOf(jobId)) === "completed");
          const attempts = (await callsFor(jobId)).map((c) => c.attempt);
          assert.equal(attempts[0], 1, "the first run is attempt 1");
          assert.ok(attempts.length >= 2 && (attempts.at(-1) ?? 0) > 1, `the re-run counts its attempt (got ${attempts.join(", ")})`);
        },
      );

      it("starts nothing for an id that is pending or running", async () => {
        const jobId = id("job-dedupe");
        const hold = `hold-${jobId}`;
        assert.equal((await durable.startJob("conformance-job", { value: 1, hold }, jobId)).started, true);
        await eventually("job is running", () => recorder.gateHeld(hold));
        assert.equal((await durable.startJob("conformance-job", { value: 2 }, jobId)).started, false);
        assert.ok(["pending", "running"].includes((await statusOf(jobId))!));
        await recorder.release(hold);
        await eventually("job completes", async () => (await statusOf(jobId)) === "completed");
        assert.equal(await count(jobId), 1, "the duplicate start didn't run");
      });

      it("replaces a finished instance with the same id", async () => {
        const jobId = id("job-replace");
        await durable.startJob("conformance-job", { value: "first" }, jobId);
        await eventually("first run completes", async () => (await statusOf(jobId)) === "completed");
        assert.equal((await durable.startJob("conformance-job", { value: "second" }, jobId)).started, true);
        await eventually("second run happens", async () => (await count(jobId)) === 2);
        await eventually("second run completes", async () => (await statusOf(jobId)) === "completed");
        assert.deepEqual((await callsFor(jobId))[1].input, { value: "second" });
      });

      it("gives each start without an id a fresh id", async () => {
        const a = await durable.startJob("conformance-job", { value: "a" });
        const b = await durable.startJob("conformance-job", { value: "b" });
        assert.equal(a.started && b.started, true);
        assert.notEqual(a.id, b.id);
        await eventually("both run", async () => (await count(a.id)) === 1 && (await count(b.id)) === 1);
      });

      it("fails an instance whose handler throws, without retrying it, and can start it again", async () => {
        const jobId = id("job-fail");
        await durable.startJob("conformance-job", { value: 1, fail: true }, jobId);
        await eventually("job fails", async () => (await statusOf(jobId)) === "failed");
        await sleep(unit * 3);
        assert.equal(await count(jobId), 1, "not retried");
        assert.equal((await durable.startJob("conformance-job", { value: 2 }, jobId)).started, true);
        await eventually("restart completes", async () => (await statusOf(jobId)) === "completed");
      });

      it("terminating a running job leaves it terminated, even when its handler then finishes", async () => {
        const jobId = id("job-terminate");
        const hold = `hold-${jobId}`;
        await durable.startJob("conformance-job", { value: 1, hold }, jobId);
        await eventually("job is running", () => recorder.gateHeld(hold));
        await durable.terminate(jobId, "conformance");
        await eventually("terminated", async () => (await statusOf(jobId)) === "terminated");
        await recorder.release(hold);
        await sleep(unit * 3);
        assert.equal(await statusOf(jobId), "terminated");
      });

      it("lets a handler start other instances", async () => {
        const parent = id("job-parent");
        const child = id("job-child");
        await durable.startJob("conformance-job", { value: "parent", spawn: child }, parent);
        await eventually("child runs", async () => (await count(child)) === 1);
        await eventually("parent completes", async () => (await statusOf(parent)) === "completed");
      });
    });

    describe("waits", () => {
      it("runs start, then onEvent with the signalled payload when the event comes first", async () => {
        const waitId = id("wait-event");
        assert.equal((await durable.startWait("conformance-wait", waitId, { value: "w" }, patience)).started, true);
        await eventually("start ran", async () => (await count(waitId, "wait-start")) === 1);
        assert.equal(await durable.signal(waitId, "conformance-event", { answer: 42 }), true);
        await eventually("wait completes", async () => (await statusOf(waitId)) === "completed");
        assert.deepEqual((await callsFor(waitId, "wait-event")).map((c) => c.payload), [{ answer: 42 }]);
        assert.equal(await count(waitId, "wait-timeout"), 0);
        assert.deepEqual((await callsFor(waitId, "wait-event"))[0].input, { value: "w" });
      });

      it("runs onTimeout when no event arrives in time, and refuses signals afterwards", async () => {
        const waitId = id("wait-timeout");
        await durable.startWait("conformance-wait", waitId, { value: "t" }, unit * 2);
        await eventually("wait times out", async () => (await statusOf(waitId)) === "completed");
        assert.equal(await count(waitId, "wait-timeout"), 1);
        assert.equal(await count(waitId, "wait-event"), 0);
        assert.equal(await durable.signal(waitId, "conformance-event", {}), false);
      });

      it("keeps an event that arrives while start is still running", async () => {
        const waitId = id("wait-early");
        await durable.startWait("conformance-wait", waitId, { value: "e", slowStart: true }, patience);
        assert.equal(await durable.signal(waitId, "conformance-event", "early"), true);
        await eventually("wait completes", async () => (await statusOf(waitId)) === "completed");
        assert.deepEqual((await callsFor(waitId, "wait-event")).map((c) => c.payload), ["early"]);
      });

      it("doesn't time out before its timeout", async () => {
        const waitId = id("wait-not-early");
        await durable.startWait("conformance-wait", waitId, { value: "n" }, unit * 12);
        await sleep(unit * 5);
        assert.equal(await count(waitId, "wait-timeout"), 0, "no timeout yet");
        assert.ok(["pending", "running"].includes((await statusOf(waitId))!), "still waiting");
        await eventually("then times out", async () => (await count(waitId, "wait-timeout")) === 1);
      });

      it("runs neither handler once terminated, and refuses signals", async () => {
        const waitId = id("wait-terminate");
        await durable.startWait("conformance-wait", waitId, { value: "x" }, unit * 4);
        await eventually("start ran", async () => (await count(waitId, "wait-start")) === 1);
        await durable.terminate(waitId, "conformance");
        await eventually("terminated", async () => (await statusOf(waitId)) === "terminated");
        assert.equal(await durable.signal(waitId, "conformance-event", "late"), false);
        await sleep(unit * 8);
        assert.equal(await count(waitId, "wait-event"), 0);
        assert.equal(await count(waitId, "wait-timeout"), 0);
      });

      it("doesn't deliver an event with another name", async () => {
        const waitId = id("wait-other-event");
        await durable.startWait("conformance-wait", waitId, { value: "o" }, patience);
        await eventually("start ran", async () => (await count(waitId, "wait-start")) === 1);
        await durable.signal(waitId, "some-other-event", "wrong");
        await sleep(unit * 3);
        assert.equal(await count(waitId, "wait-event"), 0, "the other event isn't delivered");
        assert.equal(await durable.signal(waitId, "conformance-event", "right"), true);
        await eventually("wait completes", async () => (await statusOf(waitId)) === "completed");
        assert.deepEqual((await callsFor(waitId, "wait-event")).map((c) => c.payload), ["right"]);
      });

      it("replaces a finished wait with the same id", async () => {
        const waitId = id("wait-replace");
        await durable.startWait("conformance-wait", waitId, { value: 1 }, unit * 2);
        await eventually("first wait times out", async () => (await statusOf(waitId)) === "completed");
        assert.equal((await durable.startWait("conformance-wait", waitId, { value: 2 }, patience)).started, true);
        await eventually("second start ran", async () => (await count(waitId, "wait-start")) === 2);
        await durable.signal(waitId, "conformance-event", "done");
        await eventually("second wait completes", async () => (await count(waitId, "wait-event")) === 1);
      });

      it("refuses a signal for an id with no wait", async () => {
        assert.equal(await durable.signal(id("wait-none"), "conformance-event", {}), false);
      });

      it("starts nothing for an id that is already waiting", async () => {
        const waitId = id("wait-dedupe");
        await durable.startWait("conformance-wait", waitId, { value: 1 }, patience);
        assert.equal((await durable.startWait("conformance-wait", waitId, { value: 2 }, patience)).started, false);
        await durable.signal(waitId, "conformance-event", "done");
        await eventually("wait completes", async () => (await statusOf(waitId)) === "completed");
        assert.equal(await count(waitId, "wait-start"), 1);
      });
    });

    describe("alarms", () => {
      it("ticks at the time each tick asks for", async () => {
        const alarmId = id("alarm-repeat");
        await recorder.setNextTickIn(alarmId, unit);
        assert.equal(await durable.ensureAlarm("conformance-alarm", alarmId, { value: "r" }), "started");
        await eventually("three ticks", async () => (await count(alarmId)) >= 3);
        assert.deepEqual((await callsFor(alarmId))[0].input, { value: "r" });
        await durable.terminate(alarmId, "conformance done");
      });

      it("sleeps until the next tick unless woken, and wakeAlarm brings it forward", async () => {
        const alarmId = id("alarm-wake");
        await recorder.setNextTickIn(alarmId, 60_000);
        await durable.ensureAlarm("conformance-alarm", alarmId, { value: "w" });
        await eventually("first tick", async () => (await count(alarmId)) === 1);
        await sleep(unit * 3);
        assert.equal(await count(alarmId), 1, "no early tick without a wake");
        assert.equal(await durable.wakeAlarm(alarmId), true);
        await eventually("woken tick", async () => (await count(alarmId)) === 2);
        await durable.terminate(alarmId, "conformance done");
      });

      it("ensureAlarm leaves a running alarm alone", async () => {
        const alarmId = id("alarm-ensure");
        await recorder.setNextTickIn(alarmId, 60_000);
        assert.equal(await durable.ensureAlarm("conformance-alarm", alarmId, { value: 1 }), "started");
        await eventually("first tick", async () => (await count(alarmId)) === 1);
        assert.equal(await durable.ensureAlarm("conformance-alarm", alarmId, { value: 2 }), "running");
        await sleep(unit * 3);
        assert.equal(await count(alarmId), 1, "ensure didn't start a second loop");
        await durable.terminate(alarmId, "conformance done");
      });

      it("stops ticking when terminated, and can be started again", async () => {
        const alarmId = id("alarm-terminate");
        await recorder.setNextTickIn(alarmId, unit);
        await durable.ensureAlarm("conformance-alarm", alarmId, { value: 1 });
        await eventually("ticking", async () => (await count(alarmId)) >= 1);
        await durable.terminate(alarmId, "conformance");
        await eventually("terminated", async () => (await statusOf(alarmId)) === "terminated");
        const after = await count(alarmId);
        await sleep(unit * 4);
        assert.ok((await count(alarmId)) <= after + 1, "at most an in-flight tick after terminate");
        assert.equal(await durable.wakeAlarm(alarmId), false);
        assert.equal(await durable.ensureAlarm("conformance-alarm", alarmId, { value: 2 }), "started");
        await eventually("ticks again", async () => (await callsFor(alarmId)).some((c) => (c.input as { value: number }).value === 2));
        await durable.terminate(alarmId, "conformance done");
      });

      it("fails an alarm whose tick throws, and stops ticking it", async () => {
        const alarmId = id("alarm-fail");
        await recorder.setNextTickIn(alarmId, unit);
        await durable.ensureAlarm("conformance-alarm", alarmId, { value: 1, fail: true });
        await eventually("alarm fails", async () => (await statusOf(alarmId)) === "failed");
        const ticks = await count(alarmId);
        await sleep(unit * 4);
        assert.equal(await count(alarmId), ticks, "no ticks after it failed");
        assert.equal(await durable.wakeAlarm(alarmId), false);
      });

      it("refuses to wake an alarm that doesn't exist", async () => {
        assert.equal(await durable.wakeAlarm(id("alarm-none")), false);
      });
    });

    describe("instances", () => {
      it("reports null for an id with no instance, and terminating it is a no-op", async () => {
        assert.equal(await durable.status(id("nothing")), null);
        await durable.terminate(id("nothing"), "no-op");
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
