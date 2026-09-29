/// <reference types="node" />

/**
 * AgentForEach Cron System — Configuration & Constants
 *
 * Defaults are loaded from `gateway/config/agentforeach.json`.
 * Environment variables override JSON values at runtime.
 *
 * Ported from OpenClaw's cron constants, adapted for Azure Durable Functions.
 */
import { createHash } from "node:crypto";
import { loadConfigSection } from "../utils/index.js";

import { CronConfig } from "./types.js";

// ============================================================================
// Load agentforeach.json
// ============================================================================

let _cfg: CronConfig;
function cfg(): CronConfig {
  if (!_cfg) {
    const cronSection = loadConfigSection<CronConfig>("cron");
    if (!cronSection) {
      throw new Error(
        `Unable to locate cron config in agentforeach.json. Ensure "cron" section exists.`,
      );
    }
    _cfg = cronSection;
  }
  return _cfg;
}

// ============================================================================
// Execution Constants
// ============================================================================

/**
 * Whether the cron HTTP API (/cron/*) is registered. The scheduler, tools and
 * delivery are unaffected. Default: true.
 */
export function isCronApiEnabled(): boolean {
  return cfg().enabled !== false;
}

/** Default job execution timeout. */
export const DEFAULT_JOB_TIMEOUT_MS = cfg().execution.defaultJobTimeoutMs;

/** Default model for agent turns. */
export const DEFAULT_MODEL = cfg().execution.defaultModel;

/** Default LLM provider for cron jobs (undefined = use global default). */
export const DEFAULT_PROVIDER = cfg().execution.defaultProvider;

/** Max summary length stored per run. */
export const MAX_SUMMARY_LENGTH = cfg().execution.maxSummaryLength;

// ============================================================================
// Backoff (ported from OpenClaw ERROR_BACKOFF_SCHEDULE_MS)
// ============================================================================

/**
 * Exponential backoff delays indexed by consecutiveErrors - 1.
 * After the last entry, the delay stays at the cap.
 */
export const ERROR_BACKOFF_SCHEDULE_MS: readonly number[] =
  cfg().backoff.scheduleMs;

/**
 * Get the backoff delay for a given consecutive error count.
 */
export function getBackoffMs(consecutiveErrors: number): number {
  if (consecutiveErrors <= 0) return 0;
  const idx = Math.min(
    consecutiveErrors - 1,
    ERROR_BACKOFF_SCHEDULE_MS.length - 1,
  );
  return ERROR_BACKOFF_SCHEDULE_MS[idx];
}

// ============================================================================
// Stagger (ported from OpenClaw stagger.ts)
// ============================================================================

/** Default stagger window for top-of-hour cron expressions. */
export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = cfg().stagger.defaultTopOfHourMs;

// ============================================================================
// Run History
// ============================================================================

/** Default TTL for cron run documents. */
export const DEFAULT_RUN_TTL_SECONDS = cfg().runHistory.defaultTtlSeconds;

/** Max run history entries to return per query. */
export const MAX_RUNS_PER_QUERY = cfg().runHistory.maxRunsPerQuery;

// ============================================================================
// Scheduler
// ============================================================================

/** Base scheduler instance ID prefix for Durable orchestrations. */
export const SCHEDULER_INSTANCE_ID = cfg().scheduler.instanceIdPrefix;

/** Default number of scheduler shards. */
export const DEFAULT_SCHEDULER_SHARDS = cfg().scheduler.defaultShards;

/** Hard safety cap for shard count. */
export const MAX_SCHEDULER_SHARDS = cfg().scheduler.maxShards;

/** Fallback wake interval when no jobs are scheduled. */
export const FALLBACK_WAKE_INTERVAL_MS = cfg().scheduler.fallbackWakeIntervalMs;

/** Maximum due jobs fetched per scheduler tick (bounded fan-out safety). */
export const DEFAULT_MAX_DUE_JOBS_PER_TICK = cfg().scheduler.maxDueJobsPerTick;

/** Maximum heartbeat events claimed in one drain pass. */
export const DEFAULT_MAX_HEARTBEAT_EVENTS_PER_CLAIM =
  cfg().heartbeat.maxEventsPerClaim;

/**
 * Max events flushed immediately for wakeMode="now".
 * Limits per-request hot-path work under burst loads.
 */
export const DEFAULT_WAKE_NOW_IMMEDIATE_FLUSH_LIMIT =
  cfg().heartbeat.wakeNowImmediateFlushLimit;

/**
 * Backlog threshold after which wakeMode="now" degrades to queued delivery.
 * If pending due events for the same target exceed this, skip immediate flush.
 */
export const DEFAULT_WAKE_NOW_BACKLOG_THRESHOLD =
  cfg().heartbeat.wakeNowBacklogThreshold;

/** Max event texts coalesced into one heartbeat send. */
export const DEFAULT_HEARTBEAT_GROUP_BATCH_SIZE =
  cfg().heartbeat.groupBatchSize;

/** Per-user cron job safety cap (0 disables the cap). */
export const DEFAULT_MAX_JOBS_PER_USER = cfg().limits.maxJobsPerUser;

// ============================================================================
// Schedule & Input Limits
// ============================================================================

export function getMinEveryMs(): number {
  const raw = process.env.CRON_MIN_EVERY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : undefined;
  if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return cfg().limits.minEveryMs;
}

export function getMinCronIntervalMs(): number {
  const raw = process.env.CRON_MIN_CRON_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : undefined;
  if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return cfg().limits.minCronIntervalMs;
}

export function getMaxNameLength(): number {
  return cfg().limits.maxNameLength;
}

export function getMaxDescriptionLength(): number {
  return cfg().limits.maxDescriptionLength;
}

export function getMaxCronExprLength(): number {
  return cfg().limits.maxCronExprLength;
}

// ============================================================================
// Expiry
// ============================================================================



/**
 * Resolve default expiry duration for recurring jobs.
 *
 * Set `CRON_DEFAULT_EXPIRY_MS` to override the default TTL for new recurring jobs.
 */
export function getDefaultExpiryMs(): number {
  const raw = process.env.CRON_DEFAULT_EXPIRY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : undefined;
  if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return cfg().limits.defaultExpiryMs;
}

/**
 * Resolve maximum allowed expiry duration from now.
 *
 * Set `CRON_MAX_EXPIRY_MS` to override the hard cap on job expiry.
 */
export function getMaxExpiryMs(): number {
  const raw = process.env.CRON_MAX_EXPIRY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : undefined;
  if (parsed !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  return cfg().limits.maxExpiryMs;
}

/** Max heartbeat delivery attempts before dead-letter cutoff (0 disables cutoff). */
export const DEFAULT_HEARTBEAT_MAX_ATTEMPTS = cfg().heartbeat.maxAttempts;

/**
 * Heartbeat loop interval used by wakeMode="next-heartbeat".
 * Events queued for "next-heartbeat" are flushed on this cadence.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = cfg().heartbeat.intervalMs;

/**
 * Resolve heartbeat interval from env.
 *
 * Set `CRON_HEARTBEAT_INTERVAL_MS` to tune "next-heartbeat" cadence.
 */
export function getHeartbeatIntervalMs(): number {
  const raw = process.env.CRON_HEARTBEAT_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  return Math.max(1_000, Math.floor(parsed));
}

/**
 * Resolve next heartbeat boundary for a given timestamp.
 */
export function resolveNextHeartbeatAtMs(
  nowMs: number,
  heartbeatIntervalMs = getHeartbeatIntervalMs(),
): number {
  const safeNow = Number.isFinite(nowMs)
    ? Math.max(0, Math.floor(nowMs))
    : Date.now();
  const interval = Math.max(1_000, Math.floor(heartbeatIntervalMs));
  return Math.ceil(safeNow / interval) * interval;
}

/**
 * Resolve max due jobs per scheduler tick.
 *
 * Set `CRON_MAX_DUE_JOBS_PER_TICK` to tune scheduler fan-out pressure.
 */
export function getMaxDueJobsPerTick(): number {
  const raw = process.env.CRON_MAX_DUE_JOBS_PER_TICK;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_DUE_JOBS_PER_TICK;
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_MAX_DUE_JOBS_PER_TICK;
  return Math.min(1_000, Math.max(1, Math.floor(parsed)));
}

/**
 * Resolve max claimed heartbeat events per drain.
 *
 * Set `CRON_MAX_HEARTBEAT_EVENTS_PER_CLAIM` to tune heartbeat drain pressure.
 */
export function getMaxHeartbeatEventsPerClaim(): number {
  const raw = process.env.CRON_MAX_HEARTBEAT_EVENTS_PER_CLAIM;
  const parsed = raw
    ? Number.parseInt(raw, 10)
    : DEFAULT_MAX_HEARTBEAT_EVENTS_PER_CLAIM;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_HEARTBEAT_EVENTS_PER_CLAIM;
  }
  return Math.min(1_000, Math.max(1, Math.floor(parsed)));
}

/**
 * Resolve wake-now immediate flush event limit.
 *
 * Set `CRON_WAKE_NOW_IMMEDIATE_FLUSH_LIMIT` to cap per-request wake-now work.
 */
export function getWakeNowImmediateFlushLimit(): number {
  const raw = process.env.CRON_WAKE_NOW_IMMEDIATE_FLUSH_LIMIT;
  const parsed = raw
    ? Number.parseInt(raw, 10)
    : DEFAULT_WAKE_NOW_IMMEDIATE_FLUSH_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WAKE_NOW_IMMEDIATE_FLUSH_LIMIT;
  }
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

/**
 * Resolve wake-now backlog threshold before degrading to queued behavior.
 *
 * Set `CRON_WAKE_NOW_BACKLOG_THRESHOLD` to tune burst protection.
 */
export function getWakeNowBacklogThreshold(): number {
  const raw = process.env.CRON_WAKE_NOW_BACKLOG_THRESHOLD;
  const parsed = raw
    ? Number.parseInt(raw, 10)
    : DEFAULT_WAKE_NOW_BACKLOG_THRESHOLD;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WAKE_NOW_BACKLOG_THRESHOLD;
  }
  return Math.min(10_000, Math.max(1, Math.floor(parsed)));
}

/**
 * Resolve max grouped heartbeat items per send.
 *
 * Set `CRON_HEARTBEAT_GROUP_BATCH_SIZE` to bound prompt size for grouped sends.
 */
export function getHeartbeatGroupBatchSize(): number {
  const raw = process.env.CRON_HEARTBEAT_GROUP_BATCH_SIZE;
  const parsed = raw
    ? Number.parseInt(raw, 10)
    : DEFAULT_HEARTBEAT_GROUP_BATCH_SIZE;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HEARTBEAT_GROUP_BATCH_SIZE;
  }
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

/**
 * Resolve per-user cron job cap.
 *
 * Set `CRON_MAX_JOBS_PER_USER` to bound user-created cron cardinality.
 * Use `0` to disable this cap.
 */
export function getMaxJobsPerUser(): number {
  const raw = process.env.CRON_MAX_JOBS_PER_USER;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_JOBS_PER_USER;
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_JOBS_PER_USER;
  if (parsed <= 0) return 0;
  return Math.min(10_000, Math.max(1, Math.floor(parsed)));
}

/**
 * Resolve heartbeat max-attempt dead-letter cutoff.
 *
 * Set `CRON_HEARTBEAT_MAX_ATTEMPTS` to control retry cutoff.
 * Use `0` to disable dead-letter cutoff.
 */
export function getHeartbeatMaxAttempts(): number {
  const raw = process.env.CRON_HEARTBEAT_MAX_ATTEMPTS;
  const parsed = raw
    ? Number.parseInt(raw, 10)
    : DEFAULT_HEARTBEAT_MAX_ATTEMPTS;
  if (!Number.isFinite(parsed)) return DEFAULT_HEARTBEAT_MAX_ATTEMPTS;
  if (parsed <= 0) return 0;
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

/**
 * Running-claim staleness window.
 * A job with an active running token newer than this is considered in-flight
 * and is not eligible for a new execution claim.
 */
export const RUNNING_CLAIM_STALE_MS = cfg().scheduler.runningClaimStaleMs;

/**
 * Maximum durable timer duration.
 * JS Durable Functions timers are limited to 6 days.
 * We cap at ~143 hours for safety margin.
 * @see https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-timers#timer-limitations
 */
export const MAX_DURABLE_TIMER_MS = cfg().scheduler.maxDurableTimerMs;

/**
 * Max execution time for force-run HTTP trigger.
 * Consumption plan HTTP timeout is 230 seconds.
 */
export const FORCE_RUN_TIMEOUT_MS = cfg().scheduler.forceRunTimeoutMs;

/** Health-check timer schedule. */
export const HEALTH_CHECK_SCHEDULE = cfg().scheduler.healthCheckSchedule;

/** External event name to signal job changes. */
export const JOBS_CHANGED_EVENT = cfg().scheduler.jobsChangedEvent;

/**
 * Resolve scheduler shard count from env.
 *
 * Set `CRON_SCHEDULER_SHARDS` to tune scale without code changes.
 */
export function getSchedulerShardCount(): number {
  const raw = process.env.CRON_SCHEDULER_SHARDS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_SCHEDULER_SHARDS;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCHEDULER_SHARDS;
  }
  return Math.min(Math.max(1, Math.floor(parsed)), MAX_SCHEDULER_SHARDS);
}

/**
 * Normalize an arbitrary shard id into the valid scheduler shard range.
 */
export function normalizeSchedulerShardId(
  shardId: unknown,
  shardCount = getSchedulerShardCount(),
): number {
  const parsed =
    typeof shardId === "number"
      ? shardId
      : typeof shardId === "string"
        ? Number.parseInt(shardId, 10)
        : 0;
  if (!Number.isFinite(parsed)) return 0;
  const normalized = Math.floor(parsed) % shardCount;
  return normalized < 0 ? normalized + shardCount : normalized;
}

/**
 * Resolve deterministic shard id for a user.
 */
export function getSchedulerShardForUser(
  userId: string,
  shardCount = getSchedulerShardCount(),
): number {
  const digest = createHash("sha256").update(userId).digest();
  return digest.readUInt32BE(0) % shardCount;
}

/**
 * Durable scheduler instance id for a specific shard.
 */
export function getSchedulerInstanceId(
  shardId: number,
  shardCount = getSchedulerShardCount(),
): string {
  const normalized = normalizeSchedulerShardId(shardId, shardCount);
  // Keep shard 0 on the legacy singleton instance id for backward-compatible
  // rollouts (pre-sharding deployments used this exact id).
  if (shardCount <= 1 || normalized === 0) {
    return SCHEDULER_INSTANCE_ID;
  }
  return `${SCHEDULER_INSTANCE_ID}-${normalized}`;
}

/**
 * All scheduler instance ids for current shard config.
 */
export function listSchedulerInstanceIds(
  shardCount = getSchedulerShardCount(),
): Array<{ shardId: number; instanceId: string }> {
  return Array.from({ length: shardCount }, (_, shardId) => ({
    shardId,
    instanceId: getSchedulerInstanceId(shardId, shardCount),
  }));
}

// ============================================================================
// Webhook Delivery
// ============================================================================

/**
 * Lead time subtracted from scheduled fire times to compensate for
 * claim + execution + delivery latency, so the user receives the
 * result closer to the intended timestamp.
 */
export const DELIVERY_LEAD_TIME_MS = cfg().execution.deliveryLeadTimeMs;

/** Webhook delivery timeout. */
export const WEBHOOK_TIMEOUT_MS = cfg().webhook.timeoutMs;

// ============================================================================
// Execution — Additional
// ============================================================================

/** Max one-shot delivery retries before giving up. */
export const MAX_ONE_SHOT_DELIVERY_RETRIES =
  cfg().execution.maxOneShotDeliveryRetries;

/** Floor delay (ms) for "now"/"immediately"/"asap" schedule hints. */
export const IMMEDIATE_DELAY_FLOOR_MS = cfg().execution.immediateDelayFloorMs;

// ============================================================================
// Scheduler — Additional
// ============================================================================

/** Max parallel job claims per scheduler tick. */
export const CLAIM_CONCURRENCY = cfg().scheduler.claimConcurrency;

/** Min interval between legacy due-job sweeps (ms). */
export const LEGACY_SWEEP_INTERVAL_MS = cfg().scheduler.legacySweepIntervalMs;

/** Max jobs returned per legacy sweep query. */
export const LEGACY_SWEEP_MAX_JOBS = cfg().scheduler.legacySweepMaxJobs;

// ============================================================================
// Heartbeat — Additional
// ============================================================================

/** Per-user pending heartbeat event cap. */
export const MAX_PENDING_HEARTBEAT_EVENTS_PER_USER =
  cfg().heartbeat.maxPendingEventsPerUser;

// ============================================================================
// Input Validation Limits
// ============================================================================

/** Max length for payload systemEvent text. */
export const MAX_PAYLOAD_TEXT_LENGTH = cfg().limits.maxPayloadTextLength;

/** Max length for payload agentTurn message. */
export const MAX_PAYLOAD_MESSAGE_LENGTH = cfg().limits.maxPayloadMessageLength;

/** Max length for webhook delivery URL. */
export const MAX_WEBHOOK_URL_LENGTH = cfg().limits.maxWebhookUrlLength;

/** Max length for webhook auth token. */
export const MAX_WEBHOOK_TOKEN_LENGTH = cfg().limits.maxWebhookTokenLength;

/** Max length for delivery string fields (channelId, recipientId, etc.). */
export const MAX_DELIVERY_STRING_LENGTH = cfg().limits.maxDeliveryStringLength;

/** Max length for ID string fields (agentId, sessionId). */
export const MAX_ID_STRING_LENGTH = cfg().limits.maxIdStringLength;

/** Max length for model name strings. */
export const MAX_MODEL_NAME_LENGTH = cfg().limits.maxModelNameLength;

// ============================================================================
// Run History — Query
// ============================================================================

/** Default run history query limit. */
export const DEFAULT_QUERY_LIMIT = cfg().runHistory.defaultQueryLimit;

/** Max run history query limit per request. */
export const MAX_QUERY_LIMIT = cfg().runHistory.maxQueryLimit;

// ============================================================================
// Cosmos DB — TTLs
// ============================================================================

/** TTL for due-index documents (seconds). */
export const DUE_INDEX_TTL_SECONDS = cfg().cosmos.dueIndexTtlSeconds;

/** TTL for heartbeat event documents (seconds). */
export const HEARTBEAT_EVENT_TTL_SECONDS =
  cfg().cosmos.heartbeatEventTtlSeconds;

// ============================================================================
// Cosmos DB Container Config
// ============================================================================

/** Container name for cron jobs. */
export const CRON_JOBS_CONTAINER = cfg().cosmos.jobsContainer;

/** Container name for scheduler-friendly due index. */
export const CRON_DUE_INDEX_CONTAINER = cfg().cosmos.dueIndexContainer;

/** Container name for run history. */
export const CRON_RUNS_CONTAINER = cfg().cosmos.runsContainer;

/** Container name for queued main-session heartbeat events. */
export const CRON_HEARTBEAT_EVENTS_CONTAINER =
  cfg().cosmos.heartbeatEventsContainer;

// ============================================================================
// Reset (for testing)
// ============================================================================

/**
 * Reset the cached cron config (for testing).
 *
 * NOTE: Module-level `const` exports (e.g. DEFAULT_JOB_TIMEOUT_MS) are
 * captured at import time and will NOT change after a reset.  This only
 * affects subsequent calls to `cfg()` and any dynamic consumers.
 */
export function resetCronConfig(): void {
  _cfg = undefined!;
}
