/**
 * AgentForEach Episode Layer — Cosmos DB Store
 *
 * Persistence layer for theme-based episode documents. Follows the same
 * container setup pattern as `memory/providers/cosmosdb.ts`:
 *   - Partition key: /userId
 *   - Vector index: /vector (DiskANN, cosine) — for semantic search
 *   - Full-text index: /summary — for keyword search
 *
 * Two recall strategies:
 *   1. Semantic search — embed query, find relevant episodes (primary)
 *   2. Temporal query — get most recently updated episodes (fallback)
 *
 * All operations are scoped to a userId partition for efficiency.
 */

import {
  VectorIndexType,
  VectorEmbeddingDataType,
  VectorEmbeddingDistanceFunction,
  type Container,
  type SqlQuerySpec,
} from "@azure/cosmos";
import type {
  DatabaseProvider,
  ContainerHandle,
  ContainerOptions,
} from "../database/index.js";
import type { EpisodeDocument } from "./types.js";
import { similarityFromVectorDistance } from "../database/vector.js";

// ============================================================================
// Episode Search Result
// ============================================================================

export interface EpisodeSearchResult {
  episode: EpisodeDocument;
  /** Similarity score (0-1, higher = more relevant). */
  score: number;
}

// ============================================================================
// Episode Store
// ============================================================================

export class EpisodeStore {
  private db: DatabaseProvider;
  private containerId: string;
  private container!: ContainerHandle<EpisodeDocument>;
  private initialized = false;

  constructor(db: DatabaseProvider, containerId = "episodes") {
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
      partitionKey: { paths: ["/userId"] },
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [
          { path: "/vector/*" },
          { path: "/summary/*" },
          { path: "/highlights/*" },
          { path: '/"_etag"/?' },
        ],
        fullTextIndexes: [{ path: "/summary" }],
        vectorIndexes: [
          {
            path: "/vector",
            type: VectorIndexType.DiskANN,
          },
        ],
      },
      vectorEmbeddingPolicy: {
        vectorEmbeddings: [
          {
            path: "/vector",
            dataType: VectorEmbeddingDataType.Float32,
            dimensions: 1536, // text-embedding-3-small
            distanceFunction: VectorEmbeddingDistanceFunction.Cosine,
          },
        ],
      },
      fullTextPolicy: {
        defaultLanguage: "en-US",
        fullTextPaths: [{ path: "/summary", language: "en-US" }],
      },
    };

    this.container =
      await this.db.getOrCreateContainer<EpisodeDocument>(containerDef);
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Upsert (create or replace — used by both create and update tools)
  // --------------------------------------------------------------------------

  /**
   * Create or replace an episode document.
   * Used for both initial creation and updates (new highlights, updated summary).
   */
  async upsert(episode: EpisodeDocument): Promise<EpisodeDocument> {
    await this.ensureInitialized();
    return this.container.upsert(episode);
  }

  // --------------------------------------------------------------------------
  // Conditional Update (ETag-based optimistic concurrency)
  // --------------------------------------------------------------------------

  /**
   * Read-modify-write with optimistic concurrency.
   *
   * Reads the episode, applies the `updater` function, then replaces the
   * document with an ETag condition. If a concurrent write happened between
   * read and replace, retries from scratch (up to `maxRetries` times).
   *
   * This prevents lost updates when two sessions (e.g., web + Telegram)
   * update the same episode concurrently.
   */
  async conditionalUpdate(
    userId: string,
    episodeId: string,
    updater: (episode: EpisodeDocument) => EpisodeDocument | Promise<EpisodeDocument>,
    maxRetries = 3,
  ): Promise<EpisodeDocument | null> {
    await this.ensureInitialized();
    const raw = this.container.getRawContainer() as Container;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const { resource } = await raw.item(episodeId, userId).read<
        EpisodeDocument & { _etag?: string }
      >();
      if (!resource) return null;

      const etag = resource._etag;
      const updated = await updater(resource);

      // If no ETag available (shouldn't happen with Cosmos), fall back to upsert
      if (!etag) {
        return this.container.upsert(updated);
      }

      try {
        const { resource: replaced } = await raw
          .item(episodeId, userId)
          .replace<EpisodeDocument>(updated, {
            accessCondition: { type: "IfMatch", condition: etag },
          });
        return replaced ?? updated;
      } catch (err) {
        if (isPreconditionFailed(err) && attempt < maxRetries) {
          continue; // Retry with fresh read
        }
        throw err;
      }
    }

    throw new Error(
      `Episode conditional update failed after ${maxRetries + 1} attempts: ${episodeId}`,
    );
  }

  // --------------------------------------------------------------------------
  // Read by ID
  // --------------------------------------------------------------------------

  /**
   * Fetch a single episode by ID and userId (partition key).
   * Returns null if not found.
   */
  async getById(
    userId: string,
    episodeId: string,
  ): Promise<EpisodeDocument | null> {
    await this.ensureInitialized();
    return this.container.read(episodeId, userId);
  }

  // --------------------------------------------------------------------------
  // Semantic Search (primary recall mechanism)
  // --------------------------------------------------------------------------

  /**
   * Find episodes semantically relevant to a query vector.
   *
   * Uses Cosmos DB VectorDistance() for cosine similarity search.
   * Only returns episodes within the max age window (based on updatedAt).
   * Results are ordered by similarity (most relevant first).
   */
  async semanticSearch(
    queryVector: number[],
    userId: string,
    limit = 3,
    maxAgeDays = 14,
  ): Promise<EpisodeSearchResult[]> {
    await this.ensureInitialized();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    // VectorDistance with cosine returns a similarity (higher = closer).
    const query: SqlQuerySpec = {
      query: `
        SELECT TOP @limit
          c.id, c.userId, c.theme, c.summary, c.topics,
          c.highlights, c.status, c.salience, c.decisions, c.pending,
          c.createdAt, c.updatedAt,
          VectorDistance(c.vector, @queryVector) AS distance
        FROM c
        WHERE c.userId = @userId
          AND c.updatedAt >= @cutoff
        ORDER BY VectorDistance(c.vector, @queryVector)
      `,
      parameters: [
        { name: "@userId", value: userId },
        { name: "@queryVector", value: queryVector },
        { name: "@limit", value: limit },
        { name: "@cutoff", value: cutoff.toISOString() },
      ],
    };

    const results = await (
      this.container.getRawContainer() as Container
    ).items
      .query<EpisodeDocument & { distance: number }>(query, {
        partitionKey: userId,
      })
      .fetchAll();

    return results.resources.map((doc) => ({
      episode: {
        id: doc.id,
        userId: doc.userId,
        theme: doc.theme,
        summary: doc.summary,
        vector: [], // Don't return full vector in search results
        topics: doc.topics,
        highlights: doc.highlights,
        status: doc.status,
        salience: doc.salience ?? 0.5,
        decisions: doc.decisions,
        pending: doc.pending,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      },
      score: similarityFromVectorDistance(doc.distance),
    }));
  }

  // --------------------------------------------------------------------------
  // Recent Episodes (fallback / when no embeddings available)
  // --------------------------------------------------------------------------

  /**
   * Get recently updated episodes for a user, ordered by updatedAt (newest first).
   *
   * Pure temporal query — no embedding needed. Used as fallback when
   * embeddings are unavailable, or for explicit "what did we do recently?"
   */
  async getRecent(
    userId: string,
    limit = 3,
    maxAgeDays = 14,
  ): Promise<EpisodeDocument[]> {
    await this.ensureInitialized();

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const query: SqlQuerySpec = {
      query: `
        SELECT TOP @limit *
        FROM c
        WHERE c.userId = @userId
          AND c.updatedAt >= @cutoff
        ORDER BY c.updatedAt DESC
      `,
      parameters: [
        { name: "@userId", value: userId },
        { name: "@limit", value: limit },
        { name: "@cutoff", value: cutoff.toISOString() },
      ],
    };

    return this.container.query<EpisodeDocument>(query, {
      partitionKey: userId,
    });
  }

  // --------------------------------------------------------------------------
  // Active Episodes
  // --------------------------------------------------------------------------

  /**
   * Get active (non-concluded) episodes for a user, ordered by updatedAt.
   * Used for checking how many active episodes a user has.
   */
  async getActive(
    userId: string,
    limit = 10,
  ): Promise<EpisodeDocument[]> {
    await this.ensureInitialized();

    const query: SqlQuerySpec = {
      query: `
        SELECT TOP @limit *
        FROM c
        WHERE c.userId = @userId
          AND c.status = "active"
        ORDER BY c.updatedAt DESC
      `,
      parameters: [
        { name: "@userId", value: userId },
        { name: "@limit", value: limit },
      ],
    };

    return this.container.query<EpisodeDocument>(query, {
      partitionKey: userId,
    });
  }

  // --------------------------------------------------------------------------
  // Session Dedup Check
  // --------------------------------------------------------------------------

  /**
   * Check if a specific session has already contributed a highlight to an episode.
   * Used to prevent duplicate highlights from the same session.
   */
  async hasSessionContributed(
    userId: string,
    episodeId: string,
    sessionId: string,
  ): Promise<boolean> {
    await this.ensureInitialized();

    const episode = await this.container.read(episodeId, userId);
    if (!episode) return false;

    return episode.highlights.some((h) => h.sessionId === sessionId);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isPreconditionFailed(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === 412 || e.statusCode === 412;
}
