/**
 * AgentForEach Cron System — the scheduler alarm and cron runs
 *
 * One durable alarm per scheduler shard (see `@agentforeach/platform`'s
 * Durable port), instead of an in-process timer loop.
 *
 *   CronScheduler (alarm) — each tick:
 *     1. claim the shard's due jobs
 *     2. start a CronRun job for each (they run in parallel, each on its own)
 *     3. drain the shard's heartbeat queue
 *     4. return the earliest next run: the alarm sleeps until then, or until
 *        a cron change wakes it
 *
 *   CronRun (job) — execute one claimed job and record the result.
 *
 *   CronSchedulerHealthCheck (schedule) — keeps every shard's alarm running.
 */

import type { AlarmDefinition, HandlerContext, JobDefinition, ScheduleDef } from "@agentforeach/platform";
import { durable } from "../runtime/durable.js";
import type { CronJob, JobResult } from "./types.js";
import { getCronStore, type CronRunBlock, type CronStore } from "./store.js";
import { executeJob, getExecutorConfig, processHeartbeatQueue } from "./executor.js";
import {
  FALLBACK_WAKE_INTERVAL_MS,
  getMaxDueJobsPerTick,
  RUNNING_CLAIM_STALE_MS,
  HEALTH_CHECK_SCHEDULE,
  getSchedulerShardCount,
  normalizeSchedulerShardId,
  getSchedulerInstanceId,
} from "./config.js";

/** The durable alarm kind for a scheduler shard. */
export const CRON_SCHEDULER_KIND = "CronScheduler";
/** The durable job kind that runs one claimed cron job. */
export const CRON_RUN_KIND = "CronRun";

/** At capacity, when to check again if no finishing run wakes the shard first. */
const AT_CAPACITY_RECHECK_MS = 30_000;

/** How often a running job renews its claim: well inside the stale window. */
const CLAIM_RENEW_INTERVAL_MS = Math.max(1_000, Math.min(60_000, Math.floor(RUNNING_CLAIM_STALE_MS / 4)));

type SchedulerShardInput = {
  shardId?: number;
};

// ============================================================================
// Cron runs
// ============================================================================

/**
 * The durable job id of a claimed job's run: one per claim, so starting it
 * again for the same claim (a repeated tick, a retried force-run request) is
 * a duplicate, not a second run.
 */
export function cronRunInstanceId(job: Pick<CronJob, "id" | "state">, prefix: "cron-run" | "force-run" = "cron-run"): string {
  return `${prefix}-${job.id}-${job.state.runningToken ?? "unclaimed"}`;
}

/** Why a run didn't start, for its run record and log line. */
const RUN_BLOCK_MESSAGES: Record<CronRunBlock, string> = {
  disabled: "not run: the job was turned off after this run was queued",
  expired: "not run: the job had expired",
  "max-runs": "not run: the job had used up its maxRuns",
};

/** Renew a run's claim every `intervalMs` until the returned function is called. */
export function renewClaimWhileRunning(
  store: Pick<CronStore, "renewRunningClaim">,
  job: Pick<CronJob, "id" | "userId">,
  runningToken: string,
  intervalMs = CLAIM_RENEW_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    store.renewRunningClaim(job.id, job.userId, runningToken).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Execute a single claimed job and record the result.
 *
 * This is the workhorse — calls the model, records run history, applies
 * result to job state (backoff, disable, delete).
 */
export async function executeAndRecordJob(
  job: CronJob,
  /** For tests: how a job executes, and how often its claim is renewed. */
  deps: { execute?: typeof executeJob; renewEveryMs?: number } = {},
): Promise<JobResult> {
  const store = getCronStore();
  const startMs = Date.now();
  const runningToken = job.state.runningToken;
  if (!runningToken) {
    return {
      status: "skipped",
      error: "duplicate-suppressed: missing running claim token",
      durationMs: Date.now() - startMs,
    };
  }

  // Revalidated on the current job, not this snapshot: the job may have been
  // edited, paused or deleted while the run was queued. A paused job only
  // runs if it was already paused when claimed (a force-run of a paused job).
  const start = await store.beginClaimedRun(job.id, job.userId, runningToken, { requireEnabled: job.enabled });
  if (start.status === "skipped") {
    if (start.reason === "claim-lost") {
      return {
        status: "skipped",
        error: "duplicate-suppressed: claim no longer valid",
        durationMs: Date.now() - startMs,
      };
    }
    const skipped: JobResult = {
      status: "skipped",
      error: RUN_BLOCK_MESSAGES[start.reason],
      durationMs: Date.now() - startMs,
    };
    try {
      await store.recordRun(start.job, skipped);
    } catch {
      // Best-effort write, as for a run that executed.
    }
    return skipped;
  }
  const started = start.job;

  // A run may take longer than the claim's stale window: renew the claim
  // while it runs, so no tick claims the job again for a second run.
  const stopRenewing = renewClaimWhileRunning(store, job, runningToken, deps.renewEveryMs);

  let result: JobResult;
  try {
    const config = getExecutorConfig();
    result = await (deps.execute ?? executeJob)(started, config);
  } catch (err) {
    result = {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startMs,
    };
  } finally {
    stopRenewing();
  }

  try {
    await store.recordRun(started, result);
  } catch {
    // Best-effort write; avoid changing execution semantics on storage issues.
  }

  try {
    await store.applyResult(started, result, { runningToken });
  } catch {
    // Best-effort state transition; if this fails, release claim to avoid long stale block.
    try {
      await store.releaseRunningClaim(started.id, started.userId, runningToken);
    } catch {
      // Ignore recovery failures.
    }
  }

  return result;
}

/**
 * A claimed job, run once. Starts from the scheduler tick and from force-run.
 *
 * Afterwards it wakes the job's shard: the tick that started this run
 * computed its next wake while the job was still claimed (claimed jobs don't
 * count), so without the wake a recurring job's next run would wait for
 * another job's wake or the fallback interval.
 */
export const cronRunJob: JobDefinition<CronJob> = {
  kind: CRON_RUN_KIND,
  async run(job, context) {
    const result = await executeAndRecordJob(job);
    const why = result.status === "skipped" && result.error ? ` (${result.error})` : "";
    context.log(`[cron] run job=${job.id} status=${result.status}${why} duration=${result.durationMs ?? 0}ms`);
    const shardCount = getSchedulerShardCount();
    const instanceId = getSchedulerInstanceId(normalizeSchedulerShardId(job.shardId, shardCount), shardCount);
    try {
      await durable().wakeAlarm(instanceId);
    } catch (err) {
      context.warn(`[cron] could not wake ${instanceId} after job=${job.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/**
 * "Run now": claim the job as the scheduler does and start its run, named
 * by the claim (`force-run-<jobId>-<token>`). The run revalidates the job
 * when it starts, like a scheduled one. Null when the job is missing or
 * already claimed: a run in flight, or this same request retried. A run that
 * can't be started releases its claim, so the job isn't blocked until the
 * claim goes stale.
 */
export async function startForceRun(
  jobId: string,
  userId: string,
): Promise<{ job: CronJob; instanceId: string } | null> {
  const store = getCronStore();
  const claimed = await store.claimJobForForceRun(jobId, userId);
  const runningToken = claimed?.state.runningToken;
  if (!claimed || !runningToken) return null;
  const instanceId = cronRunInstanceId(claimed, "force-run");
  try {
    await durable().startJob(CRON_RUN_KIND, claimed, instanceId);
  } catch (err) {
    await store.releaseRunningClaim(claimed.id, claimed.userId, runningToken).catch(() => undefined);
    throw err;
  }
  return { job: claimed, instanceId };
}

// ============================================================================
// The scheduler alarm
// ============================================================================

/**
 * One tick of a shard's scheduler: claim its due jobs (claims are what stop
 * a job running twice), start a CronRun for each, drain its heartbeat queue,
 * and return when the next job is due. With nothing scheduled, it checks
 * again after FALLBACK_WAKE_INTERVAL_MS; a cron change wakes it sooner.
 */
export async function schedulerTick(input: SchedulerShardInput): Promise<number> {
  const shardId = normalizeSchedulerShardId(input?.shardId);
  const store = getCronStore();
  // Runs are separate jobs, so the tick doesn't wait for them: cap how many
  // a shard has going at once (one tick's worth, as when the tick waited).
  const room = getMaxDueJobsPerTick() - (await store.countInFlightRuns(Date.now(), shardId));
  const due = await store.getDueJobs(Date.now(), shardId, Math.max(0, room));
  // Each run is its own job: one slow model call can't hold up the tick or
  // the other runs. The id carries the claim, so a repeated tick can't start
  // the same claimed run twice.
  // A run that can't be started (e.g. throttled) doesn't stop the others;
  // its claim is released, so the next tick can claim it again.
  const starts = await Promise.allSettled(
    due.map((job) => durable().startJob(CRON_RUN_KIND, job, cronRunInstanceId(job))),
  );
  await Promise.all(
    starts.map(async (start, i) => {
      if (start.status === "fulfilled") return;
      const job = due[i];
      console.warn(`[cron] could not start run for job=${job.id}: ${String(start.reason)}`);
      if (job.state.runningToken) {
        await store.releaseRunningClaim(job.id, job.userId, job.state.runningToken).catch(() => undefined);
      }
    }),
  );
  await processHeartbeatQueue(shardId);
  const nextMs = await store.computeNextWakeMs(shardId);
  const next = nextMs && nextMs > 0 ? nextMs : Date.now() + FALLBACK_WAKE_INTERVAL_MS;
  // At capacity, more jobs may already be due: wait for a run to finish (each
  // wakes its shard) instead of ticking again at once, with a recheck as backstop.
  return room <= due.length ? Math.max(next, Date.now() + AT_CAPACITY_RECHECK_MS) : next;
}

export const cronSchedulerAlarm: AlarmDefinition<SchedulerShardInput> = {
  kind: CRON_SCHEDULER_KIND,
  tick: (input) => schedulerTick(input),
};

// ============================================================================
// Health Check — Ensures Every Shard's Scheduler is Running
// ============================================================================

/**
 * Tell a shard's scheduler its jobs changed: wake it to re-evaluate its next
 * tick, or start it if it isn't running (a fresh deployment, or one that
 * stopped), so a job due before the next health check still runs on time.
 * A start that loses a race to another caller is fine.
 */
export async function wakeOrStartScheduler(
  shardId: number,
  shardCount = getSchedulerShardCount(),
): Promise<"woken" | "started" | "running" | "suspended"> {
  const instanceId = getSchedulerInstanceId(shardId, shardCount);
  if (await durable().wakeAlarm(instanceId)) return "woken";
  return durable().ensureAlarm(CRON_SCHEDULER_KIND, instanceId, { shardId });
}

/**
 * Every 5 minutes, start any shard's scheduler that isn't running: on first
 * deployment, after a restart, or after an unexpected stop.
 */
export const schedules: ScheduleDef[] = [];

schedules.push({
  name: "CronSchedulerHealthCheck",
  schedule: HEALTH_CHECK_SCHEDULE,
  durable: true,
  handler: async (ctx: HandlerContext) => {
    const shardCount = getSchedulerShardCount();
    for (let shardId = 0; shardId < shardCount; shardId += 1) {
      const instanceId = getSchedulerInstanceId(shardId, shardCount);
      try {
        const result = await durable().ensureAlarm(CRON_SCHEDULER_KIND, instanceId, { shardId });
        if (result === "started") ctx.log(`CronScheduler shard=${shardId} wasn't running; started.`);
      } catch (err) {
        ctx.error(`Health check failed for shard=${shardId}:`, err);
      }
    }
  },
});
