/**
 * AgentForEach HITL Module — Cosmos DB Store
 *
 * Persists HitlRunState documents so the runner can be resumed
 * in a completely new Azure Function invocation after the user
 * responds to an input request.
 *
 * Uses the same DatabaseProvider abstraction as other AgentForEach stores.
 * Container: "hitl-requests" partitioned by /userId.
 *
 * Lifecycle:
 *   1. Runner hits HITL gate → `create()` persists state
 *   2. Durable orchestrator waits for event → function sleeps (zero cost)
 *   3. User responds → ws-message handler raises Durable event
 *   4. Orchestrator wakes → activity reads state with `get()`
 *   5. Activity resumes runner → `updateStatus("responded")` or "cancelled"
 *   6. Cleanup: TTL (24h) on completed/timed_out documents
 *
 * @see ../cron/store.ts — reference Cosmos DB store pattern
 */

import { PartitionKeyKind } from "@azure/cosmos";
import type {
  DatabaseProvider,
  ContainerHandle,
} from "../database/types.js";
import type { HitlRunState } from "./types.js";

// ============================================================================
// Cosmos DB Document Shape
// ============================================================================

interface HitlDocument {
  /** Cosmos DB document ID = requestId. */
  id: string;
  /** Partition key = userId. */
  userId: string;
  /** The full serializable run state. */
  state: HitlRunState;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** TTL in seconds — Cosmos auto-deletes after this. */
  ttl: number;
  /** Index signature required by BaseDocument. */
  [key: string]: unknown;
}

/** Container name. */
const HITL_CONTAINER = "hitl-requests";

/** TTL for pending requests: 1 hour — if not resolved, something went wrong. */
const PENDING_TTL_SECONDS = 3600;

/** TTL for resolved requests: 24 hours — kept for debugging / audit. */
const RESOLVED_TTL_SECONDS = 86400;

// ============================================================================
// HITL Store
// ============================================================================

export class HitlStore {
  private db: DatabaseProvider;
  private container!: ContainerHandle<HitlDocument>;
  private initialized = false;

  constructor(db: DatabaseProvider) {
    this.db = db;
  }

  /**
   * Ensure the hitl-requests container exists.
   * Safe to call multiple times — idempotent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.container = await this.db.getOrCreateContainer<HitlDocument>({
      id: HITL_CONTAINER,
      partitionKey: {
        paths: ["/userId"],
        kind: PartitionKeyKind.Hash,
        version: 2,
      },
      defaultTtl: PENDING_TTL_SECONDS,
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [{ path: '/"_etag"/?' }],
      },
    });

    this.initialized = true;
  }

  /**
   * Persist a new HITL run state when the runner pauses.
   */
  async create(state: HitlRunState): Promise<void> {
    const now = new Date().toISOString();
    const doc: HitlDocument = {
      id: state.requestId,
      userId: state.originalRequest.userId,
      state,
      createdAt: now,
      updatedAt: now,
      ttl: PENDING_TTL_SECONDS,
    };

    await this.container.create(doc);
  }

  /**
   * Read a HITL run state by requestId and userId.
   */
  async get(
    requestId: string,
    userId: string,
  ): Promise<HitlRunState | null> {
    const doc = await this.container.read(requestId, userId);
    return doc?.state ?? null;
  }

  /**
   * Update the status of a HITL request (e.g., responded, cancelled, timed_out).
   * Extends TTL for resolved states so they're available for debugging.
   */
  async updateStatus(
    requestId: string,
    userId: string,
    status: HitlRunState["status"],
  ): Promise<void> {
    const doc = await this.container.read(requestId, userId);
    if (!doc) return;

    doc.state.status = status;
    doc.updatedAt = new Date().toISOString();
    doc.ttl = RESOLVED_TTL_SECONDS;

    await this.container.replace(requestId, userId, doc);
  }

  /**
   * Record the outputs of the other tool calls from the response that asked
   * for input; the resume must send them along with the user's answer.
   */
  async setCompletedToolResults(
    requestId: string,
    userId: string,
    results: HitlRunState["completedToolResults"],
  ): Promise<void> {
    const doc = await this.container.read(requestId, userId);
    if (!doc) return;
    doc.state.completedToolResults = results;
    doc.updatedAt = new Date().toISOString();
    await this.container.replace(requestId, userId, doc);
  }

  /**
   * List pending HITL requests for a user (for resumability after reconnect).
   */
  async listPending(userId: string): Promise<HitlRunState[]> {
    const docs = await this.container.queryWithParams<HitlDocument>(
      "SELECT * FROM c WHERE c.userId = @userId AND c.state.status = 'pending' ORDER BY c.createdAt DESC",
      [{ name: "@userId", value: userId }],
      // Single partition: no cross-partition query plan on this hot path.
      { partitionKey: userId },
    );

    return docs.map((doc) => doc.state);
  }

  /**
   * Cancel all pending HITL requests for a user.
   * Called on disconnect or session reset.
   */
  async cancelAllPending(userId: string): Promise<number> {
    const pending = await this.listPending(userId);
    let cancelled = 0;

    for (const state of pending) {
      await this.updateStatus(state.requestId, userId, "timed_out");
      cancelled++;
    }

    return cancelled;
  }
}
