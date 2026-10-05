/**
 * AgentForEach HITL Module — Cosmos DB Store
 *
 * Persists HitlRunState documents so the runner can be resumed
 * in a completely new Azure Function invocation after the user
 * responds to an input request.
 *
 * Uses the shared storage adapter, like the other AgentForEach stores.
 * Container: "hitl-requests" partitioned by /userId.
 *
 * Lifecycle:
 *   1. Runner hits HITL gate → `create()` persists state
 *   2. Durable orchestrator waits for event → function sleeps (zero cost)
 *   3. User responds → the answer is saved on the state (`transition()`),
 *      then the ws-message or chat handler raises the Durable event
 *   4. Orchestrator wakes → activity reads state (and the saved answer) with `get()`
 *   5. Activity resumes runner → `updateStatus("responded")` or "cancelled"
 *   6. Cleanup: TTL (24h) on completed/timed_out documents
 *
 * @see ../cron/store.ts — reference store pattern
 */

import { and, eq, mutate, type Collection, type CollectionSpec, type StorageAdapter } from "@agentforeach/storage";
import type { HitlRunState } from "./types.js";

// ============================================================================
// Document Shape
// ============================================================================

interface HitlDocument {
  /** Document ID = requestId. */
  id: string;
  /** Partition key = userId. */
  userId: string;
  /** The full serializable run state. */
  state: HitlRunState;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** TTL in seconds: the database deletes the document after this. */
  ttl: number;
  [key: string]: unknown;
}

/**
 * Minimum TTL for pending requests. A request waits for the user for its own
 * timeoutSeconds, so its state is kept that long plus a grace period, or an
 * answer (or the timeout) after this TTL would find nothing to resume.
 */
const PENDING_TTL_SECONDS = 3600;
const PENDING_GRACE_SECONDS = 600;

/** TTL for resolved requests: 24 hours — kept for debugging / audit. */
const RESOLVED_TTL_SECONDS = 86400;

export const HITL_COLLECTION: CollectionSpec = {
  name: "hitl-requests",
  partitionKey: "userId",
  defaultTtl: PENDING_TTL_SECONDS,
};

// ============================================================================
// HITL Store
// ============================================================================

export class HitlStore {
  private storage: StorageAdapter;
  private container!: Collection<HitlDocument>;
  private initialized = false;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }

  /**
   * Ensure the hitl-requests container exists.
   * Safe to call multiple times — idempotent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.container = await this.storage.collection<HitlDocument>(HITL_COLLECTION);

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
      // Whole seconds: TTLs are integers (a fractional handoff timeout would
      // otherwise be refused).
      ttl: Math.max(PENDING_TTL_SECONDS, Math.ceil((state.timeoutSeconds ?? 0) + PENDING_GRACE_SECONDS)),
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
   * Apply `update` to a request's state as one guarded write: `update` sees
   * the latest state (it may run more than once) and returns the next state,
   * or undefined to write nothing. An etag keeps two writers from undoing
   * each other, so answers, resumes and timeouts can't race. Returns the
   * state now stored and whether this call changed it, or null when there is
   * no such request. A request leaving `pending` keeps its document for 24
   * hours.
   */
  async transition(
    requestId: string,
    userId: string,
    update: (state: HitlRunState) => HitlRunState | undefined,
  ): Promise<{ state: HitlRunState; updated: boolean } | null> {
    const result = await mutate(this.container, requestId, userId, (doc) => {
      const state = update(doc.state);
      if (!state) return undefined;
      const resolved = state.status !== "pending";
      return { ...doc, state, updatedAt: new Date().toISOString(), ttl: resolved ? RESOLVED_TTL_SECONDS : doc.ttl };
    });
    if (result.status === "updated") return { state: result.document.state, updated: true };
    if (result.status === "skipped") return { state: result.document.state, updated: false };
    if (result.status === "notFound") return null;
    throw new Error(`HITL request ${requestId} is being changed by another writer; try again`);
  }

  /**
   * Move a pending request to `status` (responded, cancelled, timed_out),
   * with any other fields to record. Only a pending request changes, so a
   * late timeout can't undo an answer, nor a second resume repeat one.
   * Returns whether this call made the change. Extends the TTL for
   * debugging.
   */
  async updateStatus(
    requestId: string,
    userId: string,
    status: HitlRunState["status"],
    fields: Pick<HitlRunState, "resumedRunId"> = {},
  ): Promise<boolean> {
    const result = await this.transition(requestId, userId, (state) =>
      state.status === "pending" ? { ...state, ...fields, status } : undefined,
    );
    return result?.updated ?? false;
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
    // The form is already out, so the user may answer while this runs: only
    // a still-pending request is updated, and an etag keeps this write from
    // undoing theirs (which would reopen an answered request).
    // Gone, answered, or still contended after 4 attempts: nothing to do.
    await mutate(
      this.container,
      requestId,
      userId,
      (doc) =>
        doc.state.status !== "pending"
          ? undefined
          : { ...doc, state: { ...doc.state, completedToolResults: results }, updatedAt: new Date().toISOString() },
      { maxAttempts: 4 },
    );
  }

  /**
   * List pending HITL requests for a user (for resumability after reconnect).
   */
  async listPending(userId: string): Promise<HitlRunState[]> {
    const docs = await this.container.find<HitlDocument>({
      // Single partition: no cross-partition query plan on this hot path.
      partitionKey: userId,
      where: and(eq("userId", userId), eq("state.status", "pending")),
      orderBy: { field: "createdAt", direction: "desc" },
    });

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
