/**
 * Cross-instance abort store.
 *
 * The in-memory active-request registry (handlers/active-request-store.ts)
 * only works when the abort request lands on the SAME function instance as
 * the running chat. Under scale-out, Azure routes the abort anywhere — the
 * handler finds no controller, tells the client "aborted" so the UI clears,
 * and the run keeps going, burning tokens the user asked it not to.
 *
 * This store makes abort a shared fact instead of an instance-local one:
 * the abort handler writes a marker document, and the instance running the
 * chat polls for it (see watchSharedAbort in the handlers) and trips its
 * local AbortController — from there the existing abortSignal plumbing
 * through the runner and provider SDKs takes over.
 *
 * Container: "abort-requests", one doc per user (id = userId), short TTL so
 * stale markers clean themselves up.
 */

import { PartitionKeyKind } from "@azure/cosmos";
import type {
  DatabaseProvider,
  ContainerHandle,
} from "../database/types.js";

interface AbortDocument {
  /** Document ID = userId (one pending abort per user at most). */
  id: string;
  /** Partition key = userId. */
  userId: string;
  /** ISO 8601 timestamp of when the abort was requested. */
  requestedAt: string;
  /** TTL in seconds — Cosmos auto-deletes stale markers. */
  ttl: number;
  /** Index signature required by BaseDocument. */
  [key: string]: unknown;
}

const ABORT_CONTAINER = "abort-requests";

/** Markers are only meaningful for the run they target; expire fast. */
const MARKER_TTL_SECONDS = 600;

export class AbortStore {
  private db: DatabaseProvider;
  private container!: ContainerHandle<AbortDocument>;
  private initialized = false;

  constructor(db: DatabaseProvider) {
    this.db = db;
  }

  /** Ensure the abort-requests container exists. Idempotent. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.container = await this.db.getOrCreateContainer<AbortDocument>({
      id: ABORT_CONTAINER,
      partitionKey: {
        paths: ["/userId"],
        kind: PartitionKeyKind.Hash,
        version: 2,
      },
      defaultTtl: MARKER_TTL_SECONDS,
    });
    this.initialized = true;
  }

  /** Record that the user asked to abort their active run. */
  async requestAbort(userId: string): Promise<void> {
    await this.container.upsert({
      id: userId,
      userId,
      requestedAt: new Date().toISOString(),
      ttl: MARKER_TTL_SECONDS,
    });
  }

  /**
   * Check for an abort marker newer than [since] and consume it.
   *
   * The [since] guard means a marker left over from a previous turn can
   * never kill the next one: only aborts requested AFTER the current run
   * started count. Returns true exactly once per marker.
   */
  async consumePendingAbort(userId: string, since: Date): Promise<boolean> {
    const doc = await this.container.read(userId, userId);
    if (!doc) return false;
    const requestedAt = Date.parse(doc.requestedAt);
    if (Number.isNaN(requestedAt) || requestedAt < since.getTime()) {
      // Stale marker from an earlier turn — clean it up and ignore it.
      await this.container.delete(userId, userId).catch(() => false);
      return false;
    }
    await this.container.delete(userId, userId).catch(() => false);
    return true;
  }
}
