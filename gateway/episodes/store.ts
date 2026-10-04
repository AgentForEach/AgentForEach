/**
 * AgentForEach Episode Layer — Store
 *
 * Persistence layer for theme-based episode documents. Follows the same
 * collection pattern as `memory/providers/storage.ts`:
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
  StorageError,
  and,
  eq,
  gte,
  mutate,
  type Collection,
  type CollectionSpec,
  type StorageAdapter,
} from "@agentforeach/storage";
import type { EpisodeDocument } from "./types.js";
import { resolveEmbeddingModel, vectorDimsForModel } from "../memory/config.js";
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

/**
 * The episodes collection: vector search on /vector, a full-text policy on
 * /summary, and the large text fields left out of the index. Episodes are
 * embedded by the shared embeddings client, so the vector size follows the
 * configured embedding model (1536 for the default text-embedding-3-small),
 * as it does for memories.
 */
export function episodesCollection(
  containerId = "episodes",
  dimensions = vectorDimsForModel(resolveEmbeddingModel()),
): CollectionSpec {
  return {
    name: containerId,
    partitionKey: "userId",
    vector: { field: "vector", dimensions, distance: "cosine", dataType: "float32" },
    fullText: { fields: ["summary"], language: "en-US" },
    unindexed: ["summary", "highlights"],
  };
}

export class EpisodeStore {
  private storage: StorageAdapter;
  private containerId: string;
  private container!: Collection<EpisodeDocument>;
  private initialized = false;

  constructor(storage: StorageAdapter, containerId = "episodes") {
    this.storage = storage;
    this.containerId = containerId;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.storage.initialize();
    this.container = await this.storage.collection<EpisodeDocument>(episodesCollection(this.containerId));
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
    const result = await mutate(this.container, episodeId, userId, (episode) => updater(episode), {
      maxAttempts: maxRetries + 1,
    });
    if (result.status === "notFound") return null;
    if (result.status === "contention") {
      // Every attempt lost the race (412 on the last replace, as before).
      throw new StorageError(
        "PreconditionFailed",
        `Episode conditional update failed after ${maxRetries + 1} attempts: ${episodeId}`,
      );
    }
    return result.document;
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
   * Vector search by cosine similarity.
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

    // The score is a cosine similarity (higher = closer), best first.
    const results = await this.container.vectorSearch<EpisodeDocument>({
      partitionKey: userId,
      where: and(eq("userId", userId), gte("updatedAt", cutoff.toISOString())),
      vector: queryVector,
      limit,
      select: [
        "id", "userId", "theme", "summary", "topics",
        "highlights", "status", "salience", "decisions", "pending",
        "createdAt", "updatedAt",
      ],
    });

    return results.map(({ document: doc, score }) => ({
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
      score: similarityFromVectorDistance(score),
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

    return this.container.find<EpisodeDocument>({
      partitionKey: userId,
      where: and(eq("userId", userId), gte("updatedAt", cutoff.toISOString())),
      orderBy: { field: "updatedAt", direction: "desc" },
      limit,
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

    return this.container.find<EpisodeDocument>({
      partitionKey: userId,
      where: and(eq("userId", userId), eq("status", "active")),
      orderBy: { field: "updatedAt", direction: "desc" },
      limit,
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

