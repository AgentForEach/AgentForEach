/**
 * AgentForEach Sessions — chat-run status
 *
 * One record per chat turn a client starts (POST /api/chat, a WebSocket
 * "chat" message), so a client that missed the live events (a dropped
 * socket, an app in the background) can ask how its turn went:
 * GET /api/chat/runs/{runId}.
 *
 *   accepted -> running -> completed | failed | aborted | awaiting_input
 *                       -> interrupted (the host re-ran a turn cut off mid-way)
 *
 * The record also makes the idempotency key safe to reuse only for the same
 * request: it keeps a fingerprint of the message, session and attachments
 * (never the text itself), and a retry whose fingerprint differs is refused
 * (409) instead of joining a run that answers something else.
 *
 * Container: "chat-runs", partitioned by userId (id = runId), so a user can
 * only ever read their own runs; TTL 7 days by default
 * (`session.runStatusTtlSeconds`).
 */

import { createHash } from "node:crypto";
import { isConflict, mutate, type Collection, type CollectionSpec, type StorageAdapter } from "@agentforeach/storage";
import type { DurableStatus } from "@agentforeach/platform";
import { getSharedStorage } from "../database/storage.js";
import { DEFAULT_RUN_STATUS_TTL_SECONDS, loadSessionConfig } from "./config.js";

// ============================================================================
// Record
// ============================================================================

export type ChatRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted"
  /** The turn paused for a form; the answer resumes it (HITL). */
  | "awaiting_input";

/** A run as stored (less the storage fields). */
export interface ChatRunRecord {
  /** = runId. */
  id: string;
  /** Partition key: a user only ever reads their own runs. */
  userId: string;
  status: ChatRunStatus;
  sessionId?: string;
  /** The durable job running the turn; absent for a turn run in the request. */
  instanceId?: string;
  /** chatRunFingerprint of the request: what the idempotency key was used for. */
  fingerprint: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Failure code (`rate_limited`, `queued_too_long`, ...). */
  error?: string;
  retryable?: boolean;
}

type ChatRunDocument = ChatRunRecord & {
  /** TTL in seconds, from the last write. */
  ttl: number;
  [key: string]: unknown;
};

/** What GET /api/chat/runs/{runId} returns. */
export interface ChatRunView {
  runId: string;
  status: ChatRunStatus;
  sessionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  retryable?: boolean;
}

/** How a run ended, as `finish` records it. */
export interface ChatRunOutcome {
  status: Exclude<ChatRunStatus, "accepted" | "running">;
  error?: string;
  retryable?: boolean;
  /** The session the turn ran in, when the request didn't name one. */
  sessionId?: string;
}

export const CHAT_RUN_COLLECTION: CollectionSpec = {
  name: "chat-runs",
  partitionKey: "userId",
  defaultTtl: DEFAULT_RUN_STATUS_TTL_SECONDS,
};

/** A run that is still meant to be in progress. */
export function isRunInProgress(status: ChatRunStatus): boolean {
  return status === "accepted" || status === "running";
}

/** The idempotency key already belongs to a different request. */
export class ChatRunConflictError extends Error {
  constructor() {
    super("This idempotency key was already used for a different message");
    this.name = "ChatRunConflictError";
  }
}

/**
 * A hash of what makes two requests the same turn: the message, the session
 * and each attachment's type, name and size (not its bytes).
 */
export function chatRunFingerprint(request: {
  message: string;
  sessionId?: string;
  attachments?: Array<{ mimeType: string; base64: string; fileName?: string }>;
}): string {
  const attachments = (request.attachments ?? []).map((a) => [a.mimeType, a.fileName ?? null, a.base64.length]);
  return createHash("sha256")
    .update(JSON.stringify([request.message, request.sessionId ?? null, attachments]))
    .digest("hex");
}

// ============================================================================
// Store
// ============================================================================

export class ChatRunStore {
  private container?: Collection<ChatRunDocument>;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly ttlSeconds: number = loadSessionConfig().runStatusTtlSeconds,
  ) {}

  /** Ensure the chat-runs collection exists. Idempotent. */
  async initialize(): Promise<void> {
    if (this.container) return;
    this.container = await this.storage.collection<ChatRunDocument>(CHAT_RUN_COLLECTION);
  }

  private get ttl(): number {
    return this.ttlSeconds > 0 ? this.ttlSeconds : -1;
  }

  /**
   * Record a turn as accepted. `duplicate`: a record with this run id (the
   * same idempotency key) and the same fingerprint exists, and is kept as
   * it is. Throws ChatRunConflictError when the fingerprint differs.
   */
  async prepare(run: {
    runId: string;
    userId: string;
    fingerprint: string;
    sessionId?: string;
    instanceId?: string;
    acceptedAtMs?: number;
  }): Promise<{ duplicate: boolean }> {
    await this.initialize();
    const doc: ChatRunDocument = {
      id: run.runId,
      userId: run.userId,
      status: "accepted",
      fingerprint: run.fingerprint,
      createdAt: new Date(run.acceptedAtMs ?? Date.now()).toISOString(),
      ttl: this.ttl,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.instanceId ? { instanceId: run.instanceId } : {}),
    };
    // Twice: a record that expired between the create and the read is gone.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.container!.create(doc);
        return { duplicate: false };
      } catch (err) {
        if (!isConflict(err)) throw err;
      }
      const existing = await this.container!.read(run.runId, run.userId);
      if (!existing) continue;
      if (existing.fingerprint !== run.fingerprint) throw new ChatRunConflictError();
      return { duplicate: true };
    }
    return { duplicate: true };
  }

  /** The user's run, or null (another user's run is never found). */
  async get(userId: string, runId: string): Promise<ChatRunRecord | null> {
    await this.initialize();
    const doc = await this.container!.read(runId, userId);
    if (!doc) return null;
    const { ttl: _ttl, _etag, ...record } = doc;
    return record;
  }

  /**
   * The turn started. A retry of a finished run (same idempotency key)
   * runs again, so this restarts the record whatever its status.
   */
  async begin(userId: string, runId: string): Promise<void> {
    await this.update(userId, runId, ({ finishedAt: _f, error: _e, retryable: _r, ...run }) => ({
      ...run,
      status: "running",
      startedAt: new Date().toISOString(),
    }));
  }

  /** The turn ended. */
  async finish(userId: string, runId: string, outcome: ChatRunOutcome): Promise<void> {
    await this.update(userId, runId, ({ error: _e, retryable: _r, ...run }) => ({
      ...run,
      status: outcome.status,
      finishedAt: new Date().toISOString(),
      ...(run.sessionId || !outcome.sessionId ? {} : { sessionId: outcome.sessionId }),
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
    }));
  }

  /** No record (a turn accepted before this store existed) is not an error. */
  private async update(
    userId: string,
    runId: string,
    next: (run: ChatRunDocument) => ChatRunRecord,
  ): Promise<void> {
    await this.initialize();
    const result = await mutate(this.container!, runId, userId, ({ _etag, ...run }) => ({
      ...next(run),
      ttl: this.ttl,
    }));
    if (result.status === "contention") throw new Error(`chat run ${runId}: write contention`);
  }
}

let shared: ChatRunStore | undefined;

/** The process-wide store (shared storage). */
export function getChatRunStore(): ChatRunStore {
  return (shared ??= new ChatRunStore(getSharedStorage()));
}

// ============================================================================
// Reading a run: the record, checked against the durable job
// ============================================================================

/**
 * How long a run may sit in accepted/running before its durable instance is
 * believed over it: the job is started right after the record is written,
 * and a host may report its status a little late.
 */
export const RECONCILE_GRACE_MS = 60_000;

/**
 * The record as it should be reported. A turn's last status write can be
 * lost (the instance stopped mid-turn, a failed write), leaving it accepted
 * or running for good; the durable instance says otherwise:
 *
 *   - failed: the job threw (failed, retryable);
 *   - terminated: stopped by an operator (aborted);
 *   - completed, or gone (never started, or its history purged): it ended
 *     without saying how (interrupted, retryable).
 *
 * `durableStatus` undefined: not known (no durable runtime, or the lookup
 * failed), so the record stands. A run with no instance ran in an HTTP
 * request, which can't outlive `inRequestLimitMs`.
 */
export function reconcileChatRun(
  run: ChatRunRecord,
  opts: { durableStatus?: DurableStatus | null; inRequestLimitMs: number; nowMs?: number },
): ChatRunRecord {
  if (!isRunInProgress(run.status)) return run;
  const age = (opts.nowMs ?? Date.now()) - Date.parse(run.startedAt ?? run.createdAt);
  if (!(age > RECONCILE_GRACE_MS)) return run;
  const ended = (status: ChatRunStatus, error?: string): ChatRunRecord => ({
    ...run,
    status,
    ...(error ? { error } : {}),
    retryable: true,
  });
  if (!run.instanceId) {
    return age > opts.inRequestLimitMs + RECONCILE_GRACE_MS ? ended("interrupted", "interrupted") : run;
  }
  switch (opts.durableStatus) {
    case undefined:
    case "pending":
    case "running":
    case "suspended":
      return run;
    case "failed":
      return ended("failed", "execution_failed");
    case "terminated":
      return { ...run, status: "aborted" };
    default:
      return ended("interrupted", "interrupted");
  }
}

/** The fields a client sees. */
export function chatRunView(run: ChatRunRecord): ChatRunView {
  return {
    runId: run.id,
    status: run.status,
    sessionId: run.sessionId,
    createdAt: run.createdAt,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.retryable !== undefined ? { retryable: run.retryable } : {}),
  };
}
