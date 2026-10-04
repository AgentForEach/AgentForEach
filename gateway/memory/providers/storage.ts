/**
 * AgentForEach Memory Layer — Memory Store
 *
 * Memory-specific CRUD and search on the storage SDK, so it runs on any
 * adapter with vector search:
 *   - vector search — cosine similarity
 *   - hybrid search — BM25 full text + vector, fused by weighted RRF (when
 *     the adapter supports it; otherwise vector search)
 *
 * Collection (created from the spec where the adapter provisions):
 *   - Partition key:     userId
 *   - Vector:            /vector (cosine; dimensions from the embedding model)
 *   - Full text:         /text
 */

import {
  and,
  eq,
  gte,
  isConflict,
  oneOf,
  type Collection,
  type CollectionSpec,
  type Filter,
  type StorageAdapter,
} from "@agentforeach/storage";
import { createHash } from "node:crypto";
import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  type MemoryConfig,
  vectorDimsForModel,
} from "../config.js";
import { extractKeywords } from "../query-expansion.js";
import type {
  MemoryEntry,
  MemorySearchResult,
  MemoryStoreProvider,
} from "../types.js";
import { similarityFromVectorDistance } from "../../database/vector.js";

// ============================================================================
// Memory Store
// ============================================================================

// Used for duplicate detection and memory_forget thresholds; treating it as
// a distance once made forget delete the least related memories.
export { similarityFromVectorDistance } from "../../database/vector.js";

/** Fields search results carry (everything but the vector). */
const RESULT_FIELDS = [
  "id", "userId", "text", "category", "importance",
  "createdAt", "lastAccessedAt", "contentHash",
  "accessCount", "source", "tags",
];

/** The memories collection for a configuration (vector size follows the embedding model). */
export function memoriesCollection(config: MemoryConfig): CollectionSpec {
  return {
    name: config.containerId,
    partitionKey: "userId",
    vector: { field: "vector", dimensions: vectorDimsForModel(config.embeddingModel), distance: "cosine", dataType: "float32" },
    fullText: { fields: ["text"], language: "en-US" },
  };
}

/** A user's memories, optionally limited to some categories. */
function inCategories(userId: string, categories?: string[]): Filter {
  return and(eq("userId", userId), categories && categories.length > 0 && oneOf("category", categories));
}

export class StorageMemoryStore implements MemoryStoreProvider {
  readonly name = "storage";

  private storage: StorageAdapter;
  private config: MemoryConfig;
  private container!: Collection<MemoryEntry>;
  private maxFulltextTerms: number;
  private initialized = false;

  /**
   * @param config - Resolved MemoryConfig (from loadMemoryConfig or explicit).
   * @param storage - The shared storage adapter (provided by the caller,
   *                  typically the AgentClient).
   */
  constructor(config: MemoryConfig, storage: StorageAdapter) {
    this.storage = storage;
    this.config = config;
    this.maxFulltextTerms = config.maxFulltextTerms;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /** Open (or create) the memories collection. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.storage.initialize();
    this.container = await this.storage.collection<MemoryEntry>(memoriesCollection(this.config));
    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Store
  // --------------------------------------------------------------------------

  /**
   * Store a memory entry. Auto-generates id, contentHash, timestamps.
   *
   * @returns The created MemoryEntry.
   */
  async store(
    text: string,
    vector: number[],
    userId: string,
    category: string,
    importance: number,
    source?: string,
    tags?: string[],
  ): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const now = new Date().toISOString();
    const contentHash = hashText(text);
    const id = buildMemoryId(userId, contentHash);
    const entry: MemoryEntry = {
      id,
      userId,
      text,
      vector,
      category: category as MemoryEntry["category"],
      importance,
      createdAt: now,
      lastAccessedAt: now,
      contentHash,
      accessCount: 0,
      source,
      tags,
    };

    try {
      return await this.container.create(entry);
    } catch (err) {
      if (!isConflict(err)) {
        throw err;
      }
      const existing = await this.container.read(id, userId);
      if (existing) {
        return existing;
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Hybrid Search (Vector + BM25 via RRF)
  // --------------------------------------------------------------------------

  /**
   * Hybrid search: BM25 over the query's keywords and vector similarity,
   * fused by weighted RRF ([2, 1]: full text first, weighted 2 — the weights
   * follow the ranking order, whatever the old comment here claimed).
   * Falls back to vector search on adapters without hybrid ranking.
   *
   * @param queryText - The user's search query (for BM25).
   * @param queryVector - The embedding vector.
   * @param userId - Partition key filter.
   * @param limit - Max results.
   * @param categories - Optional category filter.
   * @returns Ranked MemorySearchResult array (scores from rank: 1 / (rank + 1)).
   */
  async hybridSearch(
    queryText: string,
    queryVector: number[],
    userId: string,
    limit: number,
    categories?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Query expansion improves recall for conversational queries: each
    // keyword is scored separately; with none, the raw query text is.
    const keywords = extractKeywords(queryText).slice(0, this.maxFulltextTerms);
    const terms = keywords.length > 0 ? keywords : [queryText];
    if (!this.storage.capabilities.hybridSearch || !terms.some((t) => t.length > 0)) {
      return this.vectorSearch(queryVector, userId, limit, categories);
    }

    const docs = await this.container.hybridSearch<Omit<MemoryEntry, "vector">>({
      partitionKey: userId,
      where: inCategories(userId, categories),
      rank: [
        { kind: "fullText", field: "text", terms },
        { kind: "vector", vector: queryVector },
      ],
      weights: [2, 1],
      limit: Math.min(Math.max(1, Math.floor(limit)), 100),
      select: RESULT_FIELDS,
    });

    // RRF doesn't return a numeric score: use the rank, 1 / (rank + 1).
    return docs.map((doc, index) => {
      const score = 1 / (index + 1);
      return { entry: { ...doc, vector: [] } as MemoryEntry, score, finalScore: score };
    });
  }

  /**
   * Vector-only search (no BM25 component).
   * Useful when the query is too short for meaningful full-text matching.
   */
  async vectorSearch(
    queryVector: number[],
    userId: string,
    limit: number,
    categories?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const results = await this.container.vectorSearch<Omit<MemoryEntry, "vector">>({
      partitionKey: userId,
      where: inCategories(userId, categories),
      vector: queryVector,
      limit: Math.min(Math.max(1, Math.floor(limit)), 100),
      select: RESULT_FIELDS,
    });

    return results.map(({ document, score: similarity }) => {
      const score = similarityFromVectorDistance(similarity);
      return { entry: { ...document, vector: [] } as MemoryEntry, score, finalScore: score };
    });
  }

  // --------------------------------------------------------------------------
  // Duplicate Detection
  // --------------------------------------------------------------------------

  /**
   * Check if a near-duplicate of this text already exists.
   * Uses vector similarity: if the closest match exceeds the threshold,
   * it's considered a duplicate.
   *
   * @returns The duplicate entry if found, otherwise null.
   */
  async findDuplicate(
    vector: number[],
    userId: string,
  ): Promise<MemoryEntry | null> {
    const results = await this.vectorSearch(vector, userId, 1);
    if (results.length === 0) return null;

    const top = results[0];
    if (top.score >= DUPLICATE_SIMILARITY_THRESHOLD) {
      return top.entry;
    }
    return null;
  }

  /**
   * Check for exact content-hash duplicate.
   */
  async findByContentHash(
    text: string,
    userId: string,
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();
    const hash = hashText(text);
    const id = buildMemoryId(userId, hash);

    // Fast path for new writes that use deterministic ids.
    const direct = await this.container.read(id, userId);
    if (direct && direct.contentHash === hash) {
      return direct;
    }

    // Compatibility fallback for legacy random-id memory records.
    const resources = await this.container.find<MemoryEntry>({
      partitionKey: userId,
      where: and(eq("userId", userId), eq("contentHash", hash)),
      limit: 1,
    });
    return resources.length > 0 ? resources[0] : null;
  }

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  /**
   * Delete a memory by id.
   *
   * @returns true if deleted, false if not found.
   */
  async delete(id: string, userId: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.container.delete(id, userId);
  }

  /**
   * Delete memories matching a search query.
   * Searches for similar memories and deletes them.
   *
   * @returns Count of deleted memories.
   */
  async deleteBySearch(
    queryVector: number[],
    userId: string,
    limit = 5,
  ): Promise<number> {
    const results = await this.vectorSearch(queryVector, userId, limit);
    let deleted = 0;
    for (const result of results) {
      if (result.score >= 0.7) {
        const ok = await this.delete(result.entry.id, userId);
        if (ok) deleted++;
      }
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // Count
  // --------------------------------------------------------------------------

  /**
   * Count total memories for a user.
   */
  async count(userId: string): Promise<number> {
    await this.ensureInitialized();
    return this.container.count({ partitionKey: userId, where: eq("userId", userId) });
  }

  /**
   * Count total memories for a user + source.
   * Used by auto-capture to enforce per-session limits across serverless instances.
   */
  async countBySource(userId: string, source: string, since?: string): Promise<number> {
    await this.ensureInitialized();
    return this.container.count({
      partitionKey: userId,
      where: and(eq("userId", userId), eq("source", source), since && gte("createdAt", since)),
    });
  }

  // --------------------------------------------------------------------------
  // Update Access
  // --------------------------------------------------------------------------

  /**
   * Update lastAccessedAt and increment accessCount for a memory.
   * Called when a memory is retrieved via search/recall.
   */
  async touchMemory(id: string, userId: string): Promise<void> {
    await this.ensureInitialized();
    try {
      // Atomic patch — avoids lost increments when multiple sessions
      // recall the same memory concurrently.
      await this.container.patch(id, userId, [
        { op: "set", path: "/lastAccessedAt", value: new Date().toISOString() },
        { op: "incr", path: "/accessCount", value: 1 },
      ]);
    } catch {
      // Non-critical — silently ignore touch failures
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * SHA-256 hash of text content for deduplication.
 */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Deterministic memory id: scoped to user + content hash.
 * This makes exact-duplicate writes idempotent under concurrent serverless execution.
 */
function buildMemoryId(userId: string, contentHash: string): string {
  return `mem_${hashText(`${userId}:${contentHash}`)}`;
}

