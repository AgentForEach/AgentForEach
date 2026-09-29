/**
 * AgentForEach Cron System — Job Executor
 *
 * Executes a cron job and optionally delivers its result.
 *
 * Execution routing:
 * - sessionTarget="isolated": LLM call via AgentForEach provider layer (agentTurn)
 * - sessionTarget="main": route systemEvent text via AgentForEach gateway session send
 */

import type {
  CronHeartbeatEventDocument,
  CronJob,
  JobResult,
  ExecutorConfig,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { redactId } from "../utils/redact.js";
import {
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  MAX_SUMMARY_LENGTH,
  WEBHOOK_TIMEOUT_MS,
  getHeartbeatGroupBatchSize,
  getSchedulerShardForUser,
  getWakeNowBacklogThreshold,
  getWakeNowImmediateFlushLimit,
} from "./config.js";
import { deliverToChannel, getDeliveryAdapter, resolveDelivery } from "./delivery.js";
import { getCronStore } from "./store.js";
import { buildSystemPrompt, type PromptContext } from "../prompt/index.js";
import { safeFetch } from "../utils/safe-fetch.js";
import { getScopedRateLimiter, type RateLimitDecision } from "../ratelimit/index.js";

const HEARTBEAT_ACK_TOKEN = "HEARTBEAT_OK";
const SILENT_REPLY_TOKEN = "NO_REPLY";

/**
 * Build cron-specific context that tells the LLM about the job it's executing.
 *
 * Includes job name, description, schedule type, delivery target, and
 * creation time so the LLM can tailor its response appropriately
 * (e.g. concise for push notifications, aware of recurrence, etc.).
 */
function buildCronJobContext(job: CronJob): string {
  const lines: string[] = [
    `You are executing a scheduled cron job (isolated mode).`,
    `Your output will be delivered as a one-way notification to the user.`,
    ``,
    `CRITICAL RULES:`,
    `- Be concise and to the point. This is a notification, not a conversation.`,
    `- Do NOT offer interactive actions (e.g., "Reply Done", "Reply Snooze", "Click here to...").`,
    `- Do NOT ask follow-up questions or expect responses. You cannot receive replies.`,
    `- Do NOT use phrases like "Let me know", "Feel free to reply", or "Would you like...".`,
    `- Write like a professional notification: state the information clearly and stop.`,
    `- NEVER output an empty response or a placeholder like "NO_REPLY". You MUST provide the notification text.`,
    ``,
    `JOB DETAILS:`,
    `- Job: "${job.name}"`,
  ];

  if (job.description) {
    lines.push(`- Description: ${job.description}`);
  }

  // Schedule type
  const { schedule } = job;
  if (schedule.kind === "at") {
    lines.push(`- Schedule: one-shot (fires once)`);
  } else if (schedule.kind === "every") {
    const secs = Math.round(schedule.everyMs / 1000);
    lines.push(`- Schedule: recurring (every ${secs}s)`);
  } else if (schedule.kind === "cron") {
    lines.push(
      `- Schedule: recurring (cron: ${schedule.expr}${schedule.tz ? `, tz: ${schedule.tz}` : ""})`,
    );
  }

  // Delivery target
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const channel = delivery.channelId ?? delivery.mode;
    lines.push(`- Delivery: ${channel}`);
  }

  // Expiry info
  if (job.expiresAt) {
    const remainingMs = job.expiresAt - Date.now();
    const remainingDays = Math.ceil(remainingMs / 86_400_000);
    lines.push(
      `- Expires: ${new Date(job.expiresAt).toISOString()} (${remainingDays} day${remainingDays !== 1 ? "s" : ""} remaining)`,
    );
  }

  // Creation context
  lines.push(`- Created: ${new Date(job.createdAtMs).toISOString()}`);

  return lines.join("\n");
}

// ============================================================================
// Job Execution
// ============================================================================

/**
 * Execute a single cron job via the configured LLM provider.
 *
 * @param job - The job to execute.
 * @param config - Executor configuration (timeout).
 * @returns The execution result.
 */
export async function executeJob(
  job: CronJob,
  config: ExecutorConfig,
): Promise<JobResult> {
  const start = Date.now();

  // ── Phase 0: a job whose recipient isn't its owner's can never deliver.
  // Refuse before spending an LLM call, disable it, and tell the owner.
  const mode = job.delivery?.mode;
  if (mode === "channel" || mode === "announce") {
    const resolved = await resolveDelivery(job);
    if (!resolved.ok && resolved.refused) {
      await notifyOwnerOfDisabledJob(job, resolved.error);
      return {
        status: "error",
        error: resolved.error,
        durationMs: Date.now() - start,
        disableJob: true,
      };
    }
  }

  // ── Phase 0b: every model run a user's schedule causes is metered, so
  // many jobs (or tight intervals) can't spend without bound.
  const limit = await checkScheduledRunLimit(job.userId);
  if (!limit.allowed) {
    return {
      status: "skipped",
      summary: `Scheduled run limit reached (per ${limit.window}); this run was deferred.`,
      durationMs: Date.now() - start,
      retryAfterMs: limit.retryAfterSeconds * 1000,
    };
  }

  // ── Phase 1: Execute the job (LLM call or main-session dispatch) ──
  let result: JobResult;
  try {
    result = job.sessionTarget === "main"
      ? await executeMainSessionJob(job, start)
      : await executeIsolatedJob(job, config, start);
  } catch (err) {
    return executionFailure(err, start);
  }

  // ── Phase 2: Deliver the result (separate error boundary) ──
  if (shouldSuppressDelivery(result)) {
    result.delivered = false;
    result.deliveryChannel = undefined;
  } else {
    try {
      await dispatchDelivery(job, result);
    } catch (err) {
      // Delivery failed but execution succeeded — record as delivery error
      // so the result (summary) is preserved and retry logic can distinguish
      // delivery failures from execution failures.
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[cron-executor] Delivery failed for job ${job.id} (${job.name}): ${errMsg}`,
      );
      result.status = "error";
      result.error = errMsg.startsWith("Channel delivery failed")
        ? errMsg
        : `Channel delivery failed: ${errMsg}`;
      result.delivered = false;
    }
  }

  return result;
}

/** Best-effort in-app notice that a job was turned off, and why. */
async function notifyOwnerOfDisabledJob(job: CronJob, reason: string): Promise<void> {
  const push = getDeliveryAdapter("push");
  if (!push) return;
  const text = `Your scheduled task "${job.name}" was turned off: ${reason}`;
  try {
    await push.deliver({
      job,
      result: { status: "error", error: reason, summary: text, durationMs: 0 },
      target: { channelId: "push", recipientId: job.userId, resolution: "explicit" },
      text,
    });
  } catch (err) {
    // Non-fatal: the job's lastError also records the reason.
    console.warn(
      `[cron-executor] Could not notify the owner that job ${job.id} was disabled: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function executeIsolatedJob(
  job: CronJob,
  config: ExecutorConfig,
  startMs: number,
): Promise<JobResult> {
  if (job.payload.kind !== "agentTurn") {
    return {
      status: "skipped",
      error: 'isolated cron jobs require payload.kind="agentTurn"',
      durationMs: Date.now() - startMs,
    };
  }
  if (isHeartbeatNoop(job.payload.message)) {
    return {
      status: "ok",
      summary: HEARTBEAT_ACK_TOKEN,
      durationMs: Date.now() - startMs,
    };
  }

  const timeoutMs = resolveTimeoutMs(job, config);

  // Dynamic import avoids circular dependency: executor → shared → client → cron.
  const { getAgentClient } = await import("../shared.js");
  const agentforeachClient = await getAgentClient();

  // Resolve provider: job-level (future) → cron config default → global default
  const provider = DEFAULT_PROVIDER
    ? agentforeachClient.resolveProvider(DEFAULT_PROVIDER)
    : agentforeachClient.provider;
  // Model priority: cron config default → provider default
  // NOTE: job.payload.model is intentionally ignored — the LLM was setting
  // arbitrary models (e.g. "gpt-4o") when creating cron jobs, which bypasses
  // the configured cron execution model and can cause missing-prompt issues.
  const model = DEFAULT_MODEL ?? agentforeachClient.resolveDefaultModel(provider.id);

  // Build system prompt with cron-specific context
  const agentId = job.agentId ?? "default";
  const cronContext = buildCronJobContext(job);
  let instructions: string | undefined;

  try {
    // Ensure prompt documents exist — seedDefaults is normally called
    // in client.send(), but cron bypasses that path entirely.
    await agentforeachClient.promptStore.seedDefaults(job.userId, agentId);

    const promptContext: PromptContext = {
      userId: job.userId,
      agentId,
      sessionType: "cron",
      promptMode: "minimal",
      currentDateTime: new Date().toISOString(),
      inboundMetaSystemPrompt: cronContext,
    };
    const assembled = await buildSystemPrompt(
      agentforeachClient.promptStore,
      promptContext,
    );
    instructions = assembled.instructions || undefined;
  } catch (err) {
    console.error(
      `[cron-executor] Failed to build system prompt for isolated job ${job.id}:`,
      err instanceof Error ? err.stack : String(err),
    );
  }

  // Fallback: if prompt building failed or returned empty, use the
  // cron job context directly so the LLM at least knows the job details.
  if (!instructions) {
    console.warn(
      `[cron-executor] Using fallback instructions for job ${job.id} (prompt builder returned empty or failed)`,
    );
    instructions = cronContext;
  }

  const envLabel = process.env.WEBSITE_SITE_NAME
    ? `azure:${process.env.WEBSITE_SITE_NAME}`
    : "local";

  // Call the LLM via the provider abstraction, metered like a chat turn:
  // credits reserved and settled, usage recorded.
  const input = job.payload.message;
  const response = await agentforeachClient.runMetered(
    { userId: job.userId, agentId, sessionId: `cron:${job.id}`, runId: randomUUID(), channelName: "cron" },
    () => {
      const responsePromise = provider.createResponse({
        model,
        input,
        instructions,
        metadata: {
          agentforeach_env: envLabel,
          agentforeach_session_type: "cron",
          cron_job_id: job.id,
          cron_user_id: redactId(job.userId),
          cron_session_target: job.sessionTarget,
        },
      });
      return timeoutMs > 0 ? withTimeout(responsePromise, timeoutMs) : responsePromise;
    },
  );

  const summary = response.text.slice(0, MAX_SUMMARY_LENGTH);

  return {
    status: "ok",
    summary,
    durationMs: Date.now() - startMs,
    model,
    usage: response.usage
      ? {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          total_tokens: response.usage.totalTokens,
        }
      : undefined,
  };
}

async function executeMainSessionJob(
  job: CronJob,
  startMs: number,
): Promise<JobResult> {
  if (job.payload.kind !== "systemEvent") {
    return {
      status: "skipped",
      error: 'main cron jobs require payload.kind="systemEvent"',
      durationMs: Date.now() - startMs,
    };
  }
  const text = job.payload.text.trim();
  if (!text) {
    return {
      status: "skipped",
      error: "main cron jobs require non-empty systemEvent text",
      durationMs: Date.now() - startMs,
    };
  }
  if (isHeartbeatNoop(text)) {
    return {
      status: "ok",
      summary: HEARTBEAT_ACK_TOKEN,
      durationMs: Date.now() - startMs,
    };
  }

  const store = getCronStore();
  const shardId =
    typeof job.shardId === "number" && Number.isFinite(job.shardId)
      ? Math.max(0, Math.floor(job.shardId))
      : getSchedulerShardForUser(job.userId);

  if (job.wakeMode === "next-heartbeat") {
    const queued = await store.enqueueHeartbeatEvent(job, text, Date.now());
    return {
      status: "ok",
      summary: `QUEUED_NEXT_HEARTBEAT:${new Date(queued.dueAtMs).toISOString()}`,
      durationMs: Date.now() - startMs,
    };
  }

  // wakeMode="now": enqueue in the heartbeat lane first,
  // then attempt an immediate flush. If the main lane is busy/fails, the
  // event remains queued for a later retry instead of being dropped.
  const nowMs = Date.now();
  const queued = await store.enqueueHeartbeatEvent(job, text, nowMs, nowMs);
  const target = {
    userId: job.userId,
    agentId: job.agentId,
    sessionId: job.sessionId,
  };
  const backlogThreshold = getWakeNowBacklogThreshold();
  const backlogCount = await store.countDueHeartbeatEventsForTarget(
    nowMs,
    shardId,
    target,
    backlogThreshold + 1,
  );
  if (backlogCount > backlogThreshold) {
    return {
      status: "ok",
      summary: `QUEUED_WAKE_NOW_BACKLOG:${new Date(queued.dueAtMs).toISOString()}`,
      durationMs: Date.now() - startMs,
    };
  }

  await processHeartbeatQueue(shardId, target, {
    limit: getWakeNowImmediateFlushLimit(),
  });
  const remaining = await store.getHeartbeatEvent(queued.id, shardId);
  if (remaining) {
    return {
      status: "ok",
      summary: `QUEUED_WAKE_NOW:${new Date(remaining.dueAtMs).toISOString()}`,
      durationMs: Date.now() - startMs,
    };
  }

  return {
    status: "ok",
    summary: text.slice(0, MAX_SUMMARY_LENGTH),
    durationMs: Date.now() - startMs,
  };
}

/**
 * Drain due wakeMode="next-heartbeat" events for one shard.
 *
 * Events are grouped per (user, agent, session) and flushed as one turn.
 * Returns the number of queued events successfully processed.
 */
/** The scheduled-run limit; fails open (like the limiter itself) when its store is unavailable. */
async function checkScheduledRunLimit(userId: string): Promise<RateLimitDecision> {
  try {
    return await getScopedRateLimiter("scheduled").check(userId);
  } catch (err) {
    console.warn(`[cron-executor] scheduled run limit unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return { allowed: true };
  }
}

export async function processHeartbeatQueue(
  shardId: number,
  target?: {
    userId: string;
    agentId?: string;
    sessionId?: string;
  },
  opts?: {
    limit?: number;
  },
): Promise<{ processed: number; groups: number }> {
  const store = getCronStore();
  const nowMs = Date.now();
  const claimed = await store.claimDueHeartbeatEvents(nowMs, shardId, opts?.limit, target);
  if (claimed.length === 0) {
    return { processed: 0, groups: 0 };
  }

  const grouped = new Map<string, CronHeartbeatEventDocument[]>();
  for (const event of claimed) {
    const key = `${event.userId}|${event.agentId ?? ""}|${event.sessionId ?? ""}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(event);
    else grouped.set(key, [event]);
  }

  let processed = 0;
  const maxBatchSize = getHeartbeatGroupBatchSize();
  for (const events of grouped.values()) {
    events.sort(compareHeartbeatEventsForSend);
    for (let i = 0; i < events.length; i += maxBatchSize) {
      const chunk = events.slice(i, i + maxBatchSize);
      const first = chunk[0];
      const message = buildHeartbeatBatchMessage(chunk);
      try {
        const limit = await checkScheduledRunLimit(first.userId);
        if (!limit.allowed) {
          for (const event of chunk) {
            if (event.runningToken) {
              await store.releaseHeartbeatEventClaim(
                event.id, shardId, event.runningToken, limit.retryAfterSeconds * 1000, "scheduled run limit reached",
              );
            }
          }
          continue;
        }
        const response = await sendMainSessionText({
          userId: first.userId,
          agentId: first.agentId,
          sessionId: first.sessionId,
          text: message,
        });
        if (!reachedUser(response.status)) {
          throw new Error(response.error ?? "heartbeat flush failed");
        }
        for (const event of chunk) {
          const token = event.runningToken;
          if (!token) continue;
          await store.completeHeartbeatEvent(event.id, shardId, token);
          processed += 1;
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        for (const event of chunk) {
          const token = event.runningToken;
          if (!token) continue;
          await store.releaseHeartbeatEventClaim(event.id, shardId, token, 30_000, errorMessage);
        }
      }
    }
  }

  return { processed, groups: grouped.size };
}

/** How long a run waits when the credits service didn't answer. */
export const CREDITS_UNAVAILABLE_RETRY_MS = 5 * 60_000;

/**
 * The result for a job whose execution threw (no delivery was attempted).
 * A credits-service outage is deferred, not failed: a one-shot reminder that
 * fails is disabled for good. Running out of credits is a real failure.
 */
export function executionFailure(err: unknown, startMs: number): JobResult {
  if ((err as { code?: unknown } | null)?.code === "CREDITS_UNAVAILABLE") {
    return {
      status: "skipped",
      summary: "The credits service was unavailable; this run was deferred.",
      durationMs: Date.now() - startMs,
      retryAfterMs: CREDITS_UNAVAILABLE_RETRY_MS,
    };
  }
  // Use DEFAULT_MODEL (not job.payload.model) since the LLM may set
  // arbitrary model values during cron creation.
  return {
    status: "error",
    error: err instanceof Error ? err.message : String(err),
    durationMs: Date.now() - startMs,
    model: DEFAULT_MODEL,
  };
}

/**
 * Whether a main-session turn reached the user, so its events are done. A
 * turn that ended by asking them something (awaiting_input) or that they
 * stopped (aborted) did; retrying it would send it again, up to
 * heartbeat.maxAttempts times.
 */
export function reachedUser(status: "completed" | "failed" | "awaiting_input" | "aborted"): boolean {
  return status !== "failed";
}

async function sendMainSessionText(args: {
  userId: string;
  agentId?: string;
  sessionId?: string;
  text: string;
}) {
  // Dynamic import avoids eager runtime cycles: gateway -> cron -> gateway shared singleton.
  const { getAgentClient } = await import("../shared.js");
  const client = await getAgentClient();

  return client.send({
    userId: args.userId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    message: args.text,
    sessionType: "interactive",
    promptMode: "full",
    scheduled: true,
  });
}

function buildHeartbeatBatchMessage(events: CronHeartbeatEventDocument[]): string {
  const ordered = events
    .map((event) => event.text.trim())
    .filter((value): value is string => Boolean(value));
  if (ordered.length <= 1) {
    return ordered[0] ?? "HEARTBEAT_OK";
  }
  const lines = ordered.map((text, idx) => `${idx + 1}. ${text}`);
  return `[Heartbeat ${new Date().toISOString()}] Process queued events:\n${lines.join("\n")}`;
}

function compareHeartbeatEventsForSend(
  a: CronHeartbeatEventDocument,
  b: CronHeartbeatEventDocument,
): number {
  const dueDiff = a.dueAtMs - b.dueAtMs;
  if (dueDiff !== 0) return dueDiff;

  const enqueuedDiff = a.enqueuedAtMs - b.enqueuedAtMs;
  if (enqueuedDiff !== 0) return enqueuedDiff;

  return a.id.localeCompare(b.id);
}

/**
 * Get the executor config.
 *
 * Model and API key are now resolved at runtime from the AgentForEach provider
 * layer (via `getAgentClient()`), so this only configures timeout.
 */
export function getExecutorConfig(): ExecutorConfig {
  return {
    defaultTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
  };
}

// ============================================================================
// Delivery Dispatch
// ============================================================================

/**
 * Route delivery based on the job's delivery mode.
 *
 *   - "none"    → skip
 *   - "webhook" → POST to configured URL (deliverWebhook)
 *   - "announce"/"channel" → dispatch through registered DeliveryAdapter (delivery.ts)
 */
async function dispatchDelivery(job: CronJob, result: JobResult): Promise<void> {
  const mode = job.delivery?.mode ?? "none";

  switch (mode) {
    case "webhook":
      await deliverWebhook(job, result);
      break;

    case "announce":
    case "channel": {
      // Enforce explicit targeting: if it's a channel delivery, it MUST have a recipientId
      // (unless the adapter itself can resolve it, but we no longer guess).
      if (mode === "channel" && !job.delivery?.recipientId) {
        const errorMsg = `Channel delivery failed: explicit recipientId is required for channel "${job.delivery?.channelId}". The 'last' heuristic is no longer supported.`;
        console.warn(`[cron-executor] ${errorMsg}`);
        result.delivered = false;
        result.status = "error";
        result.error = errorMsg;
        throw new Error(errorMsg);
      }

      const deliveryResult = await deliverToChannel(job, result);
      if (deliveryResult) {
        result.delivered = deliveryResult.success;
        result.deliveryChannel = job.delivery?.channelId ?? undefined;
        if (!deliveryResult.success) {
          console.warn(
            `[cron-executor] Channel delivery failed for job ${job.id} (${job.name}): ${deliveryResult.error ?? "unknown error"}`,
          );
        }
        // We no longer swallow errors for announce/channel unless explicitly requested
        const effectiveBestEffort = job.delivery?.bestEffort ?? false;
        if (!deliveryResult.success && !effectiveBestEffort) {
          throw new Error(
            `Channel delivery failed: ${deliveryResult.error ?? "unknown error"}`,
          );
        }
      } else {
        console.warn(
          `[cron-executor] Channel delivery returned no result for job ${job.id} (${job.name}), mode=${mode}, channelId=${job.delivery?.channelId}`,
        );
      }
      break;
    }

    case "none":
    default:
      if (job.sessionTarget === "isolated" && job.delivery?.channelId) {
        console.warn(
          `[cron-executor] Delivery mode is "${mode}" but job ${job.id} (${job.name}) has channelId="${job.delivery.channelId}". ` +
            `Result will NOT be delivered. Was this intentional?`,
        );
      }
      break;
  }
}

// ============================================================================
// Webhook Delivery
// ============================================================================

/**
 * POST the job result to the configured webhook URL.
 * Respects bestEffort flag — if true, swallows errors.
 */
async function deliverWebhook(job: CronJob, result: JobResult): Promise<void> {
  if (job.delivery?.mode !== "webhook" || !job.delivery.to) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (job.delivery.token) {
    headers["Authorization"] = `Bearer ${job.delivery.token}`;
  }

  try {
    // safeFetch refuses internal addresses at connect time and on every
    // redirect hop; the Authorization header never follows a
    // redirect to another origin.
    const response = await safeFetch(job.delivery.to, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jobId: job.id,
        jobName: job.name,
        ts: Date.now(),
        ...result,
      }),
      timeoutMs: WEBHOOK_TIMEOUT_MS,
    });

    if (!response.ok && !job.delivery.bestEffort) {
      throw new Error(`Webhook delivery failed: HTTP ${response.status}`);
    }
  } catch (err) {
    if (!job.delivery.bestEffort) throw err;
    // Best-effort: swallow the error
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the effective timeout for a job.
 */
function resolveTimeoutMs(job: CronJob, config: ExecutorConfig): number {
  if (job.payload.kind === "agentTurn" && job.payload.timeoutSeconds !== undefined) {
    return job.payload.timeoutSeconds <= 0
      ? 0 // 0 = no timeout
      : job.payload.timeoutSeconds * 1000;
  }
  return config.defaultTimeoutMs;
}

/**
 * Race a promise against a timeout.
 * Cleans up the timer when the promise settles first to avoid leaks.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Job timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isHeartbeatNoop(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^noop$/i.test(value)) return true;
  if (/^\[[^\]]+\]\s*noop$/i.test(value)) return true;
  if (/^heartbeat[\s_-]*noop$/i.test(value)) return true;
  return false;
}

function isAckOnlyText(text: string | undefined): boolean {
  if (!text) return false;
  const value = text.trim().toUpperCase();
  return value === HEARTBEAT_ACK_TOKEN || value === SILENT_REPLY_TOKEN;
}

function shouldSuppressDelivery(result: JobResult): boolean {
  if (result.status !== "ok") return false;
  if (!result.summary?.trim()) return true;
  return isAckOnlyText(result.summary);
}
