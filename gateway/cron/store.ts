/**
 * AgentForEach Cron System — Cosmos DB Store
 *
 * CRUD operations for cron jobs and run history in Cosmos DB, using the
 * shared database layer.
 */

import { randomUUID } from "node:crypto";
import { PartitionKeyKind, type Container } from "@azure/cosmos";
import {
  getSharedDatabase,
  type DatabaseProvider,
  type ContainerHandle,
} from "../database/index.js";
import type {
  CronDelivery,
  CronDeliveryMode,
  CronHeartbeatEventDocument,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronJobState,
  CronPayload,
  CronPayloadPatch,
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronRunDocument,
  CronRunStatus,
  JobResult,
} from "./types.js";
import {
  CRON_HEARTBEAT_EVENTS_CONTAINER,
  CRON_DUE_INDEX_CONTAINER,
  CRON_JOBS_CONTAINER,
  CRON_RUNS_CONTAINER,
  DEFAULT_RUN_TTL_SECONDS,
  MAX_RUNS_PER_QUERY,
  RUNNING_CLAIM_STALE_MS,
  getBackoffMs,
  getMaxDueJobsPerTick,
  getMaxHeartbeatEventsPerClaim,
  getHeartbeatMaxAttempts,
  getHeartbeatIntervalMs,
  getMaxJobsPerUser,
  getMinEveryMs,
  getMinCronIntervalMs,
  getMaxNameLength,
  getMaxDescriptionLength,
  getMaxCronExprLength,
  getDefaultExpiryMs,
  getMaxExpiryMs,
  getSchedulerShardCount,
  getSchedulerShardForUser,
  normalizeSchedulerShardId,
  resolveNextHeartbeatAtMs,
  DELIVERY_LEAD_TIME_MS,
  MAX_ONE_SHOT_DELIVERY_RETRIES,
  CLAIM_CONCURRENCY,
  LEGACY_SWEEP_INTERVAL_MS,
  LEGACY_SWEEP_MAX_JOBS,
  MAX_PENDING_HEARTBEAT_EVENTS_PER_USER,
  MAX_PAYLOAD_TEXT_LENGTH,
  MAX_PAYLOAD_MESSAGE_LENGTH,
  MAX_WEBHOOK_URL_LENGTH,
  MAX_WEBHOOK_TOKEN_LENGTH,
  MAX_DELIVERY_STRING_LENGTH,
  MAX_ID_STRING_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  DUE_INDEX_TTL_SECONDS,
  HEARTBEAT_EVENT_TTL_SECONDS,
} from "./config.js";
import {
  computeNextRunWithStagger,
  computeNextRunAtMs,
  parseAbsoluteTimeMs,
  resolveCronTimezone,
} from "./schedule.js";
import { Cron } from "croner";
import { checkUrl } from "../utils/safe-fetch.js";

/**
 * Normalize the schedule discriminator field.
 * The internal model uses `kind` but external clients (REST API, web app)
 * may send `type` instead.  Coerce `type` → `kind` so that downstream
 * switch statements work regardless of which field the caller used.
 */
function normalizeScheduleKind(schedule: CronSchedule): CronSchedule {
  const raw = schedule as Record<string, unknown>;
  if (!raw.kind && typeof raw.type === "string") {
    raw.kind = raw.type;
    delete raw.type;
  }
  return schedule;
}

function normalizeEverySchedule(
  schedule: CronSchedule,
  fallbackAnchorMs: number,
): CronSchedule {
  if (schedule.kind !== "every") {
    return schedule;
  }
  const anchorMs =
    typeof schedule.anchorMs === "number" && Number.isFinite(schedule.anchorMs)
      ? Math.max(0, Math.floor(schedule.anchorMs))
      : Math.max(0, Math.floor(fallbackAnchorMs));
  return {
    kind: "every",
    everyMs: Math.max(1, Math.floor(schedule.everyMs)),
    anchorMs,
  };
}

function normalizeSessionTarget(value: unknown): CronSessionTarget {
  return value === "main" ? "main" : "isolated";
}

function normalizeWakeMode(value: unknown): CronWakeMode {
  return value === "now" ? "now" : "next-heartbeat";
}

function normalizeDeliveryMode(mode: unknown): CronDeliveryMode {
  if (mode === "webhook") return "webhook";
  if (mode === "announce") return "announce";
  if (mode === "channel") return "channel";
  return "none";
}

function normalizeDelivery(delivery?: CronDelivery): CronDelivery | undefined {
  if (!delivery) return undefined;
  const raw = delivery as Record<string, unknown>;
  return {
    ...delivery,
    mode: normalizeDeliveryMode(delivery.mode),
    // Map REST-API-friendly aliases to canonical field names:
    //   channelName  → channelId   (e.g. "telegram", "push")
    //   channelChatId → recipientId (e.g. chat/phone/email address)
    channelId:
      delivery.channelId ??
      (typeof raw.channelName === "string" ? (raw.channelName as string) : undefined),
    recipientId:
      delivery.recipientId ??
      (typeof raw.channelChatId === "string" ? (raw.channelChatId as string) : undefined),
  };
}

function normalizePayloadForCreate(
  payload:
    | CronPayload
    | { message?: string; model?: string; timeoutSeconds?: number },
  sessionTarget: CronSessionTarget,
): CronPayload {
  const raw = payload as Record<string, unknown>;
  const kind = raw.kind;

  if (kind === "systemEvent") {
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    return { kind: "systemEvent", text };
  }
  if (kind === "agentTurn") {
    const message = typeof raw.message === "string" ? raw.message.trim() : "";
    return {
      kind: "agentTurn",
      message,
      model:
        typeof raw.model === "string" && raw.model.trim()
          ? raw.model.trim()
          : undefined,
      timeoutSeconds:
        typeof raw.timeoutSeconds === "number" &&
        Number.isFinite(raw.timeoutSeconds)
          ? Math.max(0, Math.floor(raw.timeoutSeconds))
          : undefined,
    };
  }

  // Back-compat for old shape { message, model?, timeoutSeconds? }.
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (sessionTarget === "main") {
    return { kind: "systemEvent", text: message };
  }
  return {
    kind: "agentTurn",
    message,
    model:
      typeof raw.model === "string" && raw.model.trim()
        ? raw.model.trim()
        : undefined,
    timeoutSeconds:
      typeof raw.timeoutSeconds === "number" &&
      Number.isFinite(raw.timeoutSeconds)
        ? Math.max(0, Math.floor(raw.timeoutSeconds))
        : undefined,
  };
}

function mergePayloadPatch(
  existing: CronPayload,
  patch?: CronPayloadPatch,
): CronPayload {
  if (!patch) return existing;
  if (patch.kind === "systemEvent") {
    return {
      kind: "systemEvent",
      text: typeof patch.text === "string" ? patch.text.trim() : "",
    };
  }
  if (patch.kind === "agentTurn") {
    return {
      kind: "agentTurn",
      message:
        typeof patch.message === "string"
          ? patch.message.trim()
          : existing.kind === "agentTurn"
            ? existing.message
            : "",
      model:
        typeof patch.model === "string"
          ? patch.model.trim() || undefined
          : existing.kind === "agentTurn"
            ? existing.model
            : undefined,
      timeoutSeconds:
        typeof patch.timeoutSeconds === "number" &&
        Number.isFinite(patch.timeoutSeconds)
          ? Math.max(0, Math.floor(patch.timeoutSeconds))
          : existing.kind === "agentTurn"
            ? existing.timeoutSeconds
            : undefined,
    };
  }
  // Legacy/partial patch: merge into existing shape.
  if (existing.kind === "agentTurn") {
    const anyPatch = patch as Record<string, unknown>;
    return {
      kind: "agentTurn",
      message:
        typeof anyPatch.message === "string"
          ? anyPatch.message.trim()
          : existing.message,
      model:
        typeof anyPatch.model === "string"
          ? anyPatch.model.trim() || undefined
          : existing.model,
      timeoutSeconds:
        typeof anyPatch.timeoutSeconds === "number" &&
        Number.isFinite(anyPatch.timeoutSeconds)
          ? Math.max(0, Math.floor(anyPatch.timeoutSeconds))
          : existing.timeoutSeconds,
    };
  }
  const anyPatch = patch as Record<string, unknown>;
  return {
    kind: "systemEvent",
    text:
      typeof anyPatch.text === "string" ? anyPatch.text.trim() : existing.text,
  };
}

function mergeDeliveryPatch(
  existing?: CronDelivery,
  patch?: Partial<CronDelivery>,
): CronDelivery | undefined {
  if (!patch) return existing;
  return normalizeDelivery({
    ...(existing ?? { mode: "none" }),
    ...patch,
  });
}

/**
 * Validate a webhook URL to prevent SSRF attacks at job creation/update time.
 */
function assertSafeWebhookUrl(url: string): void {
  // Early, friendly rejection; the fetch itself re-checks resolved addresses.
  const result = checkUrl(url);
  if (!result.ok) throw new Error(`Webhook URL not allowed: ${result.reason}`);
}

function assertSupportedJobSpec(
  job: Pick<CronJob, "sessionTarget" | "payload" | "delivery">,
) {
  if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") {
    throw new Error('main cron jobs require payload.kind="systemEvent"');
  }
  if (job.sessionTarget === "isolated" && job.payload.kind !== "agentTurn") {
    throw new Error('isolated cron jobs require payload.kind="agentTurn"');
  }
  if (job.payload.kind === "systemEvent" && !job.payload.text.trim()) {
    throw new Error("systemEvent payload requires non-empty text");
  }
  if (job.payload.kind === "agentTurn" && !job.payload.message.trim()) {
    throw new Error("agentTurn payload requires non-empty message");
  }
  if (
    job.sessionTarget === "main" &&
    job.delivery &&
    job.delivery.mode !== "webhook"
  ) {
    throw new Error('main cron jobs only support delivery.mode="webhook"');
  }
  if (job.delivery?.mode === "webhook" && job.delivery.to) {
    assertSafeWebhookUrl(job.delivery.to);
  }
}

function assertValidSchedule(job: Pick<CronJob, "schedule">) {
  const { schedule } = job;

  if (schedule.kind === "at") {
    const atMs = parseAbsoluteTimeMs(schedule.at);
    if (atMs === undefined) {
      throw new Error(
        "at schedule requires a valid ISO-8601 timestamp in schedule.at",
      );
    }
    return;
  }

  if (schedule.kind === "every") {
    const minMs = getMinEveryMs();
    if (schedule.everyMs < minMs) {
      throw new Error(
        `Interval too short: ${schedule.everyMs}ms is below the minimum of ${minMs}ms (${Math.round(minMs / 1000)}s)`,
      );
    }
    return;
  }

  if (schedule.kind === "cron") {
    const maxLen = getMaxCronExprLength();
    if (schedule.expr.length > maxLen) {
      throw new Error(
        `Cron expression too long: ${schedule.expr.length} chars exceeds limit of ${maxLen}`,
      );
    }
    // Validate cron expression doesn't fire too frequently.
    const minIntervalMs = getMinCronIntervalMs();
    if (minIntervalMs > 0) {
      try {
        const now = new Date();
        const timezone = resolveCronTimezone(schedule.tz);
        const cron = new Cron(schedule.expr, {
          timezone,
          catch: false,
        });
        const first = cron.nextRun(now);
        if (first) {
          const second = cron.nextRun(new Date(first.getTime() + 1000));
          if (second) {
            const gap = second.getTime() - first.getTime();
            if (gap < minIntervalMs) {
              throw new Error(
                `Cron fires too frequently: ~${Math.round(gap / 1000)}s between runs, minimum is ${Math.round(minIntervalMs / 1000)}s`,
              );
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Cron fires too frequently")) {
          throw err;
        }
        // If croner throws on an invalid expression, surface that.
        throw new Error(
          `Invalid cron expression "${schedule.expr}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

// Input validation limits are loaded from agentforeach.json via config.ts.

function assertSafeStringLength(
  value: string | undefined,
  field: string,
  maxLen: number,
): void {
  if (value && value.length > maxLen) {
    throw new Error(
      `${field} too long: ${value.length} chars exceeds limit of ${maxLen}`,
    );
  }
}

function assertValidInputLengths(
  job: Pick<CronJob, "name" | "description" | "payload" | "delivery" | "agentId" | "sessionId">,
) {
  const maxName = getMaxNameLength();
  if (job.name && job.name.length > maxName) {
    throw new Error(
      `Job name too long: ${job.name.length} chars exceeds limit of ${maxName}`,
    );
  }
  const maxDesc = getMaxDescriptionLength();
  if (job.description && job.description.length > maxDesc) {
    throw new Error(
      `Job description too long: ${job.description.length} chars exceeds limit of ${maxDesc}`,
    );
  }

  // Payload text/message limits
  if (job.payload.kind === "systemEvent") {
    assertSafeStringLength(job.payload.text, "payload.text", MAX_PAYLOAD_TEXT_LENGTH);
  } else if (job.payload.kind === "agentTurn") {
    assertSafeStringLength(job.payload.message, "payload.message", MAX_PAYLOAD_MESSAGE_LENGTH);
    assertSafeStringLength(job.payload.model, "payload.model", MAX_MODEL_NAME_LENGTH);
  }

  // Delivery field limits
  if (job.delivery) {
    assertSafeStringLength(job.delivery.to, "delivery.to", MAX_WEBHOOK_URL_LENGTH);
    assertSafeStringLength(job.delivery.token, "delivery.token", MAX_WEBHOOK_TOKEN_LENGTH);
    assertSafeStringLength(
      job.delivery.channelId as string | undefined,
      "delivery.channelId",
      MAX_DELIVERY_STRING_LENGTH,
    );
    assertSafeStringLength(job.delivery.recipientId, "delivery.recipientId", MAX_DELIVERY_STRING_LENGTH);
    assertSafeStringLength(job.delivery.threadId, "delivery.threadId", MAX_DELIVERY_STRING_LENGTH);
    assertSafeStringLength(job.delivery.accountId, "delivery.accountId", MAX_DELIVERY_STRING_LENGTH);
  }

  // ID field limits
  assertSafeStringLength(job.agentId, "agentId", MAX_ID_STRING_LENGTH);
  assertSafeStringLength(job.sessionId, "sessionId", MAX_ID_STRING_LENGTH);
}

function assertValidExpiry(
  job: Pick<CronJob, "schedule" | "expiresAt">,
  nowMs = Date.now(),
): void {
  // One-shot "at" jobs don't need expiry
  if (job.schedule.kind === "at") return;

  // Recurring jobs must have expiresAt
  if (typeof job.expiresAt !== "number" || !Number.isFinite(job.expiresAt)) {
    throw new Error("Recurring jobs require an expiresAt timestamp");
  }

  // Must be in the future
  if (job.expiresAt <= nowMs) {
    throw new Error("expiresAt must be in the future");
  }

  // Must not exceed max TTL from now
  const maxExpiryMs = getMaxExpiryMs();
  const maxAllowed = nowMs + maxExpiryMs;
  if (job.expiresAt > maxAllowed) {
    throw new Error(
      `expiresAt exceeds maximum allowed expiry (${Math.round(maxExpiryMs / 86_400_000)} days from now)`,
    );
  }
}

function isJobExpired(
  job: Pick<CronJob, "schedule" | "expiresAt">,
  nowMs = Date.now(),
): boolean {
  if (job.schedule.kind === "at") return false;
  return (
    typeof job.expiresAt === "number" &&
    Number.isFinite(job.expiresAt) &&
    job.expiresAt <= nowMs
  );
}

function computeJobNextRun(
  job: Pick<CronJob, "id" | "schedule">,
  nowMs: number,
): number | undefined {
  // Recurring slots are looked up from `now + lead`: a run that finished
  // inside the lead window (before its own slot) would otherwise be handed
  // that same slot again and fire twice.
  const from = job.schedule.kind === "at" ? nowMs : nowMs + DELIVERY_LEAD_TIME_MS;
  const raw =
    job.schedule.kind === "cron"
      ? computeNextRunWithStagger(job.schedule, from, job.id)
      : computeNextRunAtMs(job.schedule, from);
  if (raw === undefined) return undefined;
  // Fire slightly early to compensate for claim + execution + delivery latency,
  // so the user receives the result closer to the intended time.
  return Math.max(0, raw - DELIVERY_LEAD_TIME_MS);
}

/** Cosmos refuses a larger per-item ttl (2^31 - 1 seconds, about 68 years). */
const MAX_COSMOS_TTL_SECONDS = 2_147_483_647;

/**
 * A job that will never run again: past its expiry, a one-shot whose time has
 * passed and that is off, or a job that used up its maxRuns. A paused
 * recurring job (cron_update enabled=false) is not finished.
 */
function isFinishedJob(job: CronJob, nowMs: number): boolean {
  if (typeof job.expiresAt === "number" && job.expiresAt <= nowMs) return true;
  if (job.enabled) return false;
  if (job.schedule.kind === "at") return Date.parse(job.schedule.at) <= nowMs;
  return typeof job.maxRuns === "number" && job.maxRuns > 0 && (job.state.runCount ?? 0) >= job.maxRuns;
}

function resolveJobShardId(
  job: Pick<CronJob, "userId"> & { shardId?: number },
): number {
  if (typeof job.shardId === "number" && Number.isFinite(job.shardId)) {
    return normalizeSchedulerShardId(job.shardId);
  }
  return getSchedulerShardForUser(job.userId);
}

function resolveJobVersion(job: { version?: number }): number {
  if (typeof job.version === "number" && Number.isFinite(job.version)) {
    return Math.max(1, Math.floor(job.version));
  }
  return 1;
}

function nextJobVersion(job: { version?: number }): number {
  return resolveJobVersion(job) + 1;
}

type CronDueIndexDocument = {
  id: string;
  jobId: string;
  userId: string;
  shardId: string;
  jobVersion?: number;
  enabled: boolean;
  nextRunAtMs?: number;
  runningToken?: string;
  runningAtMs?: number;
  updatedAtMs: number;
  /** Cosmos DB TTL (seconds). Safety net for orphaned rows. */
  ttl?: number;
};

type DueIndexCandidate = {
  id: string;
  jobId: string;
  userId: string;
};

type NextWakeCandidate = {
  id: string;
  jobId: string;
  userId: string;
  nextRunAtMs: number;
};

type HeartbeatEventCandidate = {
  id: string;
  jobId: string;
  userId: string;
  shardId: string;
  agentId?: string;
  sessionId?: string;
  text: string;
  dueAtMs: number;
  runningToken?: string;
  runningAtMs?: number;
  attempts?: number;
};

function toDueIndexShardId(shardId: number): string {
  if (!Number.isFinite(shardId)) {
    return "0";
  }
  return String(Math.max(0, Math.floor(shardId)));
}


/**
 * The legacy sweep (a cross-partition query over cron-jobs every minute,
 * 200-500 RU a time) finds jobs created before the due index existed. Off
 * by default: deployments with such jobs run
 * POST /cron/admin/backfill-due-index once instead. CRON_LEGACY_SWEEP=true
 * (or the old CRON_DUE_INDEX_MIGRATED=false) turns it back on.
 */
function isLegacySweepDisabled(): boolean {
  const on = process.env.CRON_LEGACY_SWEEP;
  const migrated = process.env.CRON_DUE_INDEX_MIGRATED;
  return !(on === "true" || on === "1" || migrated === "false" || migrated === "0");
}

export function hasActiveRunningClaim(
  job: Pick<CronJob, "state">,
  nowMs = Date.now(),
): boolean {
  const token = job.state.runningToken;
  const runningAtMs = job.state.runningAtMs;
  if (!token || typeof runningAtMs !== "number") {
    return false;
  }
  return runningAtMs > nowMs - RUNNING_CLAIM_STALE_MS;
}

function isPreconditionFailedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e.code === 412 || e.code === "PreconditionFailed" || e.statusCode === 412
  );
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === 404 || e.code === "NotFound" || e.statusCode === 404;
}

function isConflictError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === 409 || e.code === "Conflict" || e.statusCode === 409;
}

// ============================================================================
// CronStore
// ============================================================================

export class CronStore {
  private db: DatabaseProvider;
  private jobs!: ContainerHandle<CronJob>;
  private dueIndex!: ContainerHandle<CronDueIndexDocument>;
  private heartbeatEvents!: ContainerHandle<CronHeartbeatEventDocument>;
  private runs!: ContainerHandle<CronRunDocument>;
  private initialized = false;
  private lastLegacyDueSweepAtMs = 0;

  constructor(db: DatabaseProvider) {
    this.db = db;
  }

  /**
   * Ensure the cron containers exist.
   * Safe to call multiple times — idempotent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.jobs = await this.db.getOrCreateContainer<CronJob>({
      id: CRON_JOBS_CONTAINER,
      partitionKey: {
        paths: ["/userId"],
        kind: PartitionKeyKind.Hash,
        version: 2,
      },
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [{ path: '/"_etag"/?' }],
      },
    });

    this.runs = await this.db.getOrCreateContainer<CronRunDocument>({
      id: CRON_RUNS_CONTAINER,
      partitionKey: {
        paths: ["/jobId"],
        kind: PartitionKeyKind.Hash,
        version: 2,
      },
      defaultTtl: DEFAULT_RUN_TTL_SECONDS,
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [{ path: '/"_etag"/?' }],
      },
    });

    this.dueIndex = await this.db.getOrCreateContainer<CronDueIndexDocument>({
      id: CRON_DUE_INDEX_CONTAINER,
      partitionKey: {
        paths: ["/shardId"],
        kind: PartitionKeyKind.Hash,
        version: 2,
      },
      // TTL enabled: orphaned due-index rows (from deleted jobs) are cleaned up
      // automatically. Active rows are refreshed on every sync so their TTL
      // resets. Rows for deleted jobs are removed immediately; this TTL is a
      // safety net for missed cleanups.
      defaultTtl: DUE_INDEX_TTL_SECONDS,
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [{ path: '/"_etag"/?' }],
      },
    });

    this.heartbeatEvents =
      await this.db.getOrCreateContainer<CronHeartbeatEventDocument>({
        id: CRON_HEARTBEAT_EVENTS_CONTAINER,
        partitionKey: {
          paths: ["/shardId"],
          kind: PartitionKeyKind.Hash,
          version: 2,
        },
        // TTL ensures dead-lettered events are cleaned up automatically.
        // Successful events are deleted immediately; only dead-lettered or
        // orphaned events rely on TTL for cleanup.
        defaultTtl: HEARTBEAT_EVENT_TTL_SECONDS,
        indexingPolicy: {
          automatic: true,
          indexingMode: "consistent",
          includedPaths: [{ path: "/*" }],
          excludedPaths: [{ path: '/"_etag"/?' }],
        },
      });

    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Job CRUD
  // --------------------------------------------------------------------------

  /**
   * Create a new cron job.
   */
  async createJob(input: CronJobCreate): Promise<CronJob> {
    await this.ensureInitialized();
    assertValidInputLengths(input);

    const nowMs = Date.now();
    const id = randomUUID();
    const shardId = getSchedulerShardForUser(input.userId);
    const sessionTarget = normalizeSessionTarget(
      (input as { sessionTarget?: unknown }).sessionTarget,
    );
    const wakeMode = normalizeWakeMode(
      (input as { wakeMode?: unknown }).wakeMode,
    );
    const schedule = normalizeEverySchedule(
      normalizeScheduleKind(input.schedule),
      nowMs,
    );
    const payload = normalizePayloadForCreate(
      input.payload as
        | CronPayload
        | { message?: string; model?: string; timeoutSeconds?: number },
      sessionTarget,
    );
    const delivery = normalizeDelivery(input.delivery);

    // Default deleteAfterRun to true for one-shot "at" schedules
    const deleteAfterRun =
      input.deleteAfterRun ?? (schedule.kind === "at" ? true : false);

    // Resolve expiresAt for recurring jobs
    const expiresAt: number | undefined =
      schedule.kind === "at"
        ? undefined
        : typeof input.expiresAt === "number" && Number.isFinite(input.expiresAt)
          ? Math.floor(input.expiresAt)
          : nowMs + getDefaultExpiryMs();

    // Compute initial next run
    const nextRunAtMs = computeJobNextRun({ id, schedule }, nowMs);

    const job: CronJob = {
      id,
      userId: input.userId,
      version: 1,
      shardId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      name: input.name,
      description: input.description,
      enabled: input.enabled,
      deleteAfterRun,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule,
      sessionTarget,
      wakeMode,
      payload,
      delivery,
      state: {
        nextRunAtMs,
        ...input.state,
      },
      expiresAt,
      maxRuns:
        typeof input.maxRuns === "number" &&
        Number.isFinite(input.maxRuns) &&
        input.maxRuns > 0
          ? Math.floor(input.maxRuns)
          : undefined,
    };

    assertSupportedJobSpec(job);
    assertValidSchedule(job);
    assertValidExpiry(job, nowMs);

    // Only once the new job is known to be valid: at the limit, finished jobs
    // make room, so they can't fill it forever. Active and paused jobs count.
    const maxJobsPerUser = getMaxJobsPerUser();
    if (maxJobsPerUser > 0) {
      const existingCount = await this.countJobs(input.userId);
      if (existingCount >= maxJobsPerUser) {
        const freed = await this.pruneFinishedJobs(input.userId, existingCount - maxJobsPerUser + 1, nowMs);
        if (existingCount - freed >= maxJobsPerUser) {
          throw new Error(`cron job limit exceeded for user (${maxJobsPerUser})`);
        }
      }
    }

    const created = await this.jobs.create(job);
    await this.syncDueIndexFromJobBestEffort(created);
    return created;
  }

  /**
   * Get a single job by id.
   */
  async getJob(jobId: string, userId: string): Promise<CronJob | null> {
    await this.ensureInitialized();
    return this.jobs.read(jobId, userId);
  }

  /**
   * List jobs for a user.
   */
  async listJobs(userId: string, includeDisabled = false): Promise<CronJob[]> {
    await this.ensureInitialized();

    const sql = includeDisabled
      ? "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.state.nextRunAtMs ASC"
      : "SELECT * FROM c WHERE c.userId = @userId AND c.enabled = true ORDER BY c.state.nextRunAtMs ASC";

    return this.jobs.queryWithParams<CronJob>(sql, [
      { name: "@userId", value: userId },
    ]);
  }

  /**
   * Update a job (partial patch).
   */
  async updateJob(
    jobId: string,
    userId: string,
    patch: CronJobPatch,
  ): Promise<CronJob | null> {
    await this.ensureInitialized();
    const raw = this.jobs.getRawContainer() as Container;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { resource } = await raw.item(jobId, userId).read<CronJob>();
      if (!resource) return null;
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (!etag) return null;

      const nowMs = Date.now();
      const mergedPayload = mergePayloadPatch(resource.payload, patch.payload);
      const mergedDelivery = mergeDeliveryPatch(
        resource.delivery,
        patch.delivery,
      );
      const mergedSessionTarget = patch.sessionTarget
        ? normalizeSessionTarget(patch.sessionTarget)
        : resource.sessionTarget;
      const mergedWakeMode = patch.wakeMode
        ? normalizeWakeMode(patch.wakeMode)
        : resource.wakeMode;
      const mergedScheduleRaw = normalizeScheduleKind(
        patch.schedule ?? resource.schedule,
      );
      const mergedSchedule = normalizeEverySchedule(
        mergedScheduleRaw,
        resource.schedule.kind === "every" &&
          typeof resource.schedule.anchorMs === "number"
          ? resource.schedule.anchorMs
          : nowMs,
      );

      // Resolve expiresAt: explicit patch wins, otherwise keep existing
      const mergedExpiresAt: number | undefined =
        patch.expiresAt !== undefined
          ? (typeof patch.expiresAt === "number" && Number.isFinite(patch.expiresAt)
              ? Math.floor(patch.expiresAt)
              : undefined)
          : resource.expiresAt;

      // Resolve maxRuns: explicit patch wins, otherwise keep existing
      const mergedMaxRuns: number | undefined =
        patch.maxRuns !== undefined
          ? (typeof patch.maxRuns === "number" &&
             Number.isFinite(patch.maxRuns) &&
             patch.maxRuns > 0
              ? Math.floor(patch.maxRuns)
              : undefined)
          : resource.maxRuns;

      const updated: CronJob = {
        ...resource,
        ...patch,
        id: resource.id,
        userId: resource.userId,
        version: nextJobVersion(resource),
        shardId: resolveJobShardId(resource),
        createdAtMs: resource.createdAtMs,
        updatedAtMs: nowMs,
        sessionTarget: mergedSessionTarget,
        wakeMode: mergedWakeMode,
        schedule: mergedSchedule,
        payload: mergedPayload,
        delivery: mergedDelivery,
        state: { ...resource.state, ...patch.state },
        expiresAt: mergedExpiresAt,
        maxRuns: mergedMaxRuns,
      };

      assertSupportedJobSpec(updated);
      assertValidSchedule(updated);
      assertValidInputLengths(updated);
      // Skip expiry validation when the caller is an internal state update
      // (e.g., applyResult setting lastStatus), and when the job is being
      // turned off: disabling an expired job must always be possible (it is
      // exactly how applyResult retires one that expired mid-run).
      if (
        updated.enabled &&
        (patch.expiresAt !== undefined ||
          patch.schedule !== undefined ||
          patch.enabled !== undefined)
      ) {
        assertValidExpiry(updated, nowMs);
      }

      // Recompute nextRunAtMs if schedule or enabled changed
      if (
        patch.schedule ||
        patch.enabled !== undefined ||
        patch.sessionTarget !== undefined ||
        patch.payload !== undefined
      ) {
        if (updated.enabled) {
          updated.state.nextRunAtMs = computeJobNextRun(updated, nowMs);
        } else {
          updated.state.nextRunAtMs = undefined;
        }
      }

      try {
        const { resource: replaced } = await raw
          .item(jobId, userId)
          .replace<CronJob>(updated, {
            accessCondition: { type: "IfMatch", condition: etag },
          });
        const final = replaced ?? updated;
        await this.syncDueIndexFromJobBestEffort(final, {
          previousShardId:
            typeof resource.shardId === "number"
              ? normalizeSchedulerShardId(resource.shardId)
              : undefined,
        });
        return final;
      } catch (err) {
        if (isPreconditionFailedError(err)) {
          continue;
        }
        throw err;
      }
    }

    throw new Error("concurrent cron update contention; retry");
  }

  /**
   * Delete a job.
   */
  async deleteJob(jobId: string, userId: string): Promise<boolean> {
    await this.ensureInitialized();
    const existing = await this.jobs.read(jobId, userId);
    if (!existing) {
      return false;
    }
    const deleted = await this.jobs.delete(jobId, userId);
    if (deleted) {
      await this.deleteDueIndexRowsForJobBestEffort(
        jobId,
        resolveJobShardId(existing),
      );
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // Scheduler Queries
  // --------------------------------------------------------------------------

  /**
   * Find and atomically claim all due jobs.
   *
   * Primary path uses a shard-partitioned due-index container.
   * Legacy fallback reads cron-jobs directly so pre-index jobs still run.
   */
  async getDueJobs(nowMs: number, shardId: number): Promise<CronJob[]> {
    await this.ensureInitialized();
    const staleBeforeMs = nowMs - RUNNING_CLAIM_STALE_MS;
    const normalizedShardId = normalizeSchedulerShardId(shardId);
    const maxDueJobs = getMaxDueJobsPerTick();

    let candidates = await this.queryDueIndexCandidates(
      nowMs,
      normalizedShardId,
      staleBeforeMs,
      maxDueJobs,
    );
    const shouldSweepLegacy =
      !isLegacySweepDisabled() &&
      (candidates.length === 0 ||
        nowMs - this.lastLegacyDueSweepAtMs >= LEGACY_SWEEP_INTERVAL_MS);
    if (shouldSweepLegacy) {
      this.lastLegacyDueSweepAtMs = nowMs;
      const remainingSlots = Math.max(0, maxDueJobs - candidates.length);
      const legacyDueJobs =
        remainingSlots > 0
          ? await this.queryLegacyDueJobs(
              nowMs,
              normalizedShardId,
              staleBeforeMs,
              remainingSlots,
            )
          : [];
      const seen = new Set(candidates.map((c) => `${c.jobId}:${c.userId}`));
      for (const legacyJob of legacyDueJobs) {
        await this.syncDueIndexFromJobBestEffort(legacyJob);
        const key = `${legacyJob.id}:${legacyJob.userId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        candidates.push({
          id: legacyJob.id,
          jobId: legacyJob.id,
          userId: legacyJob.userId,
        });
        if (candidates.length >= maxDueJobs) {
          break;
        }
      }
    }

    // Claim candidates in parallel with bounded concurrency.
    // Each claim is an independent optimistic-concurrency operation against
    // a different document, so parallel claims are safe and dramatically
    // reduce wall-clock time (100 serial claims @ ~50ms = 5s → parallel = ~200ms).
    const CLAIM_BATCH_SIZE = CLAIM_CONCURRENCY;
    const claimed: CronJob[] = [];
    for (let i = 0; i < candidates.length; i += CLAIM_BATCH_SIZE) {
      const batch = candidates.slice(i, i + CLAIM_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((candidate) =>
          this.tryClaimJob(
            { id: candidate.jobId, userId: candidate.userId },
            nowMs,
            staleBeforeMs,
            normalizedShardId,
          ),
        ),
      );
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          claimed.push(result.value);
        }
      }
    }
    return claimed;
  }

  /**
   * Queue a main-session system event for the next heartbeat flush.
   * Used by wakeMode="next-heartbeat".
   */
  async enqueueHeartbeatEvent(
    job: Pick<CronJob, "id" | "userId" | "agentId" | "sessionId" | "shardId">,
    text: string,
    nowMs = Date.now(),
    dueAtMs?: number,
  ): Promise<CronHeartbeatEventDocument> {
    await this.ensureInitialized();

    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error("heartbeat event text must be non-empty");
    }

    // Per-user heartbeat event cap: prevent queue flooding.
    // Count pending (non-dead-lettered) events for this user across all shards.
    const maxPendingEvents = MAX_PENDING_HEARTBEAT_EVENTS_PER_USER;
    const raw = this.heartbeatEvents.getRawContainer() as Container;
    const countQuery =
      "SELECT VALUE COUNT(1) FROM c " +
      "WHERE c.userId = @userId " +
      "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null)";
    const { resources: countResults } = await raw.items
      .query<number>({
        query: countQuery,
        parameters: [{ name: "@userId", value: job.userId }],
      })
      .fetchAll();
    const pendingCount = countResults[0] ?? 0;
    if (pendingCount >= maxPendingEvents) {
      throw new Error(
        `Heartbeat event limit exceeded for user (${maxPendingEvents} pending events)`,
      );
    }

    const shardId = toDueIndexShardId(resolveJobShardId(job));
    const resolvedDueAtMs =
      typeof dueAtMs === "number" && Number.isFinite(dueAtMs)
        ? Math.max(0, Math.floor(dueAtMs))
        : resolveNextHeartbeatAtMs(nowMs, getHeartbeatIntervalMs());
    const doc: CronHeartbeatEventDocument = {
      id: randomUUID(),
      jobId: job.id,
      userId: job.userId,
      shardId,
      agentId: job.agentId,
      sessionId: job.sessionId,
      text: normalizedText,
      dueAtMs: resolvedDueAtMs,
      enqueuedAtMs: nowMs,
      updatedAtMs: nowMs,
      attempts: 0,
      ttl: HEARTBEAT_EVENT_TTL_SECONDS,
    };

    return this.heartbeatEvents.create(doc);
  }

  /**
   * Read a queued heartbeat event by id.
   */
  async getHeartbeatEvent(
    eventId: string,
    shardId: number,
  ): Promise<CronHeartbeatEventDocument | null> {
    await this.ensureInitialized();
    const partitionKey = toDueIndexShardId(normalizeSchedulerShardId(shardId));
    try {
      const event = await this.heartbeatEvents.read(eventId, partitionKey);
      return event ?? null;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Claim due heartbeat events for processing.
   */
  async claimDueHeartbeatEvents(
    nowMs: number,
    shardId: number,
    limit = getMaxHeartbeatEventsPerClaim(),
    target?: {
      userId: string;
      agentId?: string;
      sessionId?: string;
    },
  ): Promise<CronHeartbeatEventDocument[]> {
    await this.ensureInitialized();
    const staleBeforeMs = nowMs - RUNNING_CLAIM_STALE_MS;
    const normalizedShardId = normalizeSchedulerShardId(shardId);
    const maxPerClaim = getMaxHeartbeatEventsPerClaim();
    const normalizedLimit = Math.min(
      Math.max(1, Math.floor(limit)),
      maxPerClaim,
    );

    const candidates = await this.queryDueHeartbeatEventCandidates(
      nowMs,
      normalizedShardId,
      staleBeforeMs,
      normalizedLimit,
      target,
    );

    const claimed: CronHeartbeatEventDocument[] = [];
    for (const candidate of candidates) {
      const event = await this.tryClaimHeartbeatEvent(
        candidate,
        nowMs,
        staleBeforeMs,
        normalizedShardId,
      );
      if (event) claimed.push(event);
    }
    return claimed;
  }

  /**
   * Count due heartbeat events for a specific target.
   *
   * Uses a Cosmos COUNT() aggregate for RU efficiency — only the scalar
   * count is returned instead of full candidate documents.
   *
   * Used to protect wake-now hot path under burst loads.
   */
  async countDueHeartbeatEventsForTarget(
    nowMs: number,
    shardId: number,
    target: {
      userId: string;
      agentId?: string;
      sessionId?: string;
    },
    _sampleLimit: number,
  ): Promise<number> {
    await this.ensureInitialized();
    const staleBeforeMs = nowMs - RUNNING_CLAIM_STALE_MS;
    const normalizedShardId = normalizeSchedulerShardId(shardId);
    const raw = this.heartbeatEvents.getRawContainer() as Container;

    const targetAgentId =
      typeof target.agentId === "string" && target.agentId.trim().length > 0
        ? target.agentId.trim()
        : undefined;
    const targetSessionId =
      typeof target.sessionId === "string" &&
      target.sessionId.trim().length > 0
        ? target.sessionId.trim()
        : undefined;

    const query =
      "SELECT VALUE COUNT(1) FROM c " +
      "WHERE IS_DEFINED(c.dueAtMs) AND c.dueAtMs <= @nowMs " +
      "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null) " +
      "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
      "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
      "AND c.userId = @userId " +
      (targetAgentId
        ? "AND c.agentId = @agentId "
        : "AND (NOT IS_DEFINED(c.agentId) OR c.agentId = null) ") +
      (targetSessionId
        ? "AND c.sessionId = @sessionId "
        : "AND (NOT IS_DEFINED(c.sessionId) OR c.sessionId = null) ");

    const parameters: Array<{
      name: string;
      value: string | number | boolean | null;
    }> = [
      { name: "@nowMs", value: nowMs },
      { name: "@staleBeforeMs", value: staleBeforeMs },
      { name: "@userId", value: target.userId },
    ];
    if (targetAgentId) {
      parameters.push({ name: "@agentId", value: targetAgentId });
    }
    if (targetSessionId) {
      parameters.push({ name: "@sessionId", value: targetSessionId });
    }

    const { resources } = await raw.items
      .query<number>(
        { query, parameters },
        { partitionKey: toDueIndexShardId(normalizedShardId) },
      )
      .fetchAll();

    return resources.length > 0 ? resources[0] : 0;
  }

  /**
   * Complete a claimed heartbeat event by deleting it.
   */
  async completeHeartbeatEvent(
    eventId: string,
    shardId: number,
    runningToken: string,
  ): Promise<void> {
    await this.ensureInitialized();
    const partitionKey = toDueIndexShardId(normalizeSchedulerShardId(shardId));
    const raw = this.heartbeatEvents.getRawContainer() as Container;

    try {
      const { resource } = await raw
        .item(eventId, partitionKey)
        .read<CronHeartbeatEventDocument>();
      if (!resource) return;
      if (resource.runningToken !== runningToken) return;
      await raw.item(eventId, partitionKey).delete();
    } catch (err) {
      if (isNotFoundError(err)) return;
      throw err;
    }
  }

  /**
   * Release a claimed heartbeat event and retry later.
   * If max-attempt cutoff is reached, marks the event dead-lettered.
   */
  async releaseHeartbeatEventClaim(
    eventId: string,
    shardId: number,
    runningToken: string,
    retryDelayMs = 30_000,
    error?: string,
  ): Promise<void> {
    await this.ensureInitialized();
    const partitionKey = toDueIndexShardId(normalizeSchedulerShardId(shardId));
    const raw = this.heartbeatEvents.getRawContainer() as Container;
    const nowMs = Date.now();
    const retryAtMs = nowMs + Math.max(1_000, Math.floor(retryDelayMs));

    try {
      const { resource } = await raw
        .item(eventId, partitionKey)
        .read<CronHeartbeatEventDocument>();
      if (!resource) return;
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (!etag) return;
      if (resource.runningToken !== runningToken) return;
      const maxAttempts = getHeartbeatMaxAttempts();
      const attempts = resource.attempts ?? 0;
      const normalizedError =
        typeof error === "string" && error.trim().length > 0
          ? error.trim().slice(0, 500)
          : undefined;

      if (maxAttempts > 0 && attempts >= maxAttempts) {
        const updatedDeadLetter: CronHeartbeatEventDocument = {
          ...resource,
          runningAtMs: undefined,
          runningToken: undefined,
          updatedAtMs: nowMs,
          lastError:
            normalizedError ??
            resource.lastError ??
            "heartbeat max attempts exceeded",
          deadLetteredAtMs: nowMs,
          deadLetterReason: `max-attempt-cutoff:${maxAttempts}`,
        };

        await raw
          .item(eventId, partitionKey)
          .replace<CronHeartbeatEventDocument>(updatedDeadLetter, {
            accessCondition: { type: "IfMatch", condition: etag },
          });
        return;
      }

      const updated: CronHeartbeatEventDocument = {
        ...resource,
        dueAtMs: retryAtMs,
        runningAtMs: undefined,
        runningToken: undefined,
        updatedAtMs: nowMs,
        lastError: normalizedError,
      };

      await raw
        .item(eventId, partitionKey)
        .replace<CronHeartbeatEventDocument>(updated, {
          accessCondition: { type: "IfMatch", condition: etag },
        });
    } catch (err) {
      if (isNotFoundError(err) || isPreconditionFailedError(err)) return;
      throw err;
    }
  }

  /**
   * Mark a claimed job as started.
   * Returns null when the claim is missing/stale/already started.
   */
  async beginClaimedRun(
    jobId: string,
    userId: string,
    runningToken: string,
  ): Promise<CronJob | null> {
    await this.ensureInitialized();

    const raw = this.jobs.getRawContainer() as Container;
    try {
      const { resource } = await raw.item(jobId, userId).read<CronJob>();
      if (!resource) return null;
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (!etag) return null;

      if (resource.state.runningToken !== runningToken) return null;
      if (typeof resource.state.runningStartedAtMs === "number") return null;

      const updated: CronJob = {
        ...resource,
        version: nextJobVersion(resource),
        state: {
          ...resource.state,
          runningStartedAtMs: Date.now(),
        },
      };

      const { resource: replaced } = await raw
        .item(jobId, userId)
        .replace<CronJob>(updated, {
          accessCondition: { type: "IfMatch", condition: etag },
        });
      return replaced ?? null;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      if (isPreconditionFailedError(err)) return null;
      throw err;
    }
  }

  /**
   * Acquire a running claim for an ad-hoc/force run.
   * Returns null when the job is missing or already actively claimed.
   */
  async claimJobForForceRun(
    jobId: string,
    userId: string,
  ): Promise<CronJob | null> {
    await this.ensureInitialized();

    const raw = this.jobs.getRawContainer() as Container;
    const nowMs = Date.now();
    const staleBeforeMs = nowMs - RUNNING_CLAIM_STALE_MS;

    try {
      const { resource } = await raw.item(jobId, userId).read<CronJob>();
      if (!resource) return null;
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (!etag) return null;

      if (
        resource.state.runningToken &&
        typeof resource.state.runningAtMs === "number" &&
        resource.state.runningAtMs > staleBeforeMs
      ) {
        return null;
      }

      const resourceShardId = resolveJobShardId(resource);
      const updated: CronJob = {
        ...resource,
        version: nextJobVersion(resource),
        shardId: resourceShardId,
        state: {
          ...resource.state,
          runningAtMs: nowMs,
          runningToken: randomUUID(),
          runningStartedAtMs: undefined,
        },
      };

      const { resource: replaced } = await raw
        .item(jobId, userId)
        .replace<CronJob>(updated, {
          accessCondition: { type: "IfMatch", condition: etag },
        });

      if (replaced) {
        await this.syncDueIndexFromJobBestEffort(replaced, {
          previousShardId: resourceShardId,
        });
      }
      return replaced ?? null;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      if (isPreconditionFailedError(err)) return null;
      throw err;
    }
  }

  /**
   * Best-effort release of a running claim when execution persistence fails.
   * Claim is released only if the token still matches.
   */
  async releaseRunningClaim(
    jobId: string,
    userId: string,
    runningToken: string,
  ): Promise<void> {
    await this.ensureInitialized();

    const raw = this.jobs.getRawContainer() as Container;
    try {
      const { resource } = await raw.item(jobId, userId).read<CronJob>();
      if (!resource) return;
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (!etag) return;
      if (resource.state.runningToken !== runningToken) return;

      const updated: CronJob = {
        ...resource,
        version: nextJobVersion(resource),
        state: {
          ...resource.state,
          runningAtMs: undefined,
          runningToken: undefined,
          runningStartedAtMs: undefined,
        },
      };
      const { resource: replaced } = await raw
        .item(jobId, userId)
        .replace<CronJob>(updated, {
          accessCondition: { type: "IfMatch", condition: etag },
        });
      if (replaced) {
        await this.syncDueIndexFromJobBestEffort(replaced);
      }
    } catch (err) {
      if (isNotFoundError(err) || isPreconditionFailedError(err)) return;
      throw err;
    }
  }

  /**
   * Compute the next wake time across all jobs.
   * Returns the earliest nextRunAtMs, or undefined if no jobs are scheduled.
   */
  async computeNextWakeMs(shardId: number): Promise<number | undefined> {
    await this.ensureInitialized();
    const staleBeforeMs = Date.now() - RUNNING_CLAIM_STALE_MS;
    const normalizedShardId = normalizeSchedulerShardId(shardId);

    const dueIndexNextWake = await this.queryDueIndexNextWakeMs(
      normalizedShardId,
      staleBeforeMs,
    );
    const heartbeatNextWake = await this.queryHeartbeatNextWakeMs(
      normalizedShardId,
      staleBeforeMs,
    );

    let legacyNextWake: number | undefined;
    if (!isLegacySweepDisabled()) {
      const legacyCandidate = await this.queryLegacyNextWake(
        normalizedShardId,
        staleBeforeMs,
      );
      if (legacyCandidate) {
        const legacyJob = await this.jobs.read(
          legacyCandidate.jobId,
          legacyCandidate.userId,
        );
        if (legacyJob) {
          await this.syncDueIndexFromJobBestEffort(legacyJob);
        }
        legacyNextWake = legacyCandidate.nextRunAtMs;
      }
    }

    const wakeCandidates = [
      dueIndexNextWake,
      heartbeatNextWake,
      legacyNextWake,
    ].filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
    if (wakeCandidates.length === 0) {
      return undefined;
    }
    return Math.min(...wakeCandidates);
  }

  // --------------------------------------------------------------------------
  // Job State Updates
  // --------------------------------------------------------------------------

  /**
   * Apply an execution result to a job.
   *
   * Handles:
   * - Consecutive error tracking + backoff
   * - One-shot disable/delete
   * - Next run recomputation
   */
  async applyResult(
    job: CronJob,
    result: JobResult,
    opts?: { runningToken?: string },
  ): Promise<{ action: "updated" | "deleted" | "disabled" | "stale" }> {
    await this.ensureInitialized();
    let effectiveJob = job;

    // Optional token guard: only apply result if the running claim still belongs
    // to this execution attempt.
    if (opts?.runningToken) {
      const current = await this.jobs.read(job.id, job.userId);
      if (!current) return { action: "deleted" };
      if (current.state.runningToken !== opts.runningToken) {
        return { action: "stale" };
      }
      effectiveJob = current;
    }

    const nowMs = Date.now();
    const isOneShot = effectiveJob.schedule.kind === "at";
    const isSuccess = result.status === "ok";

    // The job didn't run: try again later, without counting a failure. A
    // one-shot reminder would otherwise be disabled and never delivered.
    if (typeof result.retryAfterMs === "number") {
      await this.updateJob(effectiveJob.id, effectiveJob.userId, {
        state: {
          lastStatus: result.status,
          lastError: result.summary,
          nextRunAtMs: nowMs + result.retryAfterMs,
          runningAtMs: undefined,
          runningToken: undefined,
          runningStartedAtMs: undefined,
        },
      });
      return { action: "updated" };
    }

    /** Turn the job off, recording this run and clearing the running claim. */
    const disable = async (state: Partial<CronJobState>) => {
      await this.updateJob(effectiveJob.id, effectiveJob.userId, {
        enabled: false,
        state: {
          lastRunAtMs: nowMs,
          lastStatus: result.status,
          lastError: result.error,
          lastDurationMs: result.durationMs,
          nextRunAtMs: undefined,
          consecutiveErrors: 0,
          runningAtMs: undefined,
          runningToken: undefined,
          runningStartedAtMs: undefined,
          ...state,
        },
      });
      return { action: "disabled" as const };
    };

    // One-shot jobs: delete on success, retry on delivery failure, disable on other failures
    if (isOneShot) {
      if (effectiveJob.deleteAfterRun && isSuccess) {
        await this.jobs.delete(effectiveJob.id, effectiveJob.userId);
        await this.deleteDueIndexRowsForJobBestEffort(
          effectiveJob.id,
          resolveJobShardId(effectiveJob),
        );
        return { action: "deleted" };
      }

      // Delivery failures on one-shot jobs get limited retries with backoff.
      // This prevents permanent loss of user reminders due to transient
      // delivery issues (user offline, adapter error, target resolution).
      const maxRetries = MAX_ONE_SHOT_DELIVERY_RETRIES;
      const isDeliveryFailure =
        !isSuccess && !!result.error?.startsWith("Channel delivery failed");
      const consecutiveErrors = isSuccess
        ? 0
        : (effectiveJob.state.consecutiveErrors ?? 0) + 1;

      if (isDeliveryFailure && consecutiveErrors <= maxRetries) {
        const backoffMs = getBackoffMs(consecutiveErrors);
        console.warn(
          `[cron-store] One-shot job ${effectiveJob.id} delivery failed (attempt ${consecutiveErrors}/${maxRetries}), ` +
            `retrying in ${Math.round(backoffMs / 1000)}s: ${result.error}`,
        );
        await this.updateJob(effectiveJob.id, effectiveJob.userId, {
          state: {
            lastRunAtMs: nowMs,
            lastStatus: result.status,
            lastError: result.error,
            lastDurationMs: result.durationMs,
            nextRunAtMs: nowMs + backoffMs,
            consecutiveErrors,
            runningAtMs: undefined,
            runningToken: undefined,
            runningStartedAtMs: undefined,
          },
        });
        return { action: "updated" };
      }

      // Disable after terminal run (success without deleteAfterRun, execution
      // failure, or delivery retries exhausted)
      return disable({ consecutiveErrors });
    }

    // Recurring jobs: compute next run with backoff
    const consecutiveErrors = isSuccess
      ? 0
      : (effectiveJob.state.consecutiveErrors ?? 0) + 1;

    // Track successful run count for maxRuns limit
    const runCount = (effectiveJob.state.runCount ?? 0) + (isSuccess ? 1 : 0);

    let nextRunAtMs = computeJobNextRun(effectiveJob, nowMs);

    // Apply backoff: next run = max(naturalNextRun, now + backoff)
    if (consecutiveErrors > 0 && nextRunAtMs !== undefined) {
      const backoffMs = getBackoffMs(consecutiveErrors);
      const backoffTime = nowMs + backoffMs;
      nextRunAtMs = Math.max(nextRunAtMs, backoffTime);
    }

    // Check if the job has expired (or will expire before next run)
    if (isJobExpired(effectiveJob, nowMs)) {
      return disable({ lastStatus: "expired", runCount });
    }

    // A permanent failure (e.g. a refused delivery recipient): stop the job.
    if (result.disableJob) {
      return disable({ runCount });
    }

    // Check if maxRuns limit has been reached
    if (
      typeof effectiveJob.maxRuns === "number" &&
      effectiveJob.maxRuns > 0 &&
      runCount >= effectiveJob.maxRuns
    ) {
      return disable({ runCount });
    }
    // No run left before expiry: retire the job now rather than leave it
    // enabled with nothing scheduled, where it would never be retired.
    if (
      nextRunAtMs !== undefined &&
      typeof effectiveJob.expiresAt === "number" &&
      nextRunAtMs > effectiveJob.expiresAt
    ) {
      return disable({ lastStatus: "expired", runCount });
    }

    await this.updateJob(effectiveJob.id, effectiveJob.userId, {
      state: {
        lastRunAtMs: nowMs,
        lastStatus: result.status,
        lastError: result.error,
        lastDurationMs: result.durationMs,
        nextRunAtMs,
        consecutiveErrors,
        runningAtMs: undefined,
        runningToken: undefined,
        runningStartedAtMs: undefined,
        runCount,
      },
    });

    return { action: "updated" };
  }

  // --------------------------------------------------------------------------
  // Run History
  // --------------------------------------------------------------------------

  /**
   * Record a completed run.
   */
  async recordRun(
    job: CronJob,
    result: JobResult,
    ttlSeconds = DEFAULT_RUN_TTL_SECONDS,
  ): Promise<void> {
    await this.ensureInitialized();

    const run: CronRunDocument = {
      id: randomUUID(),
      jobId: job.id,
      userId: job.userId,
      ts: Date.now(),
      status: result.status,
      error: result.error,
      summary: result.summary,
      durationMs: result.durationMs,
      model: result.model,
      usage: result.usage,
      delivered: result.delivered,
      deliveryChannel: result.deliveryChannel,
      ttl: ttlSeconds,
    };

    await this.runs.create(run);
  }

  /**
   * Get run history for a job.
   */
  async getRuns(
    jobId: string,
    limit = MAX_RUNS_PER_QUERY,
  ): Promise<CronRunDocument[]> {
    await this.ensureInitialized();

    const effectiveLimit = Math.min(Math.max(1, limit), MAX_RUNS_PER_QUERY);

    return this.runs.queryWithParams<CronRunDocument>(
      `SELECT TOP ${effectiveLimit} * FROM c WHERE c.jobId = @jobId ORDER BY c.ts DESC`,
      [{ name: "@jobId", value: jobId }],
    );
  }

  /**
   * Count total jobs for a user.
   */
  /**
   * Delete up to `count` of a user's finished jobs (see isFinishedJob),
   * least recently updated first. Each delete is etag-guarded, so a job
   * changed since it was read (re-enabled, say) is left alone.
   */
  private async pruneFinishedJobs(userId: string, count: number, nowMs: number): Promise<number> {
    const jobs = await this.jobs.queryWithParams<CronJob>(
      "SELECT * FROM c WHERE c.userId = @userId",
      [{ name: "@userId", value: userId }],
    );
    const finished = jobs.filter((job) => isFinishedJob(job, nowMs));
    finished.sort((a, b) => (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0));
    const raw = this.jobs.getRawContainer() as Container;
    let freed = 0;
    for (const job of finished.slice(0, count)) {
      const etag = (job as unknown as { _etag?: string })._etag;
      try {
        await raw.item(job.id, userId).delete(etag ? { accessCondition: { type: "IfMatch", condition: etag } } : undefined);
      } catch (err) {
        if (isPreconditionFailedError(err) || isNotFoundError(err)) continue;
        throw err;
      }
      await this.deleteDueIndexRowsForJobBestEffort(job.id, resolveJobShardId(job));
      freed++;
    }
    return freed;
  }

  async countJobs(userId: string): Promise<number> {
    await this.ensureInitialized();
    return this.jobs.count("c.userId = @userId", [
      { name: "@userId", value: userId },
    ]);
  }

  private async queryDueIndexCandidates(
    nowMs: number,
    shardId: number,
    staleBeforeMs: number,
    limit: number,
  ): Promise<DueIndexCandidate[]> {
    const raw = this.dueIndex.getRawContainer() as Container;
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1_000);
    const { resources } = await raw.items
      .query<DueIndexCandidate>(
        {
          query:
            `SELECT TOP ${safeLimit} c.id, c.id AS jobId, c.userId FROM c ` +
            "WHERE c.enabled = true " +
            "AND IS_DEFINED(c.nextRunAtMs) AND c.nextRunAtMs != null AND c.nextRunAtMs <= @nowMs " +
            "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
            "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
            "ORDER BY c.nextRunAtMs ASC",
          parameters: [
            { name: "@nowMs", value: nowMs },
            { name: "@staleBeforeMs", value: staleBeforeMs },
          ],
        },
        { partitionKey: toDueIndexShardId(shardId) },
      )
      .fetchAll();
    return resources;
  }

  private async queryDueHeartbeatEventCandidates(
    nowMs: number,
    shardId: number,
    staleBeforeMs: number,
    limit: number,
    target?: {
      userId: string;
      agentId?: string;
      sessionId?: string;
    },
  ): Promise<HeartbeatEventCandidate[]> {
    const raw = this.heartbeatEvents.getRawContainer() as Container;
    const hasTarget = !!target;
    const targetAgentId =
      typeof target?.agentId === "string" && target.agentId.trim().length > 0
        ? target.agentId.trim()
        : undefined;
    const targetSessionId =
      typeof target?.sessionId === "string" &&
      target.sessionId.trim().length > 0
        ? target.sessionId.trim()
        : undefined;
    const query =
      `SELECT TOP ${limit} * FROM c ` +
      "WHERE IS_DEFINED(c.dueAtMs) AND c.dueAtMs <= @nowMs " +
      "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null) " +
      "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
      "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
      (hasTarget
        ? "AND c.userId = @userId " +
          (targetAgentId
            ? "AND c.agentId = @agentId "
            : "AND (NOT IS_DEFINED(c.agentId) OR c.agentId = null) ") +
          (targetSessionId
            ? "AND c.sessionId = @sessionId "
            : "AND (NOT IS_DEFINED(c.sessionId) OR c.sessionId = null) ")
        : "") +
      "ORDER BY c.dueAtMs ASC";
    const parameters: Array<{
      name: string;
      value: string | number | boolean | null;
    }> = [
      { name: "@nowMs", value: nowMs },
      { name: "@staleBeforeMs", value: staleBeforeMs },
    ];
    if (hasTarget) {
      parameters.push({ name: "@userId", value: target!.userId });
      if (targetAgentId) {
        parameters.push({ name: "@agentId", value: targetAgentId });
      }
      if (targetSessionId) {
        parameters.push({ name: "@sessionId", value: targetSessionId });
      }
    }
    const { resources } = await raw.items
      .query<HeartbeatEventCandidate>(
        {
          query,
          parameters,
        },
        { partitionKey: toDueIndexShardId(shardId) },
      )
      .fetchAll();
    return resources;
  }

  private async queryLegacyDueJobs(
    nowMs: number,
    shardId: number,
    staleBeforeMs: number,
    limit: number,
  ): Promise<CronJob[]> {
    const shardCount = getSchedulerShardCount();
    const safeLimit = Math.min(
      Math.max(1, Math.floor(limit)),
      LEGACY_SWEEP_MAX_JOBS,
    );
    return this.jobs.queryWithParams<CronJob>(
      `SELECT TOP ${safeLimit} * FROM c WHERE c.enabled = true AND c.state.nextRunAtMs <= @nowMs ` +
        "AND ((IS_DEFINED(c.shardId) AND " +
        "(c.shardId = @shardId OR (IS_NUMBER(c.shardId) AND (c.shardId % @shardCount) = @shardId))) " +
        "OR NOT IS_DEFINED(c.shardId)) " +
        "AND (NOT IS_DEFINED(c.state.runningToken) OR c.state.runningToken = null " +
        "OR (IS_DEFINED(c.state.runningAtMs) AND c.state.runningAtMs <= @staleBeforeMs)) " +
        "ORDER BY c.state.nextRunAtMs ASC",
      [
        { name: "@nowMs", value: nowMs },
        { name: "@shardId", value: shardId },
        { name: "@shardCount", value: shardCount },
        { name: "@staleBeforeMs", value: staleBeforeMs },
      ],
    );
  }

  private async queryDueIndexNextWakeMs(
    shardId: number,
    staleBeforeMs: number,
  ): Promise<number | undefined> {
    const raw = this.dueIndex.getRawContainer() as Container;
    const { resources } = await raw.items
      .query<{ nextRunAtMs: number }>(
        {
          query:
            "SELECT TOP 1 c.nextRunAtMs AS nextRunAtMs FROM c " +
            "WHERE c.enabled = true " +
            "AND IS_DEFINED(c.nextRunAtMs) AND c.nextRunAtMs != null " +
            "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
            "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
            "ORDER BY c.nextRunAtMs ASC",
          parameters: [{ name: "@staleBeforeMs", value: staleBeforeMs }],
        },
        { partitionKey: toDueIndexShardId(shardId) },
      )
      .fetchAll();
    return resources.length > 0 ? resources[0].nextRunAtMs : undefined;
  }

  private async queryHeartbeatNextWakeMs(
    shardId: number,
    staleBeforeMs: number,
  ): Promise<number | undefined> {
    const raw = this.heartbeatEvents.getRawContainer() as Container;
    const { resources } = await raw.items
      .query<{ dueAtMs: number }>(
        {
          query:
            "SELECT TOP 1 c.dueAtMs AS dueAtMs FROM c " +
            "WHERE IS_DEFINED(c.dueAtMs) " +
            "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null) " +
            "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
            "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
            "ORDER BY c.dueAtMs ASC",
          parameters: [{ name: "@staleBeforeMs", value: staleBeforeMs }],
        },
        { partitionKey: toDueIndexShardId(shardId) },
      )
      .fetchAll();
    return resources.length > 0 ? resources[0].dueAtMs : undefined;
  }

  private async queryLegacyNextWake(
    shardId: number,
    staleBeforeMs: number,
  ): Promise<NextWakeCandidate | undefined> {
    const shardCount = getSchedulerShardCount();
    const results = await this.jobs.queryWithParams<NextWakeCandidate>(
      "SELECT TOP 1 c.id, c.id AS jobId, c.userId, c.state.nextRunAtMs AS nextRunAtMs FROM c " +
        "WHERE c.enabled = true AND IS_DEFINED(c.state.nextRunAtMs) " +
        "AND c.state.nextRunAtMs != null " +
        "AND ((IS_DEFINED(c.shardId) AND " +
        "(c.shardId = @shardId OR (IS_NUMBER(c.shardId) AND (c.shardId % @shardCount) = @shardId))) " +
        "OR NOT IS_DEFINED(c.shardId)) " +
        "AND (NOT IS_DEFINED(c.state.runningToken) OR c.state.runningToken = null " +
        "OR (IS_DEFINED(c.state.runningAtMs) AND c.state.runningAtMs <= @staleBeforeMs)) " +
        "ORDER BY c.state.nextRunAtMs ASC",
      [
        { name: "@shardId", value: shardId },
        { name: "@shardCount", value: shardCount },
        { name: "@staleBeforeMs", value: staleBeforeMs },
      ],
    );
    return results.length > 0 ? results[0] : undefined;
  }

  private toDueIndexDocument(job: CronJob): CronDueIndexDocument | null {
    const nextRunAtMs = job.state.nextRunAtMs;
    if (
      !job.enabled ||
      typeof nextRunAtMs !== "number" ||
      !Number.isFinite(nextRunAtMs)
    ) {
      return null;
    }

    return {
      id: job.id,
      jobId: job.id,
      userId: job.userId,
      shardId: toDueIndexShardId(resolveJobShardId(job)),
      jobVersion: resolveJobVersion(job),
      enabled: true,
      nextRunAtMs,
      runningToken: job.state.runningToken,
      runningAtMs: job.state.runningAtMs,
      updatedAtMs: Date.now(),
      // TTL: a row lives until its run time plus the grace period. A row is
      // rewritten only when its job is created, claimed, run or edited, so a
      // fixed TTL would expire a job due further out than the TTL (a
      // reminder in two weeks) before it ever ran. The grace period cleans
      // up rows orphaned by a missed delete.
      ttl: Math.min(
        MAX_COSMOS_TTL_SECONDS,
        DUE_INDEX_TTL_SECONDS + Math.max(0, Math.ceil((nextRunAtMs - Date.now()) / 1000)),
      ),
    };
  }

  /**
   * Index every enabled job in the due index (one cross-partition scan).
   * For deployments with jobs created before the index existed; safe to
   * run again. Returns how many jobs were indexed and how many failed.
   */
  async backfillDueIndex(): Promise<{ indexed: number; failed: number }> {
    await this.ensureInitialized();
    const jobs = await this.jobs.queryWithParams<CronJob>(
      "SELECT * FROM c WHERE c.enabled = true",
    );
    let indexed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await this.syncDueIndexFromJob(job);
        indexed++;
      } catch (err) {
        failed++;
        console.warn(
          `[cron-store] backfill: job ${job.id} not indexed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { indexed, failed };
  }

  private async syncDueIndexFromJobBestEffort(
    job: CronJob,
    opts?: { previousShardId?: number },
  ): Promise<void> {
    try {
      await this.syncDueIndexFromJob(job, opts);
    } catch {
      // Best-effort dual-write: source-of-truth remains cron-jobs.
      // Legacy sweeps and later mutations reconcile due-index rows.
    }
  }

  private async deleteDueIndexRowsForJobBestEffort(
    jobId: string,
    preferredShardId?: number,
  ): Promise<void> {
    try {
      await this.deleteDueIndexRowsForJob(jobId, preferredShardId);
    } catch {
      // Best-effort cleanup; stale index rows are harmless and can be corrected later.
    }
  }

  private async syncDueIndexFromJob(
    job: CronJob,
    opts?: { previousShardId?: number },
  ): Promise<void> {
    const desired = this.toDueIndexDocument(job);

    if (!desired) {
      await this.deleteDueIndexRowsForJob(job.id, resolveJobShardId(job));
      return;
    }

    if (typeof opts?.previousShardId === "number") {
      const previousShardId = normalizeSchedulerShardId(opts.previousShardId);
      if (String(previousShardId) !== desired.shardId) {
        await this.deleteDueIndexRowsForJob(job.id, previousShardId);
      }
    }

    await this.upsertDueIndexMonotonic(desired);
  }

  private async deleteDueIndexRowsForJob(
    jobId: string,
    preferredShardId?: number,
  ): Promise<void> {
    if (typeof preferredShardId === "number") {
      // Fast path: delete only from the job's known shard.
      // All callers provide the shard, so this avoids N point-reads across
      // every active shard (was O(shardCount) 404s per deletion).
      const normalized = normalizeSchedulerShardId(preferredShardId);
      await this.dueIndex
        .delete(jobId, toDueIndexShardId(normalized))
        .catch((err: unknown) => {
          if (!isNotFoundError(err)) throw err;
        });
      return;
    }

    // Fallback: no shard hint — scan all active shards.
    // This should be rare; kept as a safety net.
    const activeShards = getSchedulerShardCount();
    for (let shardId = 0; shardId < activeShards; shardId += 1) {
      await this.dueIndex
        .delete(jobId, toDueIndexShardId(shardId))
        .catch((err: unknown) => {
          if (!isNotFoundError(err)) throw err;
        });
    }
  }

  private async upsertDueIndexMonotonic(
    desired: CronDueIndexDocument,
  ): Promise<void> {
    const raw = this.dueIndex.getRawContainer() as Container;
    const partitionKey = desired.shardId;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const { resource } = await raw
          .item(desired.id, partitionKey)
          .read<CronDueIndexDocument>();

        if (!resource) {
          try {
            await raw.items.create<CronDueIndexDocument>(desired);
            return;
          } catch (err) {
            if (isConflictError(err)) {
              continue;
            }
            throw err;
          }
        }

        const etag = (resource as unknown as { _etag?: string })._etag;
        if (!etag) return;

        const existingVersion =
          typeof resource.jobVersion === "number"
            ? Math.max(1, Math.floor(resource.jobVersion))
            : 0;
        const incomingVersion =
          typeof desired.jobVersion === "number"
            ? Math.max(1, Math.floor(desired.jobVersion))
            : 0;

        if (incomingVersion < existingVersion) {
          return;
        }

        const merged: CronDueIndexDocument = {
          ...resource,
          ...desired,
          updatedAtMs: Date.now(),
        };

        await raw
          .item(desired.id, partitionKey)
          .replace<CronDueIndexDocument>(merged, {
            accessCondition: { type: "IfMatch", condition: etag },
          });
        return;
      } catch (err) {
        if (
          isNotFoundError(err) ||
          isPreconditionFailedError(err) ||
          isConflictError(err)
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  private async tryClaimHeartbeatEvent(
    candidate: HeartbeatEventCandidate,
    nowMs: number,
    staleBeforeMs: number,
    shardId: number,
  ): Promise<CronHeartbeatEventDocument | null> {
    const partitionKey = toDueIndexShardId(shardId);
    const raw = this.heartbeatEvents.getRawContainer() as Container;
    try {
      const { resource } = await raw
        .item(candidate.id, partitionKey)
        .read<CronHeartbeatEventDocument>();
      if (!resource) return null;
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (!etag) return null;

      if (resource.shardId !== partitionKey) return null;
      if (!Number.isFinite(resource.dueAtMs) || resource.dueAtMs > nowMs)
        return null;
      if (
        typeof resource.deadLetteredAtMs === "number" &&
        Number.isFinite(resource.deadLetteredAtMs)
      ) {
        return null;
      }
      if (
        resource.runningToken &&
        typeof resource.runningAtMs === "number" &&
        resource.runningAtMs > staleBeforeMs
      ) {
        return null;
      }

      const updated: CronHeartbeatEventDocument = {
        ...resource,
        runningToken: randomUUID(),
        runningAtMs: nowMs,
        updatedAtMs: nowMs,
        attempts: (resource.attempts ?? 0) + 1,
      };

      const { resource: replaced } = await raw
        .item(candidate.id, partitionKey)
        .replace<CronHeartbeatEventDocument>(updated, {
          accessCondition: { type: "IfMatch", condition: etag },
        });

      return replaced ?? null;
    } catch (err) {
      if (isNotFoundError(err) || isPreconditionFailedError(err)) return null;
      return null;
    }
  }

  private async tryClaimJob(
    candidate: Pick<CronJob, "id" | "userId">,
    nowMs: number,
    staleBeforeMs: number,
    shardId: number,
  ): Promise<CronJob | null> {
    const raw = this.jobs.getRawContainer() as Container;
    try {
      const { resource } = await raw
        .item(candidate.id, candidate.userId)
        .read<CronJob>();
      if (!resource) {
        await this.deleteDueIndexRowsForJobBestEffort(candidate.id, shardId);
        return null;
      }
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (!etag) return null;

      if (!resource.enabled) {
        await this.syncDueIndexFromJobBestEffort(resource, {
          previousShardId: shardId,
        });
        return null;
      }

      // Auto-disable expired recurring jobs at claim time
      if (isJobExpired(resource, nowMs)) {
        try {
          const disabled: CronJob = {
            ...resource,
            version: nextJobVersion(resource),
            enabled: false,
            state: {
              ...resource.state,
              nextRunAtMs: undefined,
              lastStatus: "expired",
              runningAtMs: undefined,
              runningToken: undefined,
              runningStartedAtMs: undefined,
            },
          };
          await raw
            .item(candidate.id, candidate.userId)
            .replace<CronJob>(disabled, {
              accessCondition: { type: "IfMatch", condition: etag },
            });
          await this.syncDueIndexFromJobBestEffort(disabled, {
            previousShardId: shardId,
          });
        } catch {
          // Best-effort auto-disable; next tick will retry.
        }
        return null;
      }

      const resourceShardId = resolveJobShardId(resource);
      if (resourceShardId !== shardId) {
        await this.syncDueIndexFromJobBestEffort(resource, {
          previousShardId: shardId,
        });
        return null;
      }
      if (
        typeof resource.state.nextRunAtMs !== "number" ||
        resource.state.nextRunAtMs > nowMs
      ) {
        await this.syncDueIndexFromJobBestEffort(resource, {
          previousShardId: shardId,
        });
        return null;
      }
      if (hasActiveRunningClaim(resource, nowMs)) {
        await this.syncDueIndexFromJobBestEffort(resource, {
          previousShardId: shardId,
        });
        return null;
      }
      if (
        resource.state.runningToken &&
        typeof resource.state.runningAtMs === "number" &&
        resource.state.runningAtMs > staleBeforeMs
      ) {
        await this.syncDueIndexFromJobBestEffort(resource, {
          previousShardId: shardId,
        });
        return null;
      }

      const updated: CronJob = {
        ...resource,
        version: nextJobVersion(resource),
        shardId: resourceShardId,
        state: {
          ...resource.state,
          runningAtMs: nowMs,
          runningToken: randomUUID(),
          runningStartedAtMs: undefined,
        },
      };

      const { resource: replaced } = await raw
        .item(candidate.id, candidate.userId)
        .replace<CronJob>(updated, {
          accessCondition: { type: "IfMatch", condition: etag },
        });

      if (replaced) {
        await this.syncDueIndexFromJobBestEffort(replaced, {
          previousShardId: shardId,
        });
      }
      return replaced ?? null;
    } catch (err) {
      if (isNotFoundError(err)) {
        await this.deleteDueIndexRowsForJobBestEffort(candidate.id, shardId);
        return null;
      }
      if (isPreconditionFailedError(err)) return null;
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let _store: CronStore | null = null;

/**
 * Get the global CronStore singleton (lazy-initialized from database config).
 */
export function getCronStore(): CronStore {
  if (!_store) {
    _store = new CronStore(getSharedDatabase());
  }
  return _store;
}

/**
 * Set a custom CronStore instance (for testing or shared DB).
 */
export function setCronStore(store: CronStore): void {
  _store = store;
}
