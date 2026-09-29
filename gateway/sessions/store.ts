/**
 * AgentForEach Sessions Module — Session Store
 *
 * Cosmos DB-backed conversation session management.
 *
 * Two containers:
 *   "sessions"          — session metadata + compaction state (partition key: /userId)
 *   "session-messages-v2" — individual message documents (partition key: /pk =
 *                           `{userId}:{sessionId}:{instanceId}`)
 *
 * The SessionStore owns both containers. Messages are stored individually
 * in the messages container (delegated to MessageStore), while the session
 * document holds metadata, conversation state, and compaction summaries.
 *
 * When message count exceeds a threshold, older messages are summarized
 * by the LLM (compaction) and deleted. The summary is stored on the
 * session document.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { PartitionKeyKind, type Container } from "@azure/cosmos";
import type {
  DatabaseProvider,
  ContainerHandle,
} from "../database/index.js";
import type {
  Session,
  SessionMessage,
  SessionSummary,
  MessageDocument,
} from "./types.js";
import { loadSessionConfig, type SessionConfig } from "./config.js";
import { MessageStore } from "./messages-store.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// Message partition key
// ============================================================================

/** Sessions created before instanceId existed share this instance. */
const LEGACY_INSTANCE_ID = "legacy";

/**
 * Partition key of a session's messages: owner, session and instance. Only
 * build it from a session loaded for its owner; that is what scopes messages
 * to their user.
 */
export function messagePartitionKey(session: Pick<Session, "userId" | "sessionId" | "instanceId">): string {
  return `${session.userId}:${session.sessionId}:${instanceIdOf(session)}`;
}

function instanceIdOf(session: Pick<Session, "instanceId">): string {
  return session.instanceId ?? LEGACY_INSTANCE_ID;
}

/**
 * Thrown when a write was meant for a session instance that has since been
 * replaced (the user ran /new, or it expired and was recreated), so it
 * doesn't leak into the new conversation.
 */
/** The caller's run lease expired and another execution may hold the session. */
export class RunLeaseLostError extends Error {
  override name = "RunLeaseLostError";
}

export class SessionReplacedError extends Error {
  override name = "SessionReplacedError";
}

// ============================================================================
// Session Store
// ============================================================================

export class SessionStore {
  private db: DatabaseProvider;
  private container!: ContainerHandle<Session>;
  private messageStore: MessageStore;
  private initialized = false;

  /** Resolved session config. */
  private config: SessionConfig;

  constructor(
    db: DatabaseProvider,
    overrides?: {
      maxHistoryMessages?: number;
      ttlSeconds?: number;
      compactionThreshold?: number;
      compactionRetainCount?: number;
    },
  ) {
    this.db = db;
    const base = loadSessionConfig();

    // Allow explicit overrides (e.g. from AgentClientConfig.session for
    // backward compatibility, or from tests).
    this.config = {
      ...base,
      maxHistoryMessages:
        overrides?.maxHistoryMessages ?? base.maxHistoryMessages,
      ttlSeconds: overrides?.ttlSeconds ?? base.ttlSeconds,
      compactionThreshold:
        overrides?.compactionThreshold ?? base.compactionThreshold,
      compactionRetainCount:
        overrides?.compactionRetainCount ?? base.compactionRetainCount,
    };

    this.messageStore = new MessageStore(db, this.config);
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize both containers in parallel
    const [sessionContainer] = await Promise.all([
      this.db.getOrCreateContainer<Session>({
        id: this.config.containerId,
        partitionKey: {
          paths: ["/userId"],
          kind: PartitionKeyKind.Hash,
          version: 2,
        },
        defaultTtl: this.config.ttlSeconds,
        indexingPolicy: {
          automatic: true,
          indexingMode: "consistent",
          includedPaths: [{ path: "/*" }],
          excludedPaths: [
            { path: "/compactionSummary/?" }, // Don't index large summary text
            { path: '/"_etag"/?' },
          ],
        },
      }),
      this.messageStore.initialize(),
    ]);

    this.container = sessionContainer;
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /** Get the resolved config. */
  getConfig(): SessionConfig {
    return this.config;
  }

  /** Get the underlying MessageStore (for compaction). */
  getMessageStore(): MessageStore {
    return this.messageStore;
  }

  // --------------------------------------------------------------------------
  // ID Helpers
  // --------------------------------------------------------------------------

  private buildDocId(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /**
   * Get or create a session.
   *
   * If sessionId is provided and exists, returns it.
   * If sessionId is provided but doesn't exist, creates it.
   * If sessionId is omitted, generates a new one.
   */
  async getOrCreate(
    userId: string,
    agentId?: string,
    sessionId?: string,
  ): Promise<Session> {
    this.ensureInitialized();

    const effectiveAgentId = agentId ?? this.config.defaultAgentId;
    const effectiveSessionId = sessionId ?? this.generateSessionId();
    const docId = this.buildDocId(userId, effectiveSessionId);

    // Try to load existing
    const existing = await this.container.read(docId, userId);
    if (existing) return existing;

    // Create new session
    const now = new Date().toISOString();
    const session: Session = {
      id: docId,
      userId,
      agentId: effectiveAgentId,
      sessionId: effectiveSessionId,
      instanceId: randomUUID(),
      messageSeq: 0,
      createdAt: now,
      updatedAt: now,
      ttl: this.config.ttlSeconds,
    };

    try {
      return await this.container.create(session);
    } catch (err) {
      // Concurrent create on the same (userId, sessionId): return the winner.
      if (!isConflictError(err)) {
        throw err;
      }
      const existingAfterConflict = await this.container.read(docId, userId);
      if (existingAfterConflict) {
        return existingAfterConflict;
      }
      throw err;
    }
  }

  /**
   * Get a session by ID.
   */
  async get(userId: string, sessionId: string): Promise<Session | null> {
    this.ensureInitialized();
    const docId = this.buildDocId(userId, sessionId);
    return this.container.read(docId, userId);
  }

  /**
   * Append messages to a session.
   *
   * Writes messages to the messages container and updates the session
   * metadata (messageSeq, updatedAt, lastMessagePreview, conversationState).
   *
   * Uses optimistic concurrency (etag) to prevent lost updates under
   * concurrent requests.
   */
  async appendMessages(
    userId: string,
    sessionId: string,
    newMessages: SessionMessage[],
    conversationState?: Session["conversationState"] | null,
    metadata?: Record<string, string>,
    /** Instance the caller loaded; the write is refused if it was replaced since. */
    expectedInstanceId?: string,
    /**
     * The caller's run lease; the write is refused if another execution
     * holds the session now (this one lost its lease), so a run that
     * outlived its lease can't add a second answer.
     */
    expectedLeaseId?: string,
  ): Promise<Session> {
    this.ensureInitialized();

    const docId = this.buildDocId(userId, sessionId);
    const raw = this.container.getRawContainer() as Container;

    // Optimistic concurrency loop: prevents lost updates under concurrent requests.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { resource } = await raw.item(docId, userId).read<Session>();
      if (!resource) {
        throw new Error(`Session not found: ${redactId(sessionId)}`);
      }
      const etag = (resource as unknown as { _etag?: string })._etag;
      if (expectedInstanceId !== undefined && resource.instanceId !== expectedInstanceId) {
        throw new SessionReplacedError(`Session was replaced: ${redactId(sessionId)}`);
      }
      if (expectedLeaseId !== undefined && resource.activeRun?.leaseId !== expectedLeaseId) {
        throw new RunLeaseLostError(`Run lease lost: ${redactId(sessionId)}`);
      }

      const startSeq = resource.messageSeq;
      const pk = messagePartitionKey(resource);
      const instance = instanceIdOf(resource);

      // Build MessageDocuments with seq numbers
      const messageDocs: MessageDocument[] = newMessages.map((msg, i) => ({
        id: `${instance}:${String(startSeq + i).padStart(6, "0")}`,
        pk,
        sessionId,
        userId,
        seq: startSeq + i,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        model: msg.model,
        providerId: msg.providerId,
        usage: msg.usage,
        runId: msg.runId,
        idempotencyKey: msg.idempotencyKey,
        channelName: msg.channelName,
        // -1: never expire (messageTtlSeconds 0)
        ttl: this.config.messageTtlSeconds > 0 ? this.config.messageTtlSeconds : -1,
      }));

      // Update session metadata (no messages array — just counters and preview)
      const updated: Session = {
        ...resource,
        messageSeq: startSeq + newMessages.length,
        updatedAt: new Date().toISOString(),
        ttl: this.config.ttlSeconds,
      };

      // Denormalize last message preview for efficient listing
      if (newMessages.length > 0) {
        updated.lastMessagePreview = truncatePreview(
          newMessages[newMessages.length - 1].content,
        );
      }

      // Update conversation state if provided.
      // Pass null to explicitly clear (e.g., HITL breaks response chain).
      if (conversationState === null) {
        updated.conversationState = undefined;
      } else if (conversationState) {
        updated.conversationState = {
          ...resource.conversationState,
          ...conversationState,
        };
      }

      // Merge session metadata if provided (channel state, etc.)
      if (metadata && Object.keys(metadata).length > 0) {
        updated.metadata = { ...resource.metadata, ...metadata };
      }

      try {
        // Write session update first (with etag check for concurrency)
        const { resource: replaced } = await raw
          .item(docId, userId)
          .replace<Session>(
            updated,
            etag
              ? { accessCondition: { type: "IfMatch", condition: etag } }
              : undefined,
          );

        // Then write messages to the messages container
        await this.messageStore.append(pk, messageDocs);

        return replaced as Session;
      } catch (err) {
        if (isPreconditionFailedError(err)) {
          continue;
        }
        if (isNotFoundError(err)) {
          throw new Error(`Session not found: ${redactId(sessionId)}`);
        }
        throw err;
      }
    }

    throw new Error(`Session update conflict: ${redactId(sessionId)}`);
  }

  /**
   * Claim the session for one execution. Returns false while any other
   * execution holds an unexpired lease: two concurrent turns would fork the
   * conversation (both continue from the same provider response, last write
   * wins), and a retried request (same idempotency key, so same runId) or a
   * redelivered background activity would run twice. `leaseId` is unique per
   * execution for that reason; `runId` is recorded for diagnosis. The lease
   * expires on its own if the holder dies.
   */
  async acquireRunLease(
    userId: string,
    sessionId: string,
    leaseId: string,
    expiresAtMs: number,
    nowMs = Date.now(),
    runId?: string,
  ): Promise<boolean> {
    return this.updateLease(userId, sessionId, (current) => {
      if (current && current.expiresAtMs > nowMs) return false;
      return { leaseId, runId: runId ?? leaseId, expiresAtMs };
    });
  }

  /**
   * Extend the lease while its execution is alive. Leases are short (a
   * minute) and renewed, so a holder that dies — an instance killed on
   * scale-in — frees the session quickly for the redelivered turn.
   * Returns false if the lease was lost (expired and taken).
   */
  async renewRunLease(
    userId: string,
    sessionId: string,
    leaseId: string,
    expiresAtMs: number,
  ): Promise<boolean> {
    return this.updateLease(userId, sessionId, (current) =>
      current?.leaseId === leaseId ? { ...current, expiresAtMs } : false,
    );
  }

  /** The run holding the session, if any (for telling a duplicate from a new turn). */
  async peekActiveRun(userId: string, sessionId: string): Promise<Session["activeRun"]> {
    this.ensureInitialized();
    const session = await this.container.read(this.buildDocId(userId, sessionId), userId);
    return session?.activeRun;
  }

  /** Give the session back, if `leaseId` still holds it. */
  async releaseRunLease(userId: string, sessionId: string, leaseId: string): Promise<void> {
    await this.updateLease(userId, sessionId, (current) =>
      current?.leaseId === leaseId ? undefined : false,
    );
  }

  /**
   * Etag-guarded read-modify-write of `activeRun`. `decide` returns the new
   * lease, `undefined` to clear it, or `false` to leave the doc untouched
   * (the method then returns false).
   */
  private async updateLease(
    userId: string,
    sessionId: string,
    decide: (current: Session["activeRun"]) => Session["activeRun"] | false,
  ): Promise<boolean> {
    this.ensureInitialized();
    const docId = this.buildDocId(userId, sessionId);
    const raw = this.container.getRawContainer() as Container;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { resource } = await raw.item(docId, userId).read<Session>();
      if (!resource) return false;
      const next = decide(resource.activeRun);
      if (next === false) return false;
      const etag = (resource as unknown as { _etag?: string })._etag;
      const updated: Session = { ...resource, activeRun: next };
      if (!next) delete updated.activeRun;
      try {
        await raw
          .item(docId, userId)
          .replace<Session>(updated, etag ? { accessCondition: { type: "IfMatch", condition: etag } } : undefined);
        return true;
      } catch (err) {
        if (isPreconditionFailedError(err)) continue;
        if (isNotFoundError(err)) return false;
        throw err;
      }
    }
    return false;
  }

  /**
   * Update the session document with compaction results.
   *
   * Called by `runCompaction()` after the LLM generates a summary.
   */
  async updateCompaction(
    userId: string,
    sessionId: string,
    summary: string,
    lastCompactedSeq: number,
    /** Instance that was compacted; skipped if the session was replaced since. */
    expectedInstanceId?: string,
  ): Promise<void> {
    this.ensureInitialized();
    const docId = this.buildDocId(userId, sessionId);
    if (expectedInstanceId !== undefined) {
      // Compaction runs for seconds; /new may have replaced the session.
      const current = await this.container.read(docId, userId);
      if (!current || current.instanceId !== expectedInstanceId) return;
    }
    await this.container.patch(docId, userId, [
      { op: "set", path: "/compactionSummary", value: summary },
      { op: "set", path: "/lastCompactedSeq", value: lastCompactedSeq },
      {
        op: "set",
        path: "/lastCompactedAt",
        value: new Date().toISOString(),
      },
    ]);
  }

  /**
   * Delete a session and its messages.
   *
   * A session recreated with the same id gets a new instanceId, so it never
   * sees these messages; the purge is garbage collection (message docs also
   * expire by TTL).
   */
  async delete(userId: string, sessionId: string): Promise<boolean> {
    this.ensureInitialized();
    const session = await this.get(userId, sessionId);
    if (!session) return false;
    const deleted = await this.container.delete(session.id, userId);
    if (deleted) {
      // Fire-and-forget: non-fatal, and the partition is unreachable anyway.
      this.messageStore.deleteAll(messagePartitionKey(session)).catch(() => {});
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // Message Access (delegates to MessageStore)
  //
  // Every read goes through the owner's session: no session for this user →
  // no messages.
  // --------------------------------------------------------------------------

  /**
   * Get recent messages for one of a user's sessions.
   */
  async getMessages(
    userId: string,
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<MessageDocument[]> {
    this.ensureInitialized();
    const session = await this.get(userId, sessionId);
    if (!session) return [];
    return this.messageStore.getRecent(messagePartitionKey(session), opts?.limit);
  }

  /**
   * Get all messages for one of a user's sessions.
   */
  async getAllMessages(userId: string, sessionId: string): Promise<MessageDocument[]> {
    this.ensureInitialized();
    const session = await this.get(userId, sessionId);
    if (!session) return [];
    return this.messageStore.getAll(messagePartitionKey(session));
  }

  /**
   * Find an assistant message by idempotency key (for duplicate suppression).
   */
  /** The assistant reply a run already stored, if any. */
  async findByRunId(session: Session, runId: string): Promise<MessageDocument | null> {
    this.ensureInitialized();
    return this.messageStore.findByRunId(messagePartitionKey(session), runId);
  }

  async findByIdempotencyKey(
    session: Session,
    key: string,
  ): Promise<MessageDocument | null> {
    this.ensureInitialized();
    return this.messageStore.findByIdempotencyKey(messagePartitionKey(session), key);
  }

  // --------------------------------------------------------------------------
  // History for LLM Provider
  // --------------------------------------------------------------------------

  /**
   * Build the conversation history for the LLM provider.
   *
   * Loads recent messages from the messages container and returns
   * the compaction summary (if any) as separate context.
   */
  async getProviderHistory(session: Session): Promise<{
    history: Array<{ role: "user" | "assistant"; content: string }>;
    compactionSummary?: string;
  }> {
    const messages = await this.messageStore.getRecent(messagePartitionKey(session));

    const history = messages
      .filter((m) => m.content)
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    return {
      history,
      compactionSummary: session.compactionSummary || undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Listing
  // --------------------------------------------------------------------------

  /**
   * List session summaries for a user.
   *
   * Returns lightweight summaries (no messages) sorted by most recently
   * updated. Paginated via `limit` (default 50).
   */
  async list(
    userId: string,
    agentId?: string,
    opts?: { limit?: number },
  ): Promise<SessionSummary[]> {
    this.ensureInitialized();

    const maxResults = Math.min(Math.max(opts?.limit ?? 50, 1), 200);

    const columns =
      "c.sessionId, c.agentId, c.messageSeq AS messageCount, " +
      "c.lastMessagePreview, c.createdAt, c.updatedAt";

    const sql = agentId
      ? `SELECT ${columns} FROM c ` +
        "WHERE c.userId = @userId AND c.agentId = @agentId " +
        "ORDER BY c.updatedAt DESC"
      : `SELECT ${columns} FROM c ` +
        "WHERE c.userId = @userId " +
        "ORDER BY c.updatedAt DESC";

    const params = agentId
      ? [
          { name: "@userId", value: userId },
          { name: "@agentId", value: agentId },
        ]
      : [{ name: "@userId", value: userId }];

    const rows = await this.container.queryWithParams<{
      sessionId: string;
      agentId: string;
      messageCount: number;
      lastMessagePreview?: string;
      createdAt: string;
      updatedAt: string;
    }>(sql, params, { partitionKey: userId, maxResults });

    return rows.map((r) => ({
      sessionId: r.sessionId,
      agentId: r.agentId,
      messageCount: r.messageCount,
      lastMessage: r.lastMessagePreview ?? "",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private generateSessionId(): string {
    // Short, human-friendly session ID: timestamp + random suffix
    const ts = Date.now().toString(36);
    const rand = randomBytes(4).toString("hex");
    return `${ts}-${rand}`;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "SessionStore: not initialized. Call initialize() first.",
      );
    }
  }
}

// ============================================================================
// String Helpers
// ============================================================================

const MAX_PREVIEW_LENGTH = loadSessionConfig().maxPreviewLength;

function truncatePreview(text: string): string {
  if (!text) return "";
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= MAX_PREVIEW_LENGTH) return oneLine;
  return oneLine.slice(0, MAX_PREVIEW_LENGTH - 1) + "\u2026";
}

// ============================================================================
// Error Helpers
// ============================================================================

function isConflictError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === 409 || e.code === "Conflict" || e.statusCode === 409;
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
