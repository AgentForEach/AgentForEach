import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

// Pin the env-tunable knobs so the agentforeach.json defaults apply.
for (const name of [
  "CRON_LEGACY_SWEEP",
  "CRON_DUE_INDEX_MIGRATED",
  "CRON_SCHEDULER_SHARDS",
  "CRON_MIN_EVERY_MS",
  "CRON_MIN_CRON_INTERVAL_MS",
  "CRON_DEFAULT_EXPIRY_MS",
  "CRON_MAX_EXPIRY_MS",
  "CRON_MAX_JOBS_PER_USER",
  "CRON_MAX_DUE_JOBS_PER_TICK",
  "CRON_HEARTBEAT_MAX_ATTEMPTS",
]) {
  delete process.env[name];
}

import { InMemoryCosmosDatabase } from "../database/testing/in-memory-cosmos.js";
import { CronStore } from "./store.js";
import {
  CRON_DUE_INDEX_CONTAINER,
  CRON_HEARTBEAT_EVENTS_CONTAINER,
  CRON_JOBS_CONTAINER,
  DELIVERY_LEAD_TIME_MS,
  MAX_ONE_SHOT_DELIVERY_RETRIES,
  RUNNING_CLAIM_STALE_MS,
  getBackoffMs,
  getDefaultExpiryMs,
  getHeartbeatMaxAttempts,
  getMaxExpiryMs,
  getMinEveryMs,
  getSchedulerShardCount,
  getSchedulerShardForUser,
} from "./config.js";
import type { CronHeartbeatEventDocument, CronJob, CronJobCreate } from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

type DueRow = {
  id: string;
  jobId: string;
  userId: string;
  shardId: string;
  jobVersion?: number;
  enabled: boolean;
  nextRunAtMs?: number;
  runningToken?: string;
  runningAtMs?: number;
};

/** Mock Date only (timers keep running), starting at T0. */
function useClock(t: TestContext, now = T0) {
  t.mock.timers.enable({ apis: ["Date"], now });
  return {
    set: (ms: number) => t.mock.timers.setTime(ms),
    now: () => Date.now(),
  };
}

async function setup() {
  const db = new InMemoryCosmosDatabase();
  const store = new CronStore(db);
  await store.initialize();
  const jobs = db.container<CronJob>(CRON_JOBS_CONTAINER);
  const dueIndex = db.container<DueRow>(CRON_DUE_INDEX_CONTAINER);
  const heartbeats = db.container<CronHeartbeatEventDocument>(CRON_HEARTBEAT_EVENTS_CONTAINER);
  return {
    db,
    store,
    jobs,
    dueIndex,
    heartbeats,
    dueRows: () => dueIndex.raw.all<DueRow>(),
    dueRow: (job: Pick<CronJob, "id" | "userId">) =>
      dueIndex.raw.peek<DueRow>(job.id, String(getSchedulerShardForUser(job.userId))),
  };
}

/** Distinct user ids that hash to the same scheduler shard. */
function usersInOneShard(count: number): { users: string[]; shard: number } {
  const byShard = new Map<number, string[]>();
  for (let i = 0; ; i++) {
    const user = `user-${i}`;
    const shard = getSchedulerShardForUser(user);
    const list = byShard.get(shard) ?? [];
    list.push(user);
    byShard.set(shard, list);
    if (list.length === count) return { users: list, shard };
  }
}

function everyJob(userId: string, overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    userId,
    name: "stretch reminder",
    enabled: true,
    schedule: { kind: "every", everyMs: 5 * MIN },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "remind me to stretch" },
    ...overrides,
  };
}

function atJob(userId: string, atMs: number, overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return everyJob(userId, {
    name: "one-shot",
    schedule: { kind: "at", at: new Date(atMs).toISOString() },
    ...overrides,
  });
}

/** Claim exactly `job` at `nowMs` (its shard), returning the claimed copy. */
async function claim(store: CronStore, job: CronJob, nowMs: number): Promise<CronJob> {
  const claimed = await store.getDueJobs(nowMs, getSchedulerShardForUser(job.userId));
  const mine = claimed.find((c) => c.id === job.id);
  assert.ok(mine, `expected job ${job.id} to be claimed at ${new Date(nowMs).toISOString()}`);
  assert.ok(mine.state.runningToken);
  return mine;
}

// ============================================================================
// createJob validation + due index
// ============================================================================

test("createJob stores a recurring job and indexes it in its owner's shard", async (t) => {
  useClock(t);
  const { store, dueRows } = await setup();

  const job = await store.createJob(everyJob("alice"));

  const shard = getSchedulerShardForUser("alice");
  assert.equal(job.shardId, shard);
  assert.equal(job.version, 1);
  assert.equal(job.expiresAt, T0 + getDefaultExpiryMs());
  assert.equal(job.deleteAfterRun, false);
  // "every" jobs are anchored at creation and fire slightly early.
  assert.deepEqual(job.schedule, { kind: "every", everyMs: 5 * MIN, anchorMs: T0 });
  assert.equal(job.state.nextRunAtMs, T0 + 5 * MIN - DELIVERY_LEAD_TIME_MS);

  const rows = dueRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shardId, String(shard));
  assert.equal(rows[0].jobId, job.id);
  assert.equal(rows[0].userId, "alice");
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].jobVersion, 1);
  assert.equal(rows[0].nextRunAtMs, job.state.nextRunAtMs);
  assert.equal(rows[0].runningToken, undefined);
});

test("createJob defaults one-shot jobs to delete-after-run with no expiry", async (t) => {
  useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(atJob("alice", T0 + 30 * MIN));
  assert.equal(job.deleteAfterRun, true);
  assert.equal(job.expiresAt, undefined);
  assert.equal(job.state.nextRunAtMs, T0 + 30 * MIN - DELIVERY_LEAD_TIME_MS);
  assert.equal(dueRow(job)?.nextRunAtMs, job.state.nextRunAtMs);
});

test("a job due weeks or months away is still found when its time comes", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  for (const days of [14, 45, 400]) {
    const job = await store.createJob(atJob(`far-${days}`, T0 + days * DAY));
    clock.set(job.state.nextRunAtMs!);
    await claim(store, job, Date.now());
    clock.set(T0);
  }
});

test("a run deferred by the scheduled-run limit keeps a one-shot job and retries it", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const job = await store.createJob(atJob("alice", T0 + 30 * MIN));
  clock.set(job.state.nextRunAtMs!);
  const claimed = await claim(store, job, Date.now());

  const outcome = await store.applyResult(
    claimed,
    { status: "skipped", durationMs: 1, retryAfterMs: MIN },
    { runningToken: claimed.state.runningToken },
  );
  assert.equal(outcome.action, "updated");
  const after = (await store.getJob(job.id, job.userId))!;
  assert.equal(after.enabled, true);
  assert.equal(after.state.nextRunAtMs, Date.now() + MIN);
  assert.equal(after.state.consecutiveErrors ?? 0, 0);

  clock.set(Date.now() + MIN);
  await claim(store, after, Date.now());
});

test("createJob rejects an interval below the minimum and writes nothing", async (t) => {
  useClock(t);
  const { store, jobs, dueRows } = await setup();
  await assert.rejects(
    store.createJob(everyJob("alice", { schedule: { kind: "every", everyMs: getMinEveryMs() - 1 } })),
    /Interval too short/,
  );
  assert.equal(jobs.raw.all().length, 0);
  assert.equal(dueRows().length, 0);
});

test("createJob rejects a cron expression that fires more often than allowed", async (t) => {
  useClock(t);
  const { store } = await setup();
  await assert.rejects(
    store.createJob(everyJob("alice", { schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" } })),
    /Cron fires too frequently/,
  );
  await assert.rejects(
    store.createJob(everyJob("alice", { schedule: { kind: "cron", expr: "not a cron", tz: "UTC" } })),
    // Rejected by croner while computing the first run, before validation.
    /five or six space separated parts|Invalid cron expression/,
  );
  const hourly = await store.createJob(
    everyJob("alice", { schedule: { kind: "cron", expr: "30 * * * *", tz: "UTC" } }),
  );
  assert.ok(typeof hourly.state.nextRunAtMs === "number" && hourly.state.nextRunAtMs > T0);
});

test("createJob rejects an expiry beyond the maximum or in the past", async (t) => {
  useClock(t);
  const { store } = await setup();
  await assert.rejects(
    store.createJob(everyJob("alice", { expiresAt: T0 + getMaxExpiryMs() + 1 })),
    /exceeds maximum allowed expiry/,
  );
  await assert.rejects(store.createJob(everyJob("alice", { expiresAt: T0 - 1 })), /must be in the future/);
  const job = await store.createJob(everyJob("alice", { expiresAt: T0 + getMaxExpiryMs() }));
  assert.equal(job.expiresAt, T0 + getMaxExpiryMs());
});

test("createJob rejects payloads that don't match the session target", async (t) => {
  useClock(t);
  const { store } = await setup();
  await assert.rejects(
    store.createJob(everyJob("alice", { payload: { kind: "agentTurn", message: "   " } })),
    /non-empty message/,
  );
  await assert.rejects(
    store.createJob(everyJob("alice", { sessionTarget: "main" })),
    /main cron jobs require payload.kind="systemEvent"/,
  );
});

test("createJob enforces the per-user job limit", async (t) => {
  useClock(t);
  process.env.CRON_MAX_JOBS_PER_USER = "2";
  t.after(() => delete process.env.CRON_MAX_JOBS_PER_USER);
  const { store } = await setup();

  await store.createJob(everyJob("alice"));
  await store.createJob(everyJob("alice"));
  await assert.rejects(store.createJob(everyJob("alice")), /cron job limit exceeded for user \(2\)/);
  // The limit is per user.
  await store.createJob(everyJob("bob"));
  assert.equal(await store.countJobs("alice"), 2);
});

test("a disabled job is stored without a due-index row", async (t) => {
  useClock(t);
  const { store, dueRows } = await setup();
  const job = await store.createJob(everyJob("alice", { enabled: false }));
  assert.equal(job.enabled, false);
  assert.equal(dueRows().length, 0);
});

// ============================================================================
// updateJob / deleteJob keep the due index in step
// ============================================================================

test("updateJob reschedules the due-index row; disabling removes it and re-enabling restores it", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice"));

  clock.set(T0 + MIN);
  const rescheduled = await store.updateJob(job.id, "alice", {
    schedule: { kind: "every", everyMs: 10 * MIN },
  });
  assert.ok(rescheduled);
  assert.equal(rescheduled.version, 2);
  // The anchor from creation is kept.
  assert.equal(rescheduled.state.nextRunAtMs, T0 + 10 * MIN - DELIVERY_LEAD_TIME_MS);
  assert.equal(dueRow(job)?.nextRunAtMs, T0 + 10 * MIN - DELIVERY_LEAD_TIME_MS);
  assert.equal(dueRow(job)?.jobVersion, 2);

  const disabled = await store.updateJob(job.id, "alice", { enabled: false });
  assert.equal(disabled?.enabled, false);
  assert.equal(disabled?.state.nextRunAtMs, undefined);
  assert.equal(dueRow(job), undefined);

  const enabled = await store.updateJob(job.id, "alice", { enabled: true });
  assert.equal(enabled?.state.nextRunAtMs, T0 + 10 * MIN - DELIVERY_LEAD_TIME_MS);
  assert.equal(dueRow(job)?.jobVersion, 4);
});

test("updateJob validates like createJob and returns null for a missing job", async (t) => {
  useClock(t);
  const { store } = await setup();
  const job = await store.createJob(everyJob("alice"));
  await assert.rejects(
    store.updateJob(job.id, "alice", { schedule: { kind: "every", everyMs: 1_000 } }),
    /Interval too short/,
  );
  await assert.rejects(
    store.updateJob(job.id, "alice", { expiresAt: T0 + getMaxExpiryMs() + DAY }),
    /exceeds maximum allowed expiry/,
  );
  assert.equal(await store.updateJob("missing", "alice", { name: "x" }), null);
  // Another user's partition doesn't have the job.
  assert.equal(await store.updateJob(job.id, "mallory", { enabled: false }), null);
  assert.equal((await store.getJob(job.id, "alice"))?.version, 1);
});

test("updateJob retries on an etag conflict and keeps the concurrent write", async (t) => {
  useClock(t);
  const { store, jobs } = await setup();
  const job = await store.createJob(everyJob("alice"));

  // A concurrent writer changes the description between our read and replace.
  let raced = false;
  const remove = jobs.raw.beforeOperation(async ({ op }) => {
    if (op === "replace" && !raced) {
      raced = true;
      const current = jobs.raw.peek<CronJob>(job.id, "alice")!;
      await jobs.upsert({ ...current, description: "set concurrently" });
    }
  });
  t.after(remove);

  const updated = await store.updateJob(job.id, "alice", { name: "renamed" });
  assert.equal(updated?.name, "renamed");
  assert.equal(updated?.description, "set concurrently");
});

test("deleteJob removes the job and its due-index row", async (t) => {
  useClock(t);
  const { store, jobs, dueRows } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const other = await store.createJob(everyJob("alice"));

  assert.equal(await store.deleteJob(job.id, "alice"), true);
  assert.equal(await store.getJob(job.id, "alice"), null);
  assert.deepEqual(dueRows().map((r) => r.id), [other.id]);
  assert.equal(jobs.raw.all().length, 1);

  assert.equal(await store.deleteJob(job.id, "alice"), false);
  assert.equal(await store.deleteJob(other.id, "mallory"), false);
});

test("listJobs hides disabled jobs unless asked and orders by next run", async (t) => {
  useClock(t);
  const { store } = await setup();
  const later = await store.createJob(everyJob("alice", { schedule: { kind: "every", everyMs: 20 * MIN } }));
  const sooner = await store.createJob(everyJob("alice", { schedule: { kind: "every", everyMs: 5 * MIN } }));
  // Disabled through an update, which clears its next run.
  const off = await store.createJob(everyJob("alice"));
  await store.updateJob(off.id, "alice", { enabled: false });
  await store.createJob(everyJob("bob"));

  assert.deepEqual((await store.listJobs("alice")).map((j) => j.id), [sooner.id, later.id]);
  // The disabled job has no next run; Cosmos sorts undefined first.
  assert.deepEqual((await store.listJobs("alice", true)).map((j) => j.id), [off.id, sooner.id, later.id]);
});

// ============================================================================
// Claiming due jobs
// ============================================================================

test("getDueJobs claims only due, enabled jobs in the requested shard", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const { users, shard } = usersInOneShard(3);
  const due = await store.createJob(everyJob(users[0], { schedule: { kind: "every", everyMs: 5 * MIN } }));
  const notYet = await store.createJob(everyJob(users[1], { schedule: { kind: "every", everyMs: 10 * MIN } }));
  const disabled = await store.createJob(
    everyJob(users[2], { enabled: false, schedule: { kind: "every", everyMs: 5 * MIN } }),
  );

  const now = T0 + 5 * MIN;
  clock.set(now);
  const otherShard = (shard + 1) % getSchedulerShardCount();
  assert.deepEqual(await store.getDueJobs(now, otherShard), []);

  const claimed = await store.getDueJobs(now, shard);
  assert.deepEqual(claimed.map((j) => j.id), [due.id]);
  const [job] = claimed;
  assert.equal(job.state.runningAtMs, now);
  assert.equal(job.version, 2);
  assert.equal(job.state.runningStartedAtMs, undefined);

  // The claim is mirrored in the due index so the row stops matching.
  assert.equal(dueRow(due)?.runningToken, job.state.runningToken);
  assert.equal(dueRow(due)?.runningAtMs, now);
  assert.equal(dueRow(notYet)?.runningToken, undefined);
  assert.equal((await store.getJob(disabled.id, users[2]))?.state.runningToken, undefined);
});

test("a claimed job isn't claimed again until its claim goes stale", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const shard = getSchedulerShardForUser("alice");

  const now = T0 + 5 * MIN;
  clock.set(now);
  const first = await claim(store, job, now);
  assert.deepEqual(await store.getDueJobs(now, shard), []);
  assert.deepEqual(await store.getDueJobs(now + RUNNING_CLAIM_STALE_MS - 1, shard), []);

  // A crashed run: after the stale window another scheduler may take over.
  const later = now + RUNNING_CLAIM_STALE_MS + 1;
  clock.set(later);
  const second = await claim(store, job, later);
  assert.notEqual(second.state.runningToken, first.state.runningToken);
});

test("two schedulers racing for the same shard claim each job once", async (t) => {
  const clock = useClock(t);
  const { db, store } = await setup();
  const other = new CronStore(db);
  const { users, shard } = usersInOneShard(3);
  for (const user of users) await store.createJob(everyJob(user));

  const now = T0 + 5 * MIN;
  clock.set(now);
  const [a, b] = await Promise.all([store.getDueJobs(now, shard), other.getDueJobs(now, shard)]);
  const ids = [...a, ...b].map((j) => j.id).sort();
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
});

test("a claim loses cleanly when the job changes between read and replace (etag)", async (t) => {
  const clock = useClock(t);
  const { store, jobs, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const now = T0 + 5 * MIN;
  clock.set(now);

  let raced = false;
  const remove = jobs.raw.beforeOperation(async ({ op }) => {
    if (op === "replace" && !raced) {
      raced = true;
      const current = jobs.raw.peek<CronJob>(job.id, "alice")!;
      await jobs.upsert({ ...current, name: "edited concurrently" });
    }
  });
  t.after(remove);

  assert.deepEqual(await store.getDueJobs(now, getSchedulerShardForUser("alice")), []);
  const stored = await store.getJob(job.id, "alice");
  assert.equal(stored?.name, "edited concurrently");
  assert.equal(stored?.state.runningToken, undefined);
  assert.equal(dueRow(job)?.runningToken, undefined);
});

test("a due-index row for a deleted job is cleaned up at claim time", async (t) => {
  const clock = useClock(t);
  const { store, jobs, dueRows } = await setup();
  const job = await store.createJob(everyJob("alice"));
  await jobs.delete(job.id, "alice"); // bypass the store: the row is orphaned

  const now = T0 + 5 * MIN;
  clock.set(now);
  assert.deepEqual(await store.getDueJobs(now, getSchedulerShardForUser("alice")), []);
  assert.equal(dueRows().length, 0);
});

test("a due-index row in the wrong shard is moved to the job's shard instead of claimed", async (t) => {
  const clock = useClock(t);
  const { store, dueIndex, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const home = getSchedulerShardForUser("alice");
  const wrong = (home + 1) % getSchedulerShardCount();

  const row = dueRow(job)!;
  await dueIndex.delete(row.id, row.shardId);
  await dueIndex.create({ ...row, shardId: String(wrong) });

  const now = T0 + 5 * MIN;
  clock.set(now);
  assert.deepEqual(await store.getDueJobs(now, wrong), []);
  assert.equal(dueIndex.raw.peek(job.id, String(wrong)), undefined);
  assert.equal(dueRow(job)?.shardId, String(home));
  // And the job is claimable from its own shard.
  await claim(store, job, now);
});

test("an expired recurring job is disabled at claim time instead of running", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice", { expiresAt: T0 + 4 * MIN }));

  const now = T0 + 5 * MIN;
  clock.set(now);
  assert.deepEqual(await store.getDueJobs(now, getSchedulerShardForUser("alice")), []);
  const stored = await store.getJob(job.id, "alice");
  assert.equal(stored?.enabled, false);
  assert.equal(stored?.state.lastStatus, "expired");
  assert.equal(stored?.state.nextRunAtMs, undefined);
  assert.equal(dueRow(job), undefined);
});

test("beginClaimedRun starts a claimed run once, and only for the current token", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const now = T0 + 5 * MIN;
  clock.set(now);
  const claimed = await claim(store, job, now);

  assert.equal(await store.beginClaimedRun(job.id, "alice", "not-the-token"), null);
  const started = await store.beginClaimedRun(job.id, "alice", claimed.state.runningToken!);
  assert.equal(started?.state.runningStartedAtMs, now);
  assert.equal(await store.beginClaimedRun(job.id, "alice", claimed.state.runningToken!), null);
});

test("a force run can't take a job that is actively claimed; releasing the claim frees it", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const now = T0 + 5 * MIN;
  clock.set(now);
  const claimed = await claim(store, job, now);

  assert.equal(await store.claimJobForForceRun(job.id, "alice"), null);
  await store.releaseRunningClaim(job.id, "alice", "not-the-token");
  assert.equal((await store.getJob(job.id, "alice"))?.state.runningToken, claimed.state.runningToken);

  await store.releaseRunningClaim(job.id, "alice", claimed.state.runningToken!);
  assert.equal(dueRow(job)?.runningToken, undefined);
  const forced = await store.claimJobForForceRun(job.id, "alice");
  assert.ok(forced?.state.runningToken);
  assert.equal(dueRow(job)?.runningToken, forced.state.runningToken);
});

test("computeNextWakeMs returns the earliest unclaimed next run in the shard", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const { users, shard } = usersInOneShard(2);
  const soon = await store.createJob(everyJob(users[0], { schedule: { kind: "every", everyMs: 5 * MIN } }));
  await store.createJob(everyJob(users[1], { schedule: { kind: "every", everyMs: 15 * MIN } }));

  assert.equal(await store.computeNextWakeMs(shard), T0 + 5 * MIN - DELIVERY_LEAD_TIME_MS);
  const now = T0 + 5 * MIN;
  clock.set(now);
  await claim(store, soon, now);
  assert.equal(await store.computeNextWakeMs(shard), T0 + 15 * MIN - DELIVERY_LEAD_TIME_MS);
  assert.equal(await store.computeNextWakeMs((shard + 1) % getSchedulerShardCount()), undefined);
});

// ============================================================================
// applyResult
// ============================================================================

test("a one-shot job is deleted after a successful run", async (t) => {
  const clock = useClock(t);
  const { store, dueRows } = await setup();
  const job = await store.createJob(atJob("alice", T0 + 10 * MIN));
  const now = T0 + 10 * MIN;
  clock.set(now);
  const claimed = await claim(store, job, now);

  const { action } = await store.applyResult(
    claimed,
    { status: "ok", summary: "done", durationMs: 1200 },
    { runningToken: claimed.state.runningToken },
  );
  assert.equal(action, "deleted");
  assert.equal(await store.getJob(job.id, "alice"), null);
  assert.equal(dueRows().length, 0);
});

test("one-shot delivery failures retry with backoff up to the limit, then disable", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(atJob("alice", T0 + 10 * MIN));
  let now = T0 + 10 * MIN;
  const failure = { status: "error" as const, error: "Channel delivery failed: user offline", durationMs: 50 };

  for (let attempt = 1; attempt <= MAX_ONE_SHOT_DELIVERY_RETRIES; attempt++) {
    clock.set(now);
    const claimed = await claim(store, job, now);
    const { action } = await store.applyResult(claimed, failure, { runningToken: claimed.state.runningToken });
    assert.equal(action, "updated", `attempt ${attempt}`);

    const stored = (await store.getJob(job.id, "alice"))!;
    assert.equal(stored.enabled, true);
    assert.equal(stored.state.consecutiveErrors, attempt);
    assert.equal(stored.state.nextRunAtMs, now + getBackoffMs(attempt));
    assert.equal(stored.state.lastError, failure.error);
    assert.equal(stored.state.runningToken, undefined);
    assert.equal(dueRow(job)?.nextRunAtMs, now + getBackoffMs(attempt));
    assert.equal(dueRow(job)?.runningToken, undefined);
    // Not due again until the backoff has passed.
    assert.deepEqual(await store.getDueJobs(now + getBackoffMs(attempt) - 1, stored.shardId), []);
    now += getBackoffMs(attempt);
  }

  clock.set(now);
  const last = await claim(store, job, now);
  const { action } = await store.applyResult(last, failure, { runningToken: last.state.runningToken });
  assert.equal(action, "disabled");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.enabled, false);
  assert.equal(stored.state.consecutiveErrors, MAX_ONE_SHOT_DELIVERY_RETRIES + 1);
  assert.equal(stored.state.nextRunAtMs, undefined);
  assert.equal(dueRow(job), undefined);
});

test("a one-shot execution failure (not a delivery failure) disables at once", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(atJob("alice", T0 + 10 * MIN));
  const now = T0 + 10 * MIN;
  clock.set(now);
  const claimed = await claim(store, job, now);
  const { action } = await store.applyResult(
    claimed,
    { status: "error", error: "model timed out", durationMs: 5 },
    { runningToken: claimed.state.runningToken },
  );
  assert.equal(action, "disabled");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.enabled, false);
  assert.equal(stored.state.lastError, "model timed out");
  assert.equal(stored.state.lastStatus, "error");
  assert.equal(dueRow(job), undefined);
});

test("a recurring success schedules the next interval and clears the claim", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const claimAt = T0 + 5 * MIN - DELIVERY_LEAD_TIME_MS;
  clock.set(claimAt);
  const claimed = await claim(store, job, claimAt);

  // The run ends after the slot it was fired early for.
  const doneAt = T0 + 5 * MIN + 20_000;
  clock.set(doneAt);
  const { action } = await store.applyResult(
    claimed,
    { status: "ok", summary: "stretched", durationMs: 22_000 },
    { runningToken: claimed.state.runningToken },
  );
  assert.equal(action, "updated");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.enabled, true);
  assert.equal(stored.state.nextRunAtMs, T0 + 10 * MIN - DELIVERY_LEAD_TIME_MS);
  assert.equal(stored.state.lastRunAtMs, doneAt);
  assert.equal(stored.state.lastStatus, "ok");
  assert.equal(stored.state.runCount, 1);
  assert.equal(stored.state.consecutiveErrors, 0);
  assert.equal(stored.state.runningToken, undefined);
  assert.equal(stored.state.runningAtMs, undefined);
  assert.equal(dueRow(job)?.nextRunAtMs, T0 + 10 * MIN - DELIVERY_LEAD_TIME_MS);
  assert.equal(dueRow(job)?.runningToken, undefined);
  assert.equal(dueRow(job)?.jobVersion, stored.version);
});

// Regression (fixed): jobs are stored with nextRunAtMs = slot - DELIVERY_LEAD_TIME_MS so they
// fire early, but applyResult recomputes the next run from `now` with the
// same lead. A run that finishes inside the lead window (before the slot
// itself, e.g. a fast main-session enqueue or a noop) gets the *same* slot
// back as its next run, which is already in the past: the job is due again
// immediately and fires twice (or more) for one slot. Applies to "every" and
// "cron" schedules alike (computeJobNextRun in store.ts).
test("a recurring run that finishes inside the lead window is not rescheduled into the same slot", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const claimAt = T0 + 5 * MIN - DELIVERY_LEAD_TIME_MS;
  clock.set(claimAt);
  const claimed = await claim(store, job, claimAt);

  clock.set(claimAt + 500); // a 0.5s run, still before the 5-minute slot
  await store.applyResult(claimed, { status: "ok", durationMs: 500 }, { runningToken: claimed.state.runningToken });

  const stored = (await store.getJob(job.id, "alice"))!;
  assert.ok(
    stored.state.nextRunAtMs! > Date.now(),
    `next run ${new Date(stored.state.nextRunAtMs!).toISOString()} is not in the future`,
  );
  assert.deepEqual(await store.getDueJobs(Date.now(), stored.shardId), []);
});

test("recurring errors back off: next run is the later of the next slot and now + backoff", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const everyMs = getMinEveryMs(); // 3 minutes by default
  const job = await store.createJob(everyJob("alice", { schedule: { kind: "every", everyMs } }));
  const failure = { status: "error" as const, error: "model timed out", durationMs: 10 };

  let now = T0 + everyMs + 10_000;
  const expected: number[] = [];
  for (let errors = 1; errors <= 3; errors++) {
    clock.set(now);
    const claimed = await claim(store, job, now);
    await store.applyResult(claimed, failure, { runningToken: claimed.state.runningToken });
    const stored = (await store.getJob(job.id, "alice"))!;
    assert.equal(stored.state.consecutiveErrors, errors);
    assert.equal(stored.enabled, true);
    const nextSlot = T0 + Math.ceil((now - T0) / everyMs) * everyMs - DELIVERY_LEAD_TIME_MS;
    const expectedNext = Math.max(nextSlot, now + getBackoffMs(errors));
    assert.equal(stored.state.nextRunAtMs, expectedNext, `after ${errors} error(s)`);
    expected.push(expectedNext);
    now = expectedNext + 10_000;
  }
  // The first error keeps the natural schedule (30s backoff < 3m interval);
  // by the third the backoff (5m) is longer than the interval.
  assert.equal(getBackoffMs(3) > everyMs, true);

  clock.set(now);
  const claimed = await claim(store, job, now);
  await store.applyResult(claimed, { status: "ok", durationMs: 10 }, { runningToken: claimed.state.runningToken });
  const recovered = (await store.getJob(job.id, "alice"))!;
  assert.equal(recovered.state.consecutiveErrors, 0);
  assert.ok(recovered.state.nextRunAtMs! - now <= everyMs);
});

test("maxRuns disables the job after its last successful run", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice", { maxRuns: 2 }));
  const ok = { status: "ok" as const, durationMs: 10 };

  let now = T0 + 5 * MIN + 10_000;
  clock.set(now);
  let claimed = await claim(store, job, now);
  assert.equal((await store.applyResult(claimed, ok, { runningToken: claimed.state.runningToken })).action, "updated");
  // Errors don't count towards maxRuns.
  now = T0 + 10 * MIN + 10_000;
  clock.set(now);
  claimed = await claim(store, job, now);
  await store.applyResult(claimed, { status: "error", error: "x", durationMs: 1 }, { runningToken: claimed.state.runningToken });
  assert.equal((await store.getJob(job.id, "alice"))?.state.runCount, 1);

  now = (await store.getJob(job.id, "alice"))!.state.nextRunAtMs! + 10_000;
  clock.set(now);
  claimed = await claim(store, job, now);
  const { action } = await store.applyResult(claimed, ok, { runningToken: claimed.state.runningToken });
  assert.equal(action, "disabled");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.enabled, false);
  assert.equal(stored.state.runCount, 2);
  assert.equal(stored.state.runningToken, undefined);
  assert.equal(dueRow(job), undefined);
});

test("a result with disableJob turns the job off and records why", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const now = T0 + 5 * MIN + 10_000;
  clock.set(now);
  const claimed = await claim(store, job, now);
  const { action } = await store.applyResult(
    claimed,
    { status: "error", error: "Delivery refused: not linked", durationMs: 3, disableJob: true },
    { runningToken: claimed.state.runningToken },
  );
  assert.equal(action, "disabled");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.enabled, false);
  assert.equal(stored.state.lastStatus, "error");
  assert.equal(stored.state.lastError, "Delivery refused: not linked");
  assert.equal(stored.state.lastRunAtMs, now);
  assert.equal(stored.state.nextRunAtMs, undefined);
  assert.equal(dueRow(job), undefined);
});

// Regression (fixed): applyResult's expiry branch disables through updateJob({ enabled: false }),
// and updateJob validates expiry whenever `enabled` is patched, rejecting
// the (by definition past) expiresAt with "expiresAt must be in the future".
// So a job that expires while it runs throws instead of being disabled; the
// orchestrator then only releases the claim, and the run's result is lost
// until the next claim auto-disables it. The same check stops a user from
// disabling an already-expired job. Suggested fix (store.ts updateJob): only
// validate expiry when the updated job is enabled.
test("a recurring job that expires while running is disabled with lastStatus expired", async (t) => {
  const clock = useClock(t);
  const { store, dueRow } = await setup();
  const job = await store.createJob(everyJob("alice", { expiresAt: T0 + 6 * MIN }));
  const now = T0 + 5 * MIN;
  clock.set(now);
  const claimed = await claim(store, job, now);

  clock.set(T0 + 7 * MIN); // expired during the run
  const { action } = await store.applyResult(
    claimed,
    { status: "ok", durationMs: 2 * MIN },
    { runningToken: claimed.state.runningToken },
  );
  assert.equal(action, "disabled");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.enabled, false);
  assert.equal(stored.state.lastStatus, "expired");
  assert.equal(stored.state.runCount, 1);
  assert.equal(dueRow(job), undefined);
});

test("a result carrying a stale running token is ignored", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const job = await store.createJob(everyJob("alice"));
  let now = T0 + 5 * MIN;
  clock.set(now);
  const first = await claim(store, job, now);

  // The first run hangs; its claim goes stale and another run takes over.
  now += RUNNING_CLAIM_STALE_MS + 1;
  clock.set(now);
  const second = await claim(store, job, now);

  const { action } = await store.applyResult(
    first,
    { status: "error", error: "late failure", durationMs: 1 },
    { runningToken: first.state.runningToken },
  );
  assert.equal(action, "stale");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.state.runningToken, second.state.runningToken);
  assert.equal(stored.state.lastError, undefined);
  assert.equal(stored.state.consecutiveErrors, undefined);
});

test("applyResult for a job deleted mid-run reports it deleted and recreates nothing", async (t) => {
  const clock = useClock(t);
  const { store, jobs, dueRows } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const now = T0 + 5 * MIN;
  clock.set(now);
  const claimed = await claim(store, job, now);
  await store.deleteJob(job.id, "alice");

  const { action } = await store.applyResult(claimed, { status: "ok", durationMs: 1 }, {
    runningToken: claimed.state.runningToken,
  });
  assert.equal(action, "deleted");
  assert.equal(jobs.raw.all().length, 0);
  assert.equal(dueRows().length, 0);
});

// ============================================================================
// backfillDueIndex
// ============================================================================

test("backfillDueIndex indexes enabled jobs missing from the due index and is idempotent", async (t) => {
  useClock(t);
  const { store, dueIndex, dueRows } = await setup();
  const a = await store.createJob(everyJob("alice"));
  const b = await store.createJob(everyJob("bob", { schedule: { kind: "every", everyMs: 10 * MIN } }));
  await store.createJob(everyJob("carol", { enabled: false }));
  // Jobs from before the due index existed: drop their rows.
  dueIndex.raw.clear();

  assert.deepEqual(await store.backfillDueIndex(), { indexed: 2, failed: 0 });
  const snapshot = (rows: DueRow[]) =>
    rows
      .map(({ id, shardId, jobVersion, enabled, nextRunAtMs, userId }) => ({
        id,
        shardId,
        jobVersion,
        enabled,
        nextRunAtMs,
        userId,
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
  const first = snapshot(dueRows());
  assert.deepEqual(
    first.map((r) => r.id),
    [a.id, b.id].sort(),
  );
  const rowA = first.find((r) => r.id === a.id)!;
  assert.equal(rowA.shardId, String(getSchedulerShardForUser("alice")));
  assert.equal(rowA.nextRunAtMs, a.state.nextRunAtMs);

  assert.deepEqual(await store.backfillDueIndex(), { indexed: 2, failed: 0 });
  assert.deepEqual(snapshot(dueRows()), first);
});

test("backfillDueIndex counts a job it could not index as failed and carries on", async (t) => {
  useClock(t);
  const { store, dueIndex, dueRows } = await setup();
  const a = await store.createJob(everyJob("alice"));
  await store.createJob(everyJob("bob"));
  dueIndex.raw.clear();

  const remove = dueIndex.raw.beforeOperation(({ op, id }) => {
    if (op === "read" && id === a.id) throw Object.assign(new Error("Service Unavailable"), { code: 503 });
  });
  t.after(remove);
  assert.deepEqual(await store.backfillDueIndex(), { indexed: 1, failed: 1 });
  assert.equal(dueRows().length, 1);
});

// ============================================================================
// Run history
// ============================================================================

test("recordRun / getRuns return a job's runs newest first, limited", async (t) => {
  const clock = useClock(t);
  const { store } = await setup();
  const job = await store.createJob(everyJob("alice"));
  const other = await store.createJob(everyJob("alice"));
  for (let i = 0; i < 3; i++) {
    clock.set(T0 + i * MIN);
    await store.recordRun(job, { status: "ok", summary: `run ${i}`, durationMs: i });
  }
  await store.recordRun(other, { status: "error", error: "x", durationMs: 1 });

  const runs = await store.getRuns(job.id, 2);
  assert.deepEqual(runs.map((r) => r.summary), ["run 2", "run 1"]);
  assert.equal(runs[0].userId, "alice");
  assert.equal((await store.getRuns(job.id)).length, 3);
});

// ============================================================================
// Heartbeat events (main-session wakeMode="next-heartbeat")
// ============================================================================

test("heartbeat events are claimed once, retried after release, dead-lettered at the attempt cap", async (t) => {
  const clock = useClock(t);
  const { store, heartbeats } = await setup();
  const job = await store.createJob(
    everyJob("alice", {
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "check the oven" },
    }),
  );
  const shard = job.shardId;

  const event = await store.enqueueHeartbeatEvent(job, "  check the oven  ", T0, T0);
  assert.equal(event.text, "check the oven");
  assert.equal(event.shardId, String(shard));
  assert.equal(await store.countDueHeartbeatEventsForTarget(T0, shard, { userId: "alice" }, 10), 1);
  // Other targets don't see it.
  assert.equal(await store.countDueHeartbeatEventsForTarget(T0, shard, { userId: "bob" }, 10), 0);
  assert.equal(
    await store.countDueHeartbeatEventsForTarget(T0, shard, { userId: "alice", agentId: "other" }, 10),
    0,
  );

  const [claimed] = await store.claimDueHeartbeatEvents(T0, shard);
  assert.equal(claimed.id, event.id);
  assert.equal(claimed.attempts, 1);
  assert.deepEqual(await store.claimDueHeartbeatEvents(T0, shard), []);

  // Release: due again after the retry delay, not before.
  await store.releaseHeartbeatEventClaim(event.id, shard, claimed.runningToken!, 30_000, "busy");
  assert.deepEqual(await store.claimDueHeartbeatEvents(T0 + 29_000, shard), []);
  let now = T0 + 30_000;
  let current = claimed;
  for (let attempt = 2; attempt <= getHeartbeatMaxAttempts(); attempt++) {
    clock.set(now);
    [current] = await store.claimDueHeartbeatEvents(now, shard);
    assert.equal(current?.attempts, attempt);
    await store.releaseHeartbeatEventClaim(event.id, shard, current.runningToken!, 30_000, "busy");
    now += 30_000;
  }
  const deadLettered = heartbeats.raw.peek<CronHeartbeatEventDocument>(event.id, String(shard))!;
  assert.equal(typeof deadLettered.deadLetteredAtMs, "number");
  assert.match(deadLettered.deadLetterReason ?? "", /max-attempt-cutoff/);
  assert.deepEqual(await store.claimDueHeartbeatEvents(now + DAY, shard), []);
});

test("completing a heartbeat event needs its current claim token", async (t) => {
  useClock(t);
  const { store } = await setup();
  const job = await store.createJob(
    everyJob("alice", {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    }),
  );
  const event = await store.enqueueHeartbeatEvent(job, "ping", T0, T0);
  const [claimed] = await store.claimDueHeartbeatEvents(T0, job.shardId);

  await store.completeHeartbeatEvent(event.id, job.shardId, "not-the-token");
  assert.ok(await store.getHeartbeatEvent(event.id, job.shardId));
  await store.completeHeartbeatEvent(event.id, job.shardId, claimed.runningToken!);
  assert.equal(await store.getHeartbeatEvent(event.id, job.shardId), null);
});
