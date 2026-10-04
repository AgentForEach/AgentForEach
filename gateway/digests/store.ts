/**
 * AgentForEach Digests Module — Store
 *
 * Persistence layer for short-lived session digest documents.
 * Simpler than episodes — no vector index needed, just time-ordered
 * queries and keyword search on the summary field.
 *
 * Container setup:
 *   - Partition key: /userId
 *   - Per-document TTL enabled (defaultTtl: -1)
 *   - No vector index (digests are time-ordered, not semantically searched)
 */

import { and, contains, eq, gte, type Collection, type CollectionSpec, type StorageAdapter } from "@agentforeach/storage";
import type { DigestDocument } from "./types.js";

/** The session-digests collection: per-document TTL (defaultTtl -1). */
export function digestsCollection(containerId = "session-digests"): CollectionSpec {
  return { name: containerId, partitionKey: "userId", defaultTtl: -1 };
}

// ============================================================================
// Digest Store
// ============================================================================

export class DigestStore {
  private storage: StorageAdapter;
  private containerId: string;
  private container!: Collection<DigestDocument>;
  private initialized = false;

  constructor(storage: StorageAdapter, containerId = "session-digests") {
    this.storage = storage;
    this.containerId = containerId;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.storage.initialize();
    this.container = await this.storage.collection<DigestDocument>(digestsCollection(this.containerId));
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /**
   * Save (upsert) a digest document.
   * Uses upsert so repeated compactions on the same session update the digest.
   */
  async save(digest: DigestDocument): Promise<DigestDocument> {
    await this.ensureInitialized();
    return this.container.upsert(digest);
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  /**
   * Get the most recent digests for a user, ordered by creation time DESC.
   * This is the primary method used for prompt injection (recency awareness).
   */
  async getRecent(userId: string, limit = 5): Promise<DigestDocument[]> {
    await this.ensureInitialized();

    return this.container.find<DigestDocument>({
      partitionKey: userId,
      where: eq("userId", userId),
      orderBy: { field: "createdAt", direction: "desc" },
      limit,
    });
  }

  /**
   * Search digests by keyword match on the summary field.
   * Used by the session_search tool.
   */
  async searchByKeyword(
    userId: string,
    keyword: string,
    limit = 5,
    maxAgeDays?: number,
  ): Promise<DigestDocument[]> {
    await this.ensureInitialized();

    let cutoff: string | undefined;
    if (maxAgeDays) {
      const date = new Date();
      date.setDate(date.getDate() - maxAgeDays);
      cutoff = date.toISOString();
    }

    return this.container.find<DigestDocument>({
      partitionKey: userId,
      where: and(
        eq("userId", userId),
        contains("summary", keyword, { ignoreCase: true }),
        cutoff !== undefined && gte("createdAt", cutoff),
      ),
      orderBy: { field: "createdAt", direction: "desc" },
      limit,
    });
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}
