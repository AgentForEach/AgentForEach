/**
 * AgentForEach Sessions Module — Message Store
 *
 * Cosmos DB-backed message storage for session conversations.
 *
 * Messages are stored as individual documents (one per message) in
 * a dedicated container, separate from the session metadata document.
 * This avoids the 2MB document size limit for long conversations and
 * enables per-message queries and pagination.
 *
 * Container: "session-messages-v2" (configurable via agentforeach.json)
 *   - Partition key: /pk = `{userId}:{sessionId}:{instanceId}`
 *   - TTL enabled with no default; each document carries its own `ttl`
 *   - Document ID: `{instanceId}:{seqPadded}`
 *
 * Every method takes the partition key. Callers build it with
 * messagePartitionKey(session) from a session loaded for its owner; that is
 * what scopes messages to their user. Queries never scan across partitions.
 */

import {
  and,
  eq,
  gt,
  gte,
  lt,
  type Collection,
  type CollectionSpec,
  type StorageAdapter,
} from "@agentforeach/storage";
import type { MessageDocument } from "./types.js";
import { loadSessionConfig, type SessionConfig } from "./config.js";

// ============================================================================
// Message Store
// ============================================================================

/**
 * The messages collection, partitioned by `pk` (user:session:instance). TTL
 * is on with no default: each message carries its own ttl. Message content
 * (large text) is not indexed, exactly as deployed (scalar `/content/?`).
 */
export function messagesCollection(config: SessionConfig): CollectionSpec {
  return {
    name: config.messagesContainerId,
    partitionKey: "pk",
    defaultTtl: -1,
    // Account erasure finds a user's messages by userId, across partitions.
    indexes: ["userId"],
    adapterOptions: {
      cosmosdb: {
        indexingPolicy: {
          automatic: true,
          indexingMode: "consistent",
          includedPaths: [{ path: "/*" }],
          excludedPaths: [{ path: "/content/?" }, { path: '/"_etag"/?' }],
        },
        // An old config pointing at "session-messages" (partitioned on
        // /sessionId) would fail every write: fail at startup instead.
        verifyPartitionKey: true,
      },
    },
  };
}

export class MessageStore {
  private storage: StorageAdapter;
  private container!: Collection<MessageDocument>;
  private initialized = false;
  private config: SessionConfig;

  constructor(storage: StorageAdapter, config?: SessionConfig) {
    this.storage = storage;
    this.config = config ?? loadSessionConfig();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.container = await this.storage.collection<MessageDocument>(messagesCollection(this.config));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/partitioned on/.test(message)) throw err;
      throw new Error(
        `Messages container "${this.config.messagesContainerId}" ${message.replace(/^.*?is (partitioned on)/, "is $1")}. ` +
          `Point sessions.messagesContainerId at a new container ` +
          `(default "session-messages-v2"); see docs/Session-management.md.`,
        { cause: err },
      );
    }
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Write
  // --------------------------------------------------------------------------

  /**
   * Append messages to the container.
   *
   * Each message must have id, pk, seq already set by the caller
   * (typically SessionStore.appendMessages).
   */
  async append(pk: string, messages: MessageDocument[]): Promise<void> {
    this.ensureInitialized();
    if (messages.length === 0) return;

    if (messages.some((m) => m.pk !== pk)) {
      throw new Error("MessageStore.append: every message must be in the given partition");
    }
    // Create all messages in parallel (all share the same partition key)
    await Promise.all(messages.map((m) => this.container.create(m)));
  }

  // --------------------------------------------------------------------------
  // Read
  // --------------------------------------------------------------------------

  /**
   * Get the most recent N messages for a session, returned in
   * chronological order (ascending seq).
   *
   * Default limit comes from config.maxHistoryMessages.
   */
  async getRecent(
    pk: string,
    limit?: number,
  ): Promise<MessageDocument[]> {
    this.ensureInitialized();
    const max = limit ?? this.config.maxHistoryMessages;

    // Query newest first, then reverse for chronological order
    const rows = await this.container.find<MessageDocument>({
      partitionKey: pk,
      where: eq("pk", pk),
      orderBy: { field: "seq", direction: "desc" },
      limit: max,
    });

    return rows.reverse();
  }

  /**
   * Get all messages for a session, ordered by seq ascending.
   */
  async getAll(pk: string): Promise<MessageDocument[]> {
    this.ensureInitialized();
    return this.container.find<MessageDocument>({
      partitionKey: pk,
      where: eq("pk", pk),
      orderBy: { field: "seq", direction: "asc" },
    });
  }

  /**
   * Get messages in a seq range [fromSeq, toSeq) for compaction.
   */
  async getRange(
    pk: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<MessageDocument[]> {
    this.ensureInitialized();
    return this.container.find<MessageDocument>({
      partitionKey: pk,
      where: and(eq("pk", pk), gte("seq", fromSeq), lt("seq", toSeq)),
      orderBy: { field: "seq", direction: "asc" },
    });
  }

  /**
   * Get the count of messages in a session.
   */
  async count(pk: string): Promise<number> {
    this.ensureInitialized();
    return this.container.count({ partitionKey: pk, where: eq("pk", pk) });
  }

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  /**
   * Delete all messages for a session.
   *
   * Called when a session is deleted (e.g., /new command). Garbage
   * collection only: a recreated session gets a new instanceId, and so a new
   * partition, and message docs also expire by TTL.
   *
   * Returns the number of messages deleted.
   */
  async deleteAll(pk: string): Promise<number> {
    this.ensureInitialized();

    const toDelete = await this.container.find<{ id: string }>({
      partitionKey: pk,
      where: eq("pk", pk),
      select: ["id"],
    });

    let deleted = 0;
    for (const doc of toDelete) {
      const ok = await this.container.delete(doc.id, pk);
      if (ok) deleted++;
    }
    return deleted;
  }

  /**
   * Delete all messages with seq < beforeSeq (compacted messages).
   *
   * Returns the number of messages deleted.
   */
  async deleteBefore(pk: string, beforeSeq: number): Promise<number> {
    this.ensureInitialized();

    const toDelete = await this.container.find<{ id: string }>({
      partitionKey: pk,
      where: and(eq("pk", pk), lt("seq", beforeSeq)),
      select: ["id"],
    });

    let deleted = 0;
    for (const doc of toDelete) {
      const ok = await this.container.delete(doc.id, pk);
      if (ok) deleted++;
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // Idempotency
  // --------------------------------------------------------------------------

  /**
   * Find a user message by idempotency key and return the following
   * assistant message (if any).
   *
   * Replaces the old `findIdempotentAssistantMessage()` in runner.ts
   * which searched the embedded session.messages array.
   */
  /** The assistant reply a run stored, if any (replaying a redelivered run). */
  async findByRunId(pk: string, runId: string): Promise<MessageDocument | null> {
    this.ensureInitialized();
    const found = await this.container.find<MessageDocument>({
      partitionKey: pk,
      where: and(eq("pk", pk), eq("runId", runId), eq("role", "assistant")),
      limit: 1,
    });
    return found[0] ?? null;
  }

  async findByIdempotencyKey(
    pk: string,
    key: string,
  ): Promise<MessageDocument | null> {
    this.ensureInitialized();

    const trimmed = key.trim();
    if (!trimmed) return null;

    // Find the most recent user message with this idempotency key
    const userMsgs = await this.container.find<MessageDocument>({
      partitionKey: pk,
      where: and(eq("pk", pk), eq("idempotencyKey", trimmed), eq("role", "user")),
      orderBy: { field: "seq", direction: "desc" },
      limit: 1,
    });

    if (userMsgs.length === 0) return null;
    const userMsg = userMsgs[0];

    // Find the next assistant message after it
    const assistantMsgs = await this.container.find<MessageDocument>({
      partitionKey: pk,
      where: and(eq("pk", pk), gt("seq", userMsg.seq), eq("role", "assistant")),
      orderBy: { field: "seq", direction: "asc" },
      limit: 1,
    });

    return assistantMsgs.length > 0 ? assistantMsgs[0] : null;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "MessageStore: not initialized. Call initialize() first.",
      );
    }
  }
}
