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

import { PartitionKeyKind } from "@azure/cosmos";
import type {
  DatabaseProvider,
  ContainerHandle,
} from "../database/index.js";
import type { MessageDocument } from "./types.js";
import { loadSessionConfig, type SessionConfig } from "./config.js";

// ============================================================================
// Message Store
// ============================================================================

export class MessageStore {
  private db: DatabaseProvider;
  private container!: ContainerHandle<MessageDocument>;
  private initialized = false;
  private config: SessionConfig;

  constructor(db: DatabaseProvider, config?: SessionConfig) {
    this.db = db;
    this.config = config ?? loadSessionConfig();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.container = await this.db.getOrCreateContainer<MessageDocument>({
      id: this.config.messagesContainerId,
      partitionKey: {
        paths: ["/pk"],
        kind: PartitionKeyKind.Hash,
        version: 2,
      },
      // TTL on, no default: each message carries its own ttl.
      defaultTtl: -1,
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [
          { path: "/content/?" }, // Don't index message content (large text)
          { path: '/"_etag"/?' },
        ],
      },
    });

    await this.assertPartitionKey();
    this.initialized = true;
  }

  /**
   * An existing container keeps the partition key it was created with. A
   * config still pointing at the old "session-messages" container
   * (partitioned on /sessionId) would fail every write, so fail at startup.
   */
  private async assertPartitionKey(): Promise<void> {
    const raw = this.container.getRawContainer() as {
      read?: () => Promise<{ resource?: { partitionKey?: { paths?: string[] } } }>;
    };
    if (typeof raw?.read !== "function") return; // in-memory providers
    const { resource } = await raw.read();
    const paths = resource?.partitionKey?.paths;
    if (paths && paths[0] !== "/pk") {
      throw new Error(
        `Messages container "${this.config.messagesContainerId}" is partitioned on ${paths[0]}, ` +
          `expected /pk. Point sessions.messagesContainerId at a new container ` +
          `(default "session-messages-v2"); see docs/Session-management.md.`,
      );
    }
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
    const rows = await this.container.queryWithParams<MessageDocument>(
      "SELECT TOP @limit * FROM c WHERE c.pk = @pk ORDER BY c.seq DESC",
      [
        { name: "@pk", value: pk },
        { name: "@limit", value: max },
      ],
      { partitionKey: pk },
    );

    return rows.reverse();
  }

  /**
   * Get all messages for a session, ordered by seq ascending.
   */
  async getAll(pk: string): Promise<MessageDocument[]> {
    this.ensureInitialized();
    return this.container.queryWithParams<MessageDocument>(
      "SELECT * FROM c WHERE c.pk = @pk ORDER BY c.seq ASC",
      [{ name: "@pk", value: pk }],
      { partitionKey: pk },
    );
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
    return this.container.queryWithParams<MessageDocument>(
      "SELECT * FROM c WHERE c.pk = @pk AND c.seq >= @from AND c.seq < @to ORDER BY c.seq ASC",
      [
        { name: "@pk", value: pk },
        { name: "@from", value: fromSeq },
        { name: "@to", value: toSeq },
      ],
      { partitionKey: pk },
    );
  }

  /**
   * Get the count of messages in a session.
   */
  async count(pk: string): Promise<number> {
    this.ensureInitialized();
    return this.container.count(
      "c.pk = @pk",
      [{ name: "@pk", value: pk }],
      { partitionKey: pk },
    );
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

    const toDelete = await this.container.queryWithParams<{ id: string }>(
      "SELECT c.id FROM c WHERE c.pk = @pk",
      [{ name: "@pk", value: pk }],
      { partitionKey: pk },
    );

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

    const toDelete = await this.container.queryWithParams<{ id: string }>(
      "SELECT c.id FROM c WHERE c.pk = @pk AND c.seq < @before",
      [
        { name: "@pk", value: pk },
        { name: "@before", value: beforeSeq },
      ],
      { partitionKey: pk },
    );

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
    const found = await this.container.queryWithParams<MessageDocument>(
      "SELECT * FROM c WHERE c.pk = @pk AND c.runId = @runId AND c.role = 'assistant'",
      [
        { name: "@pk", value: pk },
        { name: "@runId", value: runId },
      ],
      { partitionKey: pk, maxResults: 1 },
    );
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
    const userMsgs = await this.container.queryWithParams<MessageDocument>(
      "SELECT * FROM c WHERE c.pk = @pk AND c.idempotencyKey = @key AND c.role = 'user' ORDER BY c.seq DESC",
      [
        { name: "@pk", value: pk },
        { name: "@key", value: trimmed },
      ],
      { partitionKey: pk, maxResults: 1 },
    );

    if (userMsgs.length === 0) return null;
    const userMsg = userMsgs[0];

    // Find the next assistant message after it
    const assistantMsgs = await this.container.queryWithParams<MessageDocument>(
      "SELECT * FROM c WHERE c.pk = @pk AND c.seq > @seq AND c.role = 'assistant' ORDER BY c.seq ASC",
      [
        { name: "@pk", value: pk },
        { name: "@seq", value: userMsg.seq },
      ],
      { partitionKey: pk, maxResults: 1 },
    );

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
