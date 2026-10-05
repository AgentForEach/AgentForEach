/**
 * The gateway's durable work on the in-memory Durable: the kinds it
 * defines, how a chat turn dedupes, and what a scheduler tick starts.
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { DurableRegistry, InMemoryDurable, type Durable } from "@agentforeach/platform";
import { LEGACY_KINDS } from "@agentforeach/platform-azure";
import { setDurableForTests } from "./durable.js";
import { workflows } from "../workflows.js";
import { InMemoryStorage } from "@agentforeach/storage";
import { CHAT_TURN_KIND, setChatTurnDepsForTests, startChatTurn, type ChatTurnRequest } from "../handlers/chat-turn.js";
import { ChatRunStore } from "../sessions/chat-runs.js";
import { CHANNEL_TURN_KIND } from "../handlers/channel-webhook.js";
import { CRON_RUN_KIND, CRON_SCHEDULER_KIND, cronRunJob, executeAndRecordJob, renewClaimWhileRunning, schedulerTick, startForceRun, wakeOrStartScheduler } from "../cron/orchestrator.js";
import { HITL_ORCHESTRATION_NAME } from "../hitl/types.js";
import { CronStore, setCronStore } from "../cron/store.js";
import { FALLBACK_WAKE_INTERVAL_MS, getMaxDueJobsPerTick, getSchedulerInstanceId, getSchedulerShardCount, normalizeSchedulerShardId } from "../cron/config.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";

afterEach(() => {
  setDurableForTests(undefined);
  setChatTurnDepsForTests();
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("timed out");
}

test("the gateway defines every durable kind it starts", () => {
  const kinds = workflows.kinds();
  assert.deepEqual(kinds.jobs.sort(), [CHANNEL_TURN_KIND, CHAT_TURN_KIND, CRON_RUN_KIND].sort());
  assert.deepEqual(kinds.waits, [HITL_ORCHESTRATION_NAME]);
  assert.deepEqual(kinds.alarms, [CRON_SCHEDULER_KIND]);
});

test("the Azure pack's legacy orchestrations map onto kinds the gateway defines", () => {
  const { jobs, waits, alarms } = workflows.kinds();
  const defined = new Set([...jobs, ...waits, ...alarms]);
  for (const kind of Object.values(LEGACY_KINDS)) assert.ok(defined.has(kind), `${kind} is defined`);
});

test("a chat turn is a duplicate while a job with its id is running, and starts again once it finished", async () => {
  let release!: () => void;
  const ran: string[] = [];
  const registry = new DurableRegistry().defineJob<ChatTurnRequest>({
    kind: CHAT_TURN_KIND,
    async run(request) {
      ran.push(request.runId);
      if (request.runId === "first") await new Promise<void>((r) => (release = r));
    },
  });
  const durable = new InMemoryDurable(registry);
  setDurableForTests(durable);
  const runs = new ChatRunStore(new InMemoryStorage());
  setChatTurnDepsForTests({ runs: () => runs });
  const turn = (runId: string) => ({ userId: "u", message: "hi", runId }) as ChatTurnRequest;
  const ctx = { invocationId: "i", log() {}, warn() {}, error() {}, trace() {} };

  assert.deepEqual(await startChatTurn(ctx, "chat-abc", turn("first")), { duplicate: false });
  await until(() => ran.length === 1);
  assert.deepEqual(await startChatTurn(ctx, "chat-abc", turn("retry")), { duplicate: true });
  release();
  await until(async () => (await durable.status("chat-abc"))?.status === "completed");
  assert.deepEqual(await startChatTurn(ctx, "chat-abc", turn("again")), { duplicate: false });
  await until(() => ran.length === 2);
  assert.deepEqual(ran, ["first", "again"]);
});

test("a scheduler tick starts one run per claimed due job, keyed by its claim, and returns the next due time", async () => {
  const started: Array<{ kind: string; id?: string; input: unknown }> = [];
  const fake: Partial<Durable> = {
    startJob: async (kind, input, id) => {
      started.push({ kind, id, input });
      return { started: true, id: id ?? "generated" };
    },
  };
  setDurableForTests(fake as Durable);
  const due = [
    { id: "job-1", userId: "u1", state: { runningToken: "tok-a" } },
    { id: "job-2", userId: "u2", state: { runningToken: "tok-b" } },
  ] as unknown as CronJob[];
  const nextAt = Date.now() + 90_000;
  const seen: unknown[] = [];
  setCronStore({
    getDueJobs: async (_now: number, shardId: number) => (seen.push(shardId), due),
    computeNextWakeMs: async () => nextAt,
    claimDueHeartbeatEvents: async () => [],
    countInFlightRuns: async () => 0,
  } as unknown as CronStore);

  assert.equal(await schedulerTick({ shardId: 2 }), nextAt);
  assert.deepEqual(seen, [2]);
  assert.deepEqual(
    started.map((s) => [s.kind, s.id]),
    [
      [CRON_RUN_KIND, "cron-run-job-1-tok-a"],
      [CRON_RUN_KIND, "cron-run-job-2-tok-b"],
    ],
  );
  assert.equal(started[0].input, due[0]);
});

test("with nothing scheduled, the next tick is the fallback interval away", async () => {
  setDurableForTests({ startJob: async () => ({ started: true, id: "x" }) } as unknown as Durable);
  setCronStore({
    getDueJobs: async () => [],
    computeNextWakeMs: async () => null,
    claimDueHeartbeatEvents: async () => [],
    countInFlightRuns: async () => 0,
  } as unknown as CronStore);
  const before = Date.now();
  const next = await schedulerTick({ shardId: 0 });
  assert.ok(next >= before + FALLBACK_WAKE_INTERVAL_MS && next <= Date.now() + FALLBACK_WAKE_INTERVAL_MS);
});

test("a job change starts a shard's scheduler that isn't running, and wakes one that is", async () => {
  const durable = new InMemoryDurable(
    new DurableRegistry().defineAlarm({ kind: CRON_SCHEDULER_KIND, tick: async () => Date.now() + 60_000 }),
  );
  setDurableForTests(durable);
  const count = getSchedulerShardCount();
  // A fresh deployment: nothing running until the first health check, unless a job change starts it.
  assert.equal(await wakeOrStartScheduler(0, count), "started");
  assert.equal(await wakeOrStartScheduler(0, count), "woken");
  await durable.terminate(getSchedulerInstanceId(0, count), "test done");
});

test("a finished cron run wakes its shard, so the shard counts the job's next run", async () => {
  const woken: string[] = [];
  setDurableForTests({ wakeAlarm: async (id: string) => (woken.push(id), true) } as unknown as Durable);
  setCronStore({} as unknown as CronStore);
  const job = { id: "job-1", userId: "u1", shardId: 3, state: {} } as unknown as CronJob;
  const ctx = { instanceId: "cron-run-job-1-x", invocationId: "i", log() {}, warn() {}, error() {}, trace() {} };
  await cronRunJob.run(job, ctx);
  const count = getSchedulerShardCount();
  assert.deepEqual(woken, [getSchedulerInstanceId(normalizeSchedulerShardId(3, count), count)]);
});

test("a run that can't be started doesn't stop the tick, and its claim is released", async () => {
  const released: string[] = [];
  setDurableForTests({
    startJob: async (_kind: string, _input: unknown, id?: string) => {
      if (id?.includes("job-1")) throw new Error("throttled");
      return { started: true, id: id ?? "x" };
    },
  } as unknown as Durable);
  const due = [
    { id: "job-1", userId: "u1", state: { runningToken: "tok-a" } },
    { id: "job-2", userId: "u2", state: { runningToken: "tok-b" } },
  ] as unknown as CronJob[];
  setCronStore({
    getDueJobs: async () => due,
    computeNextWakeMs: async () => Date.now() + 1000,
    claimDueHeartbeatEvents: async () => [],
    countInFlightRuns: async () => 0,
    releaseRunningClaim: async (id: string, _u: string, token: string) => void released.push(`${id}:${token}`),
  } as unknown as CronStore);
  await schedulerTick({ shardId: 0 });
  assert.deepEqual(released, ["job-1:tok-a"]);
});

test("a shard at capacity claims nothing new and waits for a run to finish", async () => {
  const limits: unknown[] = [];
  setDurableForTests({ startJob: async () => ({ started: true, id: "x" }) } as unknown as Durable);
  setCronStore({
    countInFlightRuns: async () => getMaxDueJobsPerTick(),
    getDueJobs: async (_now: number, _shard: number, limit?: number) => (limits.push(limit), []),
    computeNextWakeMs: async () => Date.now() - 1000, // jobs already due
    claimDueHeartbeatEvents: async () => [],
  } as unknown as CronStore);
  const before = Date.now();
  const next = await schedulerTick({ shardId: 0 });
  assert.deepEqual(limits, [0], "no room: nothing claimed");
  assert.ok(next >= before + 30_000, "doesn't tick again at once");
});

test("a running cron job renews its claim on an interval until it stops", async () => {
  const renewed: string[] = [];
  const store = { renewRunningClaim: async (id: string, _u: string, token: string) => (renewed.push(`${id}:${token}`), true) };
  const stop = renewClaimWhileRunning(store, { id: "job-1", userId: "u" }, "tok", 10);
  await new Promise((r) => setTimeout(r, 55));
  stop();
  const count = renewed.length;
  assert.ok(count >= 3, `renewed while running (${count})`);
  assert.ok(renewed.every((r) => r === "job-1:tok"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(renewed.length, count, "no renewals after it stops");
});

test("a chat turn re-run after an interruption asks the user to resend instead of running again", async () => {
  const { chatTurnJob } = await import("../handlers/chat-turn.js");
  const runs = new ChatRunStore(new InMemoryStorage());
  setChatTurnDepsForTests({ runs: () => runs, push: async () => {} });
  await runs.prepare({ runId: "r-1", userId: "u", fingerprint: "f", instanceId: "chat-x" });
  await runs.begin("u", "r-1");
  const warned: unknown[] = [];
  const ctx = { instanceId: "chat-x", invocationId: "i", attempt: 2, log() {}, warn: (...a: unknown[]) => warned.push(a), error() {}, trace() {} };
  // With attempt 2 the turn must not reach the agent client (which would need a whole gateway).
  await chatTurnJob.run({ userId: "u", message: "hi", runId: "r-1" } as ChatTurnRequest, ctx);
  assert.equal(warned.length, 1);
  assert.match(String((warned[0] as unknown[])[0]), /interrupted/);
  const run = await runs.get("u", "r-1");
  assert.equal(run?.status, "interrupted");
  assert.equal(run?.retryable, true);
});

test("a cron run renews its claim for as long as it executes", async () => {
  const renewed: string[] = [];
  const job = { id: "job-1", userId: "u", state: { runningToken: "tok" } } as unknown as CronJob;
  setCronStore({
    beginClaimedRun: async () => ({ status: "started", job }),
    renewRunningClaim: async (id: string, _u: string, token: string) => (renewed.push(`${id}:${token}`), true),
    recordRun: async () => {},
    applyResult: async () => {},
  } as unknown as CronStore);
  const result = await executeAndRecordJob(job, {
    renewEveryMs: 10,
    execute: async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: "ok", durationMs: 60 } as never;
    },
  });
  assert.equal(result.status, "ok");
  assert.ok(renewed.length >= 3, `renewed during the run (${renewed.length})`);
  const after = renewed.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(renewed.length, after, "not after it ended");
});

// --- A run revalidates its job when it starts; a force-run is named by its claim ---

/** A real cron store on in-memory storage, with one recurring job. */
async function storeWithJob(overrides: Partial<CronJobCreate> = {}) {
  const store = new CronStore(new InMemoryStorage());
  await store.initialize();
  setCronStore(store);
  const job = await store.createJob({
    userId: "u1",
    name: "stretch",
    enabled: true,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "stretch" },
    ...overrides,
  });
  return { store, job };
}

/** As storeWithJob, with the job claimed for a run (as a force-run claims it). */
async function claimedJob(overrides: Partial<CronJobCreate> = {}) {
  const { store, job } = await storeWithJob(overrides);
  return { store, claimed: (await store.claimJobForForceRun(job.id, job.userId))! };
}

/** Run a claimed job, counting how often it executes. */
async function runCounting(job: CronJob) {
  let executed = 0;
  const result = await executeAndRecordJob(job, {
    execute: async () => (executed++, { status: "ok", durationMs: 1 }),
  });
  return { result, executed };
}

test("a job turned off after its run was queued doesn't run; the claim is cleared and the skip recorded", async () => {
  const { store, claimed } = await claimedJob();
  await store.updateJob(claimed.id, "u1", { enabled: false });
  const { result, executed } = await runCounting(claimed);
  assert.equal(executed, 0);
  assert.equal(result.status, "skipped");
  assert.match(result.error ?? "", /turned off/);
  assert.equal((await store.getJob(claimed.id, "u1"))?.state.runningToken, undefined);
  assert.deepEqual((await store.getRuns(claimed.id, "u1")).map((r) => r.status), ["skipped"]);
});

test("a job that expired after its run was queued doesn't run", async () => {
  const { store, claimed } = await claimedJob({ expiresAt: Date.now() + 20 });
  await new Promise((r) => setTimeout(r, 30));
  const { result, executed } = await runCounting(claimed);
  assert.equal(executed, 0);
  assert.match(result.error ?? "", /expired/);
  assert.equal((await store.getJob(claimed.id, "u1"))?.enabled, false);
});

test("a job that reached maxRuns after its run was queued doesn't run", async () => {
  const { store, claimed } = await claimedJob({ maxRuns: 3 });
  await store.updateJob(claimed.id, "u1", { state: { runCount: 3 } });
  const { result, executed } = await runCounting(claimed);
  assert.equal(executed, 0);
  assert.match(result.error ?? "", /maxRuns/);
  assert.equal((await store.getJob(claimed.id, "u1"))?.enabled, false);
});

test("a run whose claim token is no longer the job's doesn't run, and records nothing", async () => {
  const { store, claimed } = await claimedJob();
  const stale = { ...claimed, state: { ...claimed.state, runningToken: "an-older-claim" } };
  const { result, executed } = await runCounting(stale);
  assert.equal(executed, 0);
  assert.match(result.error ?? "", /duplicate-suppressed/);
  assert.equal((await store.getJob(claimed.id, "u1"))?.state.runningToken, claimed.state.runningToken);
  assert.deepEqual(await store.getRuns(claimed.id, "u1"), []);
});

test("a job edited after its run was queued runs as edited", async () => {
  const { store, claimed } = await claimedJob();
  await store.updateJob(claimed.id, "u1", { payload: { kind: "agentTurn", message: "drink water" } });
  const seen: string[] = [];
  const result = await executeAndRecordJob(claimed, {
    execute: async (job) => (seen.push(job.payload.kind === "agentTurn" ? job.payload.message : ""), { status: "ok", durationMs: 1 }),
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(seen, ["drink water"]);
});

test("a retried force-run starts one run, named by its claim", async () => {
  const { store, job } = await storeWithJob();
  const started: Array<string | undefined> = [];
  setDurableForTests({
    startJob: async (_kind: string, _input: unknown, id?: string) => (started.push(id), { started: true, id: id ?? "x" }),
  } as unknown as Durable);

  const first = await startForceRun(job.id, "u1");
  const retried = await startForceRun(job.id, "u1");
  assert.ok(first);
  assert.equal(retried, null, "the retry finds the run in flight");
  const token = (await store.getJob(job.id, "u1"))?.state.runningToken;
  assert.deepEqual(started, [`force-run-${job.id}-${token}`]);
  assert.equal(first.instanceId, started[0]);
});

test("a force-run that can't be started releases its claim", async () => {
  const { store, job } = await storeWithJob();
  setDurableForTests({ startJob: async () => { throw new Error("throttled"); } } as unknown as Durable);
  await assert.rejects(startForceRun(job.id, "u1"), /throttled/);
  assert.equal((await store.getJob(job.id, "u1"))?.state.runningToken, undefined);
});
