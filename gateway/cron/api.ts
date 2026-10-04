/**
 * AgentForEach Cron System — HTTP API Triggers
 *
 * REST API for managing cron jobs. All write operations signal the
 * CronScheduler orchestrator to re-evaluate next wake time.
 *
 * Routes:
 *   POST   /cron/jobs       — Create a job
 *   GET    /cron/jobs       — List jobs for a user
 *   GET    /cron/jobs/{id}  — Get a single job
 *   PATCH  /cron/jobs/{id}  — Update a job
 *   DELETE /cron/jobs/{id}  — Delete a job
 *   POST   /cron/jobs/{id}/run — Force-run a job
 *   GET    /cron/runs/{id}  — Get run history for a job
 *   GET    /cron/status     — Scheduler status
 *   POST   /cron/start      — Start/restart the scheduler
 */

import type { HandlerContext, HttpRequestLike, HttpResult, RouteDef } from "@agentforeach/platform";
import { durable } from "../runtime/durable.js";
import { CRON_RUN_KIND, CRON_SCHEDULER_KIND, wakeOrStartScheduler } from "./orchestrator.js";
import type { DurableStatus, InstanceInfo } from "@agentforeach/platform";
import { getCronStore, hasActiveRunningClaim } from "./store.js";
import {
  getSchedulerInstanceId,
  getSchedulerShardCount,
  getSchedulerShardForUser,
  normalizeSchedulerShardId,
} from "./config.js";
import type { CronJobCreate, CronJobPatch } from "./types.js";
import { isAdmin, resolveAuthContext } from "../auth/index.js";
import { INVALID_SESSION_ID_MESSAGE, isValidSessionId } from "../sessions/ids.js";
import { sanitizeUserCronPatch } from "./api-guards.js";
import { stripServerOnlyDeliveryFields } from "./recipient-policy.js";
import { getScopedRateLimiter } from "../ratelimit/index.js";

// ============================================================================
// Helpers
// ============================================================================

function jsonResponse(body: unknown, status = 200): HttpResult {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function errorResponse(message: string, status: number): HttpResult {
  return jsonResponse({ error: message }, status);
}

async function getUserId(req: HttpRequestLike): Promise<string | null> {
  const auth = await resolveAuthContext(req);
  return auth?.userId ?? null;
}

/** 401 without a user, 403 without the admin role, null when allowed. */
async function requireAdmin(req: HttpRequestLike): Promise<HttpResult | null> {
  const auth = await resolveAuthContext(req);
  if (!auth) return errorResponse("Unauthorized", 401);
  if (!isAdmin(auth)) return errorResponse("Forbidden: requires the admin role", 403);
  return null;
}

/**
 * Wake the scheduler shard(s) whose jobs changed, starting any that isn't
 * running (wakeOrStartScheduler).
 */
async function signalJobsChanged(
  ctx: HandlerContext,
  opts?: { userId?: string; shardId?: number },
): Promise<void> {
  const shardCount = getSchedulerShardCount();
  const signal = async (shardId: number) => {
    try {
      const result = await wakeOrStartScheduler(shardId, shardCount);
      if (result === "started") ctx.log(`CronScheduler shard=${shardId} wasn't running; started.`);
    } catch (err) {
      // The health check starts it on its next cycle.
      ctx.warn(`Couldn't signal the scheduler for shard=${shardId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (typeof opts?.shardId === "number") return signal(normalizeSchedulerShardId(opts.shardId, shardCount));
  if (opts?.userId) return signal(getSchedulerShardForUser(opts.userId, shardCount));
  await Promise.all(Array.from({ length: shardCount }, (_, shardId) => signal(shardId)));
}

/** Status names in the cron admin API (they predate the durable port). */
const STATUS_NAMES: Record<DurableStatus, string> = {
  pending: "Pending",
  running: "Running",
  suspended: "Suspended",
  completed: "Completed",
  failed: "Failed",
  terminated: "Terminated",
};

function describeShard(shardId: number, instanceId: string, info: InstanceInfo | null) {
  return {
    shardId,
    instanceId,
    runtimeStatus: info ? STATUS_NAMES[info.status] : "NotFound",
    createdTime: info?.createdAt,
    lastUpdatedTime: info?.updatedAt,
  };
}

// ============================================================================
// POST /cron/jobs — Create a job
// ============================================================================

/** The /cron/* routes; served unless the API is turned off (cron.enabled=false, see `isCronApiEnabled`). */
export const routes: RouteDef[] = [];

routes.push({
  name: "cronCreateJob",
  methods: ["POST"],
  route: "cron/jobs",
  durable: true,
  handler: async (req: HttpRequestLike, ctx: HandlerContext) => {
    const userId = await getUserId(req);
    if (!userId) return errorResponse("Unauthorized", 401);

    let body: Partial<CronJobCreate>;
    try {
      body = (await req.json()) as Partial<CronJobCreate>;
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const payloadAny = body.payload as Record<string, unknown> | undefined;
    const hasPayloadText =
      typeof payloadAny?.message === "string" ||
      typeof payloadAny?.text === "string";

    if (!body.name || !body.schedule || !hasPayloadText) {
      return errorResponse(
        "Required fields: name, schedule, payload.message|payload.text",
        400,
      );
    }

    const store = getCronStore();
    let job;
    if (body.sessionId !== undefined && !isValidSessionId(body.sessionId)) {
      return errorResponse(INVALID_SESSION_ID_MESSAGE, 400);
    }

    try {
      job = await store.createJob({
        userId,
        name: body.name,
        description: body.description,
        enabled: body.enabled ?? true,
        deleteAfterRun: body.deleteAfterRun,
        schedule: body.schedule,
        sessionTarget: body.sessionTarget ?? "isolated",
        wakeMode: body.wakeMode ?? "now",
        agentId: body.agentId,
        sessionId: body.sessionId,
        payload: body.payload as CronJobCreate["payload"],
        delivery: stripServerOnlyDeliveryFields(body.delivery),
        expiresAt: body.expiresAt,
        maxRuns: body.maxRuns,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create cron job";
      const status = /limit exceeded/i.test(message) ? 429 : 400;
      return errorResponse(message, status);
    }

    await signalJobsChanged(ctx, { userId });
    return jsonResponse(job, 201);
  },
});

// ============================================================================
// GET /cron/jobs — List jobs
// ============================================================================

routes.push({
  name: "cronListJobs",
  methods: ["GET"],
  route: "cron/jobs",
  handler: async (req: HttpRequestLike) => {
    const userId = await getUserId(req);
    if (!userId) return errorResponse("Unauthorized", 401);

    const includeDisabled = req.query.get("includeDisabled") === "true";
    const store = getCronStore();
    const jobs = await store.listJobs(userId, includeDisabled);

    return jsonResponse({ jobs, count: jobs.length });
  },
});

// ============================================================================
// GET /cron/jobs/{id} — Get a single job
// ============================================================================

routes.push({
  name: "cronGetJob",
  methods: ["GET"],
  route: "cron/jobs/{id}",
  handler: async (req: HttpRequestLike) => {
    const userId = await getUserId(req);
    if (!userId) return errorResponse("Unauthorized", 401);

    const jobId = req.params.id;
    if (!jobId) return errorResponse("Missing job id", 400);

    const store = getCronStore();
    const job = await store.getJob(jobId, userId);
    if (!job) return errorResponse("Job not found", 404);

    return jsonResponse({
      ...job,
      running: hasActiveRunningClaim(job),
    });
  },
});

// ============================================================================
// PATCH /cron/jobs/{id} — Update a job
// ============================================================================

routes.push({
  name: "cronUpdateJob",
  methods: ["PATCH"],
  route: "cron/jobs/{id}",
  durable: true,
  handler: async (req: HttpRequestLike, ctx: HandlerContext) => {
    const userId = await getUserId(req);
    if (!userId) return errorResponse("Unauthorized", 401);

    const jobId = req.params.id;
    if (!jobId) return errorResponse("Missing job id", 400);

    let patch: CronJobPatch;
    try {
      const sanitized = sanitizeUserCronPatch(await req.json());
      if (!sanitized.ok) return errorResponse(sanitized.error, 400);
      patch = sanitized.patch;
    } catch {
      return errorResponse("Invalid JSON body", 400);
    }

    const store = getCronStore();
    let updated;
    try {
      updated = await store.updateJob(jobId, userId, patch);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update cron job";
      if (/contention/i.test(message)) {
        return errorResponse(message, 409);
      }
      throw err;
    }
    if (!updated) return errorResponse("Job not found", 404);

    await signalJobsChanged(ctx, { userId });
    return jsonResponse(updated);
  },
});

// ============================================================================
// DELETE /cron/jobs/{id} — Delete a job
// ============================================================================

routes.push({
  name: "cronDeleteJob",
  methods: ["DELETE"],
  route: "cron/jobs/{id}",
  durable: true,
  handler: async (req: HttpRequestLike, ctx: HandlerContext) => {
    const userId = await getUserId(req);
    if (!userId) return errorResponse("Unauthorized", 401);

    const jobId = req.params.id;
    if (!jobId) return errorResponse("Missing job id", 400);

    const store = getCronStore();
    const deleted = await store.deleteJob(jobId, userId);
    if (!deleted) return errorResponse("Job not found", 404);

    await signalJobsChanged(ctx, { userId });
    return jsonResponse({ deleted: true });
  },
});

// ============================================================================
// POST /cron/jobs/{id}/run — Force-run a job immediately
// ============================================================================

routes.push({
  name: "cronForceRun",
  methods: ["POST"],
  route: "cron/jobs/{id}/run",
  durable: true,
  handler: async (req: HttpRequestLike, ctx: HandlerContext) => {
    const userId = await getUserId(req);
    if (!userId) return errorResponse("Unauthorized", 401);

    const jobId = req.params.id;
    if (!jobId) return errorResponse("Missing job id", 400);

    const store = getCronStore();
    const job = await store.getJob(jobId, userId);
    if (!job) return errorResponse("Job not found", 404);

    // "Run now" still respects the job's own limits.
    if (typeof job.expiresAt === "number" && job.expiresAt <= Date.now()) {
      return errorResponse("Job has expired", 409);
    }
    if (typeof job.maxRuns === "number" && job.maxRuns > 0 && (job.state.runCount ?? 0) >= job.maxRuns) {
      return errorResponse("Job has reached its maxRuns", 409);
    }

    const limit = await getScopedRateLimiter("forceRun").check(userId);
    if (!limit.allowed) {
      const refused = errorResponse(`Too many runs requested. Try again in ${limit.retryAfterSeconds} seconds.`, 429);
      return { ...refused, headers: { ...(refused.headers as Record<string, string>), "Retry-After": String(limit.retryAfterSeconds) } };
    }

    const claimed = await store.claimJobForForceRun(jobId, userId);
    if (!claimed || !claimed.state.runningToken) {
      return errorResponse("Job is already running. Try again later.", 409);
    }

    // Dispatch execution to a durable job.
    // Returns 202 immediately — the caller polls GET /cron/runs/{id}
    // to check the result. No HTTP request has to stay open for a
    // long-running job.
    const instanceId = `force-run-${claimed.id}-${Date.now()}`;
    await durable().startJob(CRON_RUN_KIND, claimed, instanceId);

    // Signal scheduler early so it recomputes wake times.
    await signalJobsChanged(ctx, { userId });

    return jsonResponse(
      {
        jobId: claimed.id,
        status: "accepted",
        message: "Force-run dispatched. Poll GET /cron/runs/{id} for results.",
        orchestrationId: instanceId,
      },
      202,
    );
  },
});

// ============================================================================
// GET /cron/runs/{id} — Get run history for a job
// ============================================================================

routes.push({
  name: "cronGetRuns",
  methods: ["GET"],
  route: "cron/runs/{id}",
  handler: async (req: HttpRequestLike) => {
    const userId = await getUserId(req);
    if (!userId) return errorResponse("Unauthorized", 401);

    const jobId = req.params.id;
    if (!jobId) return errorResponse("Missing job id", 400);

    // Verify the caller owns this job before exposing run history
    const store = getCronStore();
    const job = await store.getJob(jobId, userId);
    if (!job) return errorResponse("Job not found", 404);

    const limitParam = req.query.get("limit");
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    const runs = await store.getRuns(jobId, userId, limit);

    return jsonResponse({ runs, count: runs.length });
  },
});

// ============================================================================
// GET /cron/status — Scheduler status
// ============================================================================

routes.push({
  name: "cronStatus",
  methods: ["GET"],
  route: "cron/status",
  durable: true,
  handler: async (_req: HttpRequestLike, ctx: HandlerContext) => {
    // Global scheduler state across every user's shard: operators only.
    const denied = await requireAdmin(_req);
    if (denied) return denied;

    const shardCount = getSchedulerShardCount();
    const shardParam = _req.query.get("shardId");
    const statusOf = async (shardId: number) => {
      const instanceId = getSchedulerInstanceId(shardId, shardCount);
      return describeShard(shardId, instanceId, await durable().status(instanceId).catch(() => null));
    };

    if (shardParam !== null) {
      return jsonResponse(await statusOf(normalizeSchedulerShardId(shardParam, shardCount)));
    }

    const statuses = await Promise.all(Array.from({ length: shardCount }, (_, shardId) => statusOf(shardId)));

    return jsonResponse({
      shardCount,
      statuses,
    });
  },
});

// ============================================================================
// POST /cron/admin/backfill-due-index — index pre-index jobs once
// ============================================================================

routes.push({
  name: "cronBackfillDueIndex",
  methods: ["POST"],
  route: "cron/admin/backfill-due-index",
  handler: async (req: HttpRequestLike, ctx: HandlerContext) => {
    const denied = await requireAdmin(req);
    if (denied) return denied;
    const result = await getCronStore().backfillDueIndex();
    ctx.log(`[cron] due-index backfill: ${JSON.stringify(result)}`);
    return jsonResponse(result, 200);
  },
});

// ============================================================================
// POST /cron/start — Start or restart the scheduler
// ============================================================================

routes.push({
  name: "cronStartScheduler",
  methods: ["POST"],
  route: "cron/start",
  durable: true,
  handler: async (req: HttpRequestLike, ctx: HandlerContext) => {
    // Starts or restarts the global scheduler: operators only.
    const denied = await requireAdmin(req);
    if (denied) return denied;

    const shardCount = getSchedulerShardCount();
    const shardParam = req.query.get("shardId");
    const shardIds =
      shardParam === null
        ? Array.from({ length: shardCount }, (_, i) => i)
        : [normalizeSchedulerShardId(shardParam, shardCount)];

    const results = await Promise.all(
      shardIds.map(async (shardId) => {
        const instanceId = getSchedulerInstanceId(shardId, shardCount);
        const info = await durable().status(instanceId).catch(() => null);

        if (info?.status === "running" || info?.status === "pending") {
          return {
            shardId,
            instanceId,
            action: "already-running" as const,
            runtimeStatus: STATUS_NAMES[info.status],
          };
        }

        // Terminate if in a bad state
        if (info?.status === "suspended" || info?.status === "failed") {
          await durable().terminate(instanceId, "Manual restart");
        }

        const result = await durable().ensureAlarm(CRON_SCHEDULER_KIND, instanceId, { shardId });
        if (result !== "started") {
          // The termination hasn't landed yet (it's queued); the health check
          // or another /cron/start finishes the restart.
          return {
            shardId,
            instanceId,
            action: "restart-pending" as const,
            runtimeStatus: result === "suspended" ? "Suspended" : "Running",
          };
        }
        return {
          shardId,
          instanceId,
          action: "started" as const,
          runtimeStatus: "Pending",
        };
      }),
    );

    return jsonResponse(
      {
        message:
          shardParam === null
            ? "Schedulers ensured for all shards"
            : "Scheduler ensured",
        shardCount,
        results,
      },
      200,
    );
  },
});
