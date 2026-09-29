/**
 * AgentForEach Digests Module — Cosmos DB Store
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

import type { SqlQuerySpec } from "@azure/cosmos";
import type {
  DatabaseProvider,
  ContainerHandle,
  ContainerOptions,
} from "../database/index.js";
import type { DigestDocument } from "./types.js";

// ============================================================================
// Digest Store
// ============================================================================

export class DigestStore {
  private db: DatabaseProvider;
  private containerId: string;
  private container!: ContainerHandle<DigestDocument>;
  private initialized = false;

  constructor(db: DatabaseProvider, containerId = "session-digests") {
    this.db = db;
    this.containerId = containerId;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.db.initialize();

    const containerDef: ContainerOptions = {
      id: this.containerId,
      partitionKey: {
        paths: ["/userId"],
      },
      defaultTtl: -1, // Per-document TTL enabled
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [{ path: '/"_etag"/?' }],
      },
    };

    this.container =
      await this.db.getOrCreateContainer<DigestDocument>(containerDef);
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

    const query: SqlQuerySpec = {
      query: `
        SELECT TOP @limit *
        FROM c
        WHERE c.userId = @userId
        ORDER BY c.createdAt DESC
      `,
      parameters: [
        { name: "@userId", value: userId },
        { name: "@limit", value: limit },
      ],
    };

    return this.container.query<DigestDocument>(query, {
      partitionKey: userId,
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

    const lowerKeyword = keyword.toLowerCase();
    let sql = `
      SELECT TOP @limit *
      FROM c
      WHERE c.userId = @userId
        AND CONTAINS(LOWER(c.summary), @keyword)
    `;
    const params: { name: string; value: string | number }[] = [
      { name: "@userId", value: userId },
      { name: "@keyword", value: lowerKeyword },
      { name: "@limit", value: limit },
    ];

    if (maxAgeDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - maxAgeDays);
      sql += ` AND c.createdAt >= @cutoff`;
      params.push({ name: "@cutoff", value: cutoff.toISOString() });
    }

    sql += ` ORDER BY c.createdAt DESC`;

    return this.container.query<DigestDocument>(
      { query: sql, parameters: params },
      { partitionKey: userId },
    );
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}
