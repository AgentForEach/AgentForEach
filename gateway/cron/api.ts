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

import * as df from "durable-functions";
import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { getCronStore, hasActiveRunningClaim } from "./store.js";
import {
  JOBS_CHANGED_EVENT,
  getSchedulerInstanceId,
  getSchedulerShardCount,
  getSchedulerShardForUser,
  isCronApiEnabled,
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

function jsonResponse(body: unknown, status = 200): HttpResponseInit {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function errorResponse(message: string, status: number): HttpResponseInit {
  return jsonResponse({ error: message }, status);
}

/** Register a /cron/* route unless the API is turned off (cron.enabled=false). */
function registerCronRoute(name: string, options: Parameters<typeof app.http>[1]): void {
  if (isCronApiEnabled()) app.http(name, options);
}

async function getUserId(req: HttpRequest): Promise<string | null> {
  const auth = await resolveAuthContext(req);
  return auth?.userId ?? null;
}

/** 401 without a user, 403 without the admin role, null when allowed. */
async function requireAdmin(req: HttpRequest): Promise<HttpResponseInit | null> {
  const auth = await resolveAuthContext(req);
  if (!auth) return errorResponse("Unauthorized", 401);
  if (!isAdmin(auth)) return errorResponse("Forbidden: requires the admin role", 403);
  return null;
}

/**
 * Signal the scheduler orchestrator that jobs have changed.
 */
async function signalJobsChanged(
  ctx: InvocationContext,
  opts?: { userId?: string; shardId?: number },
): Promise<void> {
  try {
    const client = df.getClient(ctx);
    const shardCount = getSchedulerShardCount();
    if (typeof opts?.shardId === "number") {
      const shardId = normalizeSchedulerShardId(opts.shardId, shardCount);
      await client.raiseEvent(
        getSchedulerInstanceId(shardId, shardCount),
        JOBS_CHANGED_EVENT,
        { shardId },
      );
      return;
    }
    if (opts?.userId) {
      const shardId = getSchedulerShardForUser(opts.userId, shardCount);
      await client.raiseEvent(
        getSchedulerInstanceId(shardId, shardCount),
        JOBS_CHANGED_EVENT,
        { shardId, userId: opts.userId },
      );
      return;
    }

    await Promise.all(
      Array.from({ length: shardCount }, (_, shardId) =>
        client.raiseEvent(
          getSchedulerInstanceId(shardId, shardCount),
          JOBS_CHANGED_EVENT,
          { shardId },
        ),
      ),
    );
  } catch {
    // Orchestrator might not be running yet — health check will start it
  }
}

// ============================================================================
// POST /cron/jobs — Create a job
// ============================================================================

registerCronRoute("cronCreateJob", {
  methods: ["POST"],
  route: "cron/jobs",
  authLevel: "anonymous",
  extraInputs: [df.input.durableClient()],
  handler: async (req: HttpRequest, ctx: InvocationContext) => {
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

registerCronRoute("cronListJobs", {
  methods: ["GET"],
  route: "cron/jobs",
  authLevel: "anonymous",
  handler: async (req: HttpRequest) => {
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

registerCronRoute("cronGetJob", {
  methods: ["GET"],
  route: "cron/jobs/{id}",
  authLevel: "anonymous",
  handler: async (req: HttpRequest) => {
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

registerCronRoute("cronUpdateJob", {
  methods: ["PATCH"],
  route: "cron/jobs/{id}",
  authLevel: "anonymous",
  extraInputs: [df.input.durableClient()],
  handler: async (req: HttpRequest, ctx: InvocationContext) => {
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

registerCronRoute("cronDeleteJob", {
  methods: ["DELETE"],
  route: "cron/jobs/{id}",
  authLevel: "anonymous",
  extraInputs: [df.input.durableClient()],
  handler: async (req: HttpRequest, ctx: InvocationContext) => {
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

registerCronRoute("cronForceRun", {
  methods: ["POST"],
  route: "cron/jobs/{id}/run",
  authLevel: "anonymous",
  extraInputs: [df.input.durableClient()],
  handler: async (req: HttpRequest, ctx: InvocationContext) => {
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

    // Dispatch execution to a one-shot Durable orchestration.
    // Returns 202 immediately — the caller polls GET /cron/runs/{id}
    // to check the result. This avoids Consumption plan HTTP timeout
    // risk (230s) for long-running jobs.
    const client = df.getClient(ctx);
    const instanceId = `force-run-${claimed.id}-${Date.now()}`;
    await client.startNew("CronForceRunExecution", {
      instanceId,
      input: claimed,
    });

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

registerCronRoute("cronGetRuns", {
  methods: ["GET"],
  route: "cron/runs/{id}",
  authLevel: "anonymous",
  handler: async (req: HttpRequest) => {
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

    const runs = await store.getRuns(jobId, limit);

    return jsonResponse({ runs, count: runs.length });
  },
});

// ============================================================================
// GET /cron/status — Scheduler status
// ============================================================================

registerCronRoute("cronStatus", {
  methods: ["GET"],
  route: "cron/status",
  authLevel: "anonymous",
  extraInputs: [df.input.durableClient()],
  handler: async (_req: HttpRequest, ctx: InvocationContext) => {
    // Global scheduler state across every user's shard: operators only.
    const denied = await requireAdmin(_req);
    if (denied) return denied;

    const client = df.getClient(ctx);
    const shardCount = getSchedulerShardCount();
    const shardParam = _req.query.get("shardId");

    if (shardParam !== null) {
      const shardId = normalizeSchedulerShardId(shardParam, shardCount);
      const instanceId = getSchedulerInstanceId(shardId, shardCount);
      try {
        const status = await client.getStatus(instanceId);
        return jsonResponse({
          shardId,
          instanceId,
          runtimeStatus: status?.runtimeStatus ?? "NotFound",
          createdTime: status?.createdTime,
          lastUpdatedTime: status?.lastUpdatedTime,
        });
      } catch {
        return jsonResponse({
          shardId,
          instanceId,
          runtimeStatus: "NotFound",
        });
      }
    }

    const statuses = await Promise.all(
      Array.from({ length: shardCount }, async (_, shardId) => {
        const instanceId = getSchedulerInstanceId(shardId, shardCount);
        try {
          const status = await client.getStatus(instanceId);
          return {
            shardId,
            instanceId,
            runtimeStatus: status?.runtimeStatus ?? "NotFound",
            createdTime: status?.createdTime,
            lastUpdatedTime: status?.lastUpdatedTime,
          };
        } catch {
          return {
            shardId,
            instanceId,
            runtimeStatus: "NotFound",
          };
        }
      }),
    );

    return jsonResponse({
      shardCount,
      statuses,
    });
  },
});

// ============================================================================
// POST /cron/admin/backfill-due-index — index pre-index jobs once
// ============================================================================

registerCronRoute("cronBackfillDueIndex", {
  methods: ["POST"],
  route: "cron/admin/backfill-due-index",
  authLevel: "anonymous",
  handler: async (req: HttpRequest, ctx: InvocationContext) => {
    const denied = await requireAdmin(req);
    if (denied) return denied;
    const result = await getCronStore().backfillDueIndex();
    ctx.log(`[cron] due-index backfill: ${JSON.stringify(result)}`);
    return { status: 200, jsonBody: result };
  },
});

// ============================================================================
// POST /cron/start — Start or restart the scheduler
// ============================================================================

registerCronRoute("cronStartScheduler", {
  methods: ["POST"],
  route: "cron/start",
  authLevel: "anonymous",
  extraInputs: [df.input.durableClient()],
  handler: async (req: HttpRequest, ctx: InvocationContext) => {
    // Starts or restarts the global scheduler: operators only.
    const denied = await requireAdmin(req);
    if (denied) return denied;

    const client = df.getClient(ctx);
    const shardCount = getSchedulerShardCount();
    const shardParam = req.query.get("shardId");
    const shardIds =
      shardParam === null
        ? Array.from({ length: shardCount }, (_, i) => i)
        : [normalizeSchedulerShardId(shardParam, shardCount)];

    const results = await Promise.all(
      shardIds.map(async (shardId) => {
        const instanceId = getSchedulerInstanceId(shardId, shardCount);
        try {
          const status = await client.getStatus(instanceId);
          const runtimeStatus = status?.runtimeStatus;

          if (runtimeStatus === "Running" || runtimeStatus === "Pending") {
            return {
              shardId,
              instanceId,
              action: "already-running" as const,
              runtimeStatus,
            };
          }

          // Terminate if in a bad state
          if (runtimeStatus === "Suspended" || runtimeStatus === "Failed") {
            await client.terminate(instanceId, "Manual restart");
          }
        } catch {
          // Instance doesn't exist, we'll create it.
        }

        await client.startNew("CronScheduler", {
          instanceId,
          input: { shardId },
        });
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
