/**
 * AgentForEach Cron System — Durable Functions Orchestrator & Activities
 *
 * An eternal orchestration per scheduler shard, instead of an in-process
 * timer loop.
 *
 * Architecture:
 *   CronScheduler (orchestrator) — eternal loop:
 *     1. GetDueJobs activity → query Cosmos DB
 *     2. Fan-out ExecuteAndRecordJob activities → parallel execution
 *     3. ComputeNextWake activity → earliest next run
 *     4. createTimer(nextWake) | waitForExternalEvent("jobsChanged")
 *     5. continueAsNew → bounded history
 *
 *   SchedulerHealthCheck (timer trigger) — ensures orchestrator is alive
 */

import * as df from "durable-functions";
import { app, type InvocationContext, type Timer } from "@azure/functions";
import type { CronJob, JobResult } from "./types.js";
import { getCronStore } from "./store.js";
import { executeJob, getExecutorConfig, processHeartbeatQueue } from "./executor.js";
import {
  FALLBACK_WAKE_INTERVAL_MS,
  MAX_DURABLE_TIMER_MS,
  HEALTH_CHECK_SCHEDULE,
  JOBS_CHANGED_EVENT,
  getSchedulerShardCount,
  normalizeSchedulerShardId,
  getSchedulerInstanceId,
} from "./config.js";

type SchedulerShardInput = {
  shardId?: number;
};

// ============================================================================
// Activities
// ============================================================================

/**
 * Activity: Query Cosmos DB for all jobs that are due to run.
 */
df.app.activity("GetDueJobs", {
  handler: async (input?: SchedulerShardInput): Promise<CronJob[]> => {
    const shardId = normalizeSchedulerShardId(input?.shardId);
    const store = getCronStore();
    return store.getDueJobs(Date.now(), shardId);
  },
});

/**
 * Activity: Execute a single job and record the result.
 *
 * This is the workhorse — calls OpenAI, records run history, applies
 * result to job state (backoff, disable, delete).
 */
df.app.activity("ExecuteAndRecordJob", {
  handler: async (job: CronJob): Promise<JobResult> => {
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

    const started = await store.beginClaimedRun(job.id, job.userId, runningToken);
    if (!started) {
      return {
        status: "skipped",
        error: "duplicate-suppressed: claim no longer valid",
        durationMs: Date.now() - startMs,
      };
    }

    let result: JobResult;
    try {
      const config = getExecutorConfig();
      result = await executeJob(started, config);
    } catch (err) {
      result = {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      };
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
  },
});

/**
 * Activity: Compute the next wake time across all scheduled jobs.
 * Returns epoch ms of the earliest due job, or 0 if no jobs exist.
 */
df.app.activity("ComputeNextWake", {
  handler: async (input?: SchedulerShardInput): Promise<number> => {
    const shardId = normalizeSchedulerShardId(input?.shardId);
    const store = getCronStore();
    const nextMs = await store.computeNextWakeMs(shardId);
    return nextMs ?? 0;
  },
});

/**
 * Activity: Drain queued wakeMode="next-heartbeat" events for a shard.
 */
df.app.activity("ProcessHeartbeatQueue", {
  handler: async (input?: SchedulerShardInput): Promise<{ processed: number; groups: number }> => {
    const shardId = normalizeSchedulerShardId(input?.shardId);
    return processHeartbeatQueue(shardId);
  },
});

/**
 * One-shot orchestration for async force-run.
 *
 * Runs ExecuteAndRecordJob as an activity and signals the scheduler
 * when done. This avoids tying up an HTTP request for the full
 * execution duration.
 */
df.app.orchestration("CronForceRunExecution", function* (ctx: df.OrchestrationContext) {
  const oc = ctx.df;
  const job: CronJob = oc.getInput() as CronJob;

  yield oc.callActivity("ExecuteAndRecordJob", job);

  // Signal scheduler to re-evaluate wake time after the run completes.
  // This is done inside the orchestration so it fires even if the
  // original HTTP caller has already received their 202 response.
  const shardId = normalizeSchedulerShardId(
    typeof job.shardId === "number" ? job.shardId : 0,
  );
  yield oc.callActivity("SignalJobsChanged", { shardId });
});

/**
 * Activity: Signal scheduler that jobs have changed.
 * Separated into an activity so it can be called from orchestrations.
 */
df.app.activity("SignalJobsChanged", {
  handler: async (_input?: SchedulerShardInput): Promise<void> => {
    // Durable client is not available inside activities, so we import
    // the Durable Functions SDK and use the management client directly.
    // However, activity functions don't have a durable client context.
    // Instead, we rely on the scheduler's own next-wake re-evaluation:
    // the applyResult inside ExecuteAndRecordJob already updates the
    // job state (nextRunAtMs), and the scheduler will pick it up on
    // its next iteration. The signal from the HTTP handler (already
    // sent before the 202) handles immediate wake. This activity is
    // a no-op placeholder for future enhancement if needed.
  },
});

// ============================================================================
// Orchestrator — Eternal Scheduler Loop
// ============================================================================

/**
 * The core scheduler orchestration.
 *
 * This is an "eternal orchestration" — it loops forever using continueAsNew()
 * to prevent unbounded history growth. Each iteration:
 *
 * 1. Gets all due jobs from Cosmos DB
 * 2. Fans out execution across due jobs (parallel)
 * 3. Computes when to wake next
 * 4. Sleeps until the next job is due OR a "jobsChanged" signal arrives
 * 5. Calls continueAsNew() to reset history
 *
 * Wakes with exact createTimer() calls, not a fixed polling interval.
 */
df.app.orchestration("CronScheduler", function* (ctx: df.OrchestrationContext) {
  const oc = ctx.df;
  const input = (oc.getInput() as SchedulerShardInput | undefined) ?? {};
  const shardId = normalizeSchedulerShardId(input.shardId);

  // 1. Get due jobs
  const dueJobs: CronJob[] = yield oc.callActivity("GetDueJobs", { shardId });

  // 2. Execute due jobs AND flush heartbeat queue in parallel.
  //    Previously heartbeat processing was gated behind job execution,
  //    meaning one slow OpenAI call could stall all heartbeat delivery.
  //    Running them concurrently ensures heartbeats are delivered promptly
  //    even when job execution is slow.
  {
    const parallelTasks: ReturnType<typeof oc.callActivity>[] = [];

    if (dueJobs.length > 0) {
      for (const job of dueJobs) {
        parallelTasks.push(oc.callActivity("ExecuteAndRecordJob", job));
      }
    }

    // Heartbeat flush runs alongside job execution, not after it.
    parallelTasks.push(oc.callActivity("ProcessHeartbeatQueue", { shardId }));

    if (parallelTasks.length > 0) {
      yield oc.Task.all(parallelTasks);
    }
  }

  // 3. Compute next wake time
  const nextWakeMs: number = yield oc.callActivity("ComputeNextWake", { shardId });

  // 4. Sleep until next job is due, or wake on external signal
  //    - If we have a scheduled job: sleep until its fire time
  //    - If no jobs: sleep for FALLBACK_WAKE_INTERVAL_MS (5 min)
  //    - Either way, a "jobsChanged" event will wake us early
  //
  // IMPORTANT: JS Durable timers are limited to 6 days.
  // Cap the wake time to avoid exceeding the limit.
  const nowMs = oc.currentUtcDateTime.getTime();
  const desiredWakeMs =
    nextWakeMs > 0 ? nextWakeMs : nowMs + FALLBACK_WAKE_INTERVAL_MS;
  const cappedWakeMs = Math.min(desiredWakeMs, nowMs + MAX_DURABLE_TIMER_MS);
  const wakeTime = new Date(cappedWakeMs);

  const timerTask = oc.createTimer(wakeTime);
  const eventTask = oc.waitForExternalEvent(JOBS_CHANGED_EVENT);
  yield oc.Task.any([timerTask, eventTask]);

  // Cancel the timer if the event won — required by Durable Functions:
  // "All pending timers must be completed or canceled for an orchestration to complete."
  if (!timerTask.isCompleted) {
    timerTask.cancel();
  }

  // 5. Continue as new — prevents unbounded orchestration history.
  // Preserve shard identity across iterations; otherwise non-zero shard
  // instances would drift to shard 0 after the first cycle.
  oc.continueAsNew({ shardId });
});

// ============================================================================
// Health Check — Ensures Scheduler is Always Running
// ============================================================================

/**
 * Timer trigger that fires every 5 minutes.
 * Ensures the CronScheduler orchestration is alive — restarts it if
 * it was terminated, completed, or never started.
 *
 * This handles:
 * - First deployment (no instance exists yet)
 * - Function App restarts / cold starts
 * - Unexpected orchestration termination
 */
app.timer("CronSchedulerHealthCheck", {
  schedule: HEALTH_CHECK_SCHEDULE,
  extraInputs: [df.input.durableClient()],
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    const client = df.getClient(ctx);
    const shardCount = getSchedulerShardCount();

    for (let shardId = 0; shardId < shardCount; shardId += 1) {
      const instanceId = getSchedulerInstanceId(shardId, shardCount);
      try {
        const status = await client.getStatus(instanceId);
        const runtimeStatus = status?.runtimeStatus;

        if (
          !runtimeStatus ||
          runtimeStatus === "Completed" ||
          runtimeStatus === "Terminated" ||
          runtimeStatus === "Failed"
        ) {
          ctx.log(
            `CronScheduler shard=${shardId} status=${runtimeStatus ?? "not found"}; starting.`,
          );
          await client.startNew("CronScheduler", {
            instanceId,
            input: { shardId },
          });
        }
      } catch (err) {
        ctx.error(`Health check failed for shard=${shardId}:`, err);
        // Try to start anyway.
        try {
          await client.startNew("CronScheduler", {
            instanceId,
            input: { shardId },
          });
        } catch {
          // Instance may already exist or be starting.
        }
      }
    }
  },
});
