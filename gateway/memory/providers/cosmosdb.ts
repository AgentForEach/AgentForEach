/**
 * AgentForEach Memory Layer — Cosmos DB Memory Store
 *
 * Memory-specific CRUD and hybrid search on top of the generic database layer.
 * Replaces OpenClaw's SQLite + sqlite-vec + FTS5 with Cosmos DB's native:
 *   - VectorDistance() — cosine similarity search
 *   - FullTextScore() — BM25 full-text search
 *   - RRF()           — Reciprocal Rank Fusion for hybrid ranking
 *
 * Container setup (auto-created):
 *   - Partition key:     /userId
 *   - Vector index:      /vector (cosine, DiskANN — supports up to 4096 dims)
 *   - Full-text index:   /text
 */

import {
  VectorIndexType,
  VectorEmbeddingDataType,
  VectorEmbeddingDistanceFunction,
  type Container,
  type SqlQuerySpec,
  type JSONValue,
} from "@azure/cosmos";
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
import type {
  DatabaseProvider,
  ContainerHandle,
  ContainerOptions,
} from "../../database/index.js";

// ============================================================================
// Cosmos DB Memory Store
// ============================================================================

/**
 * Cosmos `VectorDistance` with the cosine function returns a SIMILARITY
 * (-1..1, higher is closer; ORDER BY VectorDistance already lists the closest
 * first), not a distance. Clamp it to 0..1 for the thresholds downstream
 * (duplicate detection, memory_forget). Treating it as a distance inverted
 * every score, so forget deleted the least related memories.
 */
export function similarityFromVectorDistance(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export class CosmosMemoryStore implements MemoryStoreProvider {
  readonly name = "cosmosdb";

  private db: DatabaseProvider;
  private containerId: string;
  private container!: ContainerHandle<MemoryEntry>;
  private dimensions: number;
  private maxFulltextTerms: number;
  private initialized = false;

  /**
   * Create a CosmosMemoryStore.
   *
   * @param config - Resolved MemoryConfig (from loadMemoryConfig or explicit).
   * @param db - Shared DatabaseProvider instance (required — provided by the
   *             caller, typically the AgentClient or shared.ts).
   */
  constructor(config: MemoryConfig, db: DatabaseProvider) {
    this.db = db;
    this.containerId = config.containerId;
    this.dimensions = vectorDimsForModel(config.embeddingModel);
    this.maxFulltextTerms = config.maxFulltextTerms;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Create database and container if they don't exist.
   * Sets up vector index, full-text index, and composite index policies.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.db.initialize();

    // Container definition with memory-specific indexing policies
    const containerDef: ContainerOptions = {
      id: this.containerId,
      partitionKey: { paths: ["/userId"] },
      indexingPolicy: {
        automatic: true,
        indexingMode: "consistent",
        includedPaths: [{ path: "/*" }],
        excludedPaths: [{ path: "/vector/*" }, { path: '/"_etag"/?' }],
        fullTextIndexes: [{ path: "/text" }],
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
            dimensions: this.dimensions,
            distanceFunction: VectorEmbeddingDistanceFunction.Cosine,
          },
        ],
      },
      fullTextPolicy: {
        defaultLanguage: "en-US",
        fullTextPaths: [{ path: "/text", language: "en-US" }],
      },
    };

    this.container =
      await this.db.getOrCreateContainer<MemoryEntry>(containerDef);
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
      if (!isConflictError(err)) {
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
   * Hybrid search using Cosmos DB's native RRF(VectorDistance, FullTextScore).
   *
   * This replaces OpenClaw's client-side weighted merge of sqlite-vec and FTS5.
   * Cosmos DB computes RRF server-side, which is efficient and consistent.
   *
   * @param queryText - The user's search query (for BM25).
   * @param queryVector - The embedding vector (for vector distance).
   * @param userId - Partition key filter.
   * @param limit - Max results.
   * @param categories - Optional category filter.
   * @returns Ranked MemorySearchResult array.
   */
  async hybridSearch(
    queryText: string,
    queryVector: number[],
    userId: string,
    limit: number,
    categories?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Clamp limit to a safe integer for SELECT TOP interpolation.
    // Parameterized @limit may not work with ORDER BY RANK RRF() in Cosmos DB.
    const effectiveLimit = Math.min(Math.max(1, Math.floor(limit)), 100);

    // Build category filter clause
    let categoryFilter = "";
    const parameters: { name: string; value: JSONValue }[] = [
      { name: "@userId", value: userId },
      { name: "@queryVector", value: queryVector as unknown as JSONValue },
    ];

    if (categories && categories.length > 0) {
      const categoryParams = categories.map((cat, i) => {
        const paramName = `@cat${i}`;
        parameters.push({ name: paramName, value: cat });
        return paramName;
      });
      categoryFilter = `AND c.category IN (${categoryParams.join(", ")})`;
    }

    // Split query into individual keywords for FullTextScore
    // Uses OpenClaw-style query expansion to improve conversational recall quality.
    // FullTextScore(c.text, @term0, @term1, ...) — each keyword is a separate param.
    const keywords = extractKeywords(queryText).slice(0, this.maxFulltextTerms);
    const termParams: string[] = [];
    for (let i = 0; i < keywords.length; i++) {
      const paramName = `@term${i}`;
      parameters.push({ name: paramName, value: keywords[i] });
      termParams.push(paramName);
    }

    // Hybrid RRF query with weighted scoring [2, 1] — vector weighted 2x over BM25
    // (approximates OpenClaw's 0.7 vector / 0.3 FTS weight split)
    const fullTextScoreArgs =
      termParams.length > 0 ? termParams.join(", ") : "@emptyTerm";
    if (termParams.length === 0) {
      parameters.push({ name: "@emptyTerm", value: queryText });
    }

    const query: SqlQuerySpec = {
      query: `
        SELECT TOP ${effectiveLimit}
          c.id, c.userId, c.text, c.category, c.importance,
          c.createdAt, c.lastAccessedAt, c.contentHash,
          c.accessCount, c.source, c.tags
        FROM c
        WHERE c.userId = @userId ${categoryFilter}
        ORDER BY RANK RRF(
          FullTextScore(c.text, ${fullTextScoreArgs}),
          VectorDistance(c.vector, @queryVector),
          [2, 1]
        )
      `,
      parameters,
    };

    const { resources } = await (
      this.container.getRawContainer() as Container
    ).items
      .query<Omit<MemoryEntry, "vector">>(query, { partitionKey: userId })
      .fetchAll();

    // Map to MemorySearchResult with RRF rank-based scores
    return resources.map((doc, index) => {
      // RRF doesn't return a numeric score directly — use rank-based scoring
      // Score = 1 / (rank + 1) to give higher scores to better ranks
      const score = 1 / (index + 1);
      return {
        entry: { ...doc, vector: [] } as MemoryEntry,
        score,
        finalScore: score,
      };
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

    let categoryFilter = "";
    const parameters: { name: string; value: JSONValue }[] = [
      { name: "@userId", value: userId },
      { name: "@queryVector", value: queryVector as unknown as JSONValue },
    ];

    if (categories && categories.length > 0) {
      const categoryParams = categories.map((cat, i) => {
        const paramName = `@cat${i}`;
        parameters.push({ name: paramName, value: cat });
        return paramName;
      });
      categoryFilter = `AND c.category IN (${categoryParams.join(", ")})`;
    }

    // Clamp limit to a safe integer for SELECT TOP interpolation.
    const effectiveLimit = Math.min(Math.max(1, Math.floor(limit)), 100);

    const query: SqlQuerySpec = {
      query: `
        SELECT TOP ${effectiveLimit}
          c.id, c.userId, c.text, c.category, c.importance,
          c.createdAt, c.lastAccessedAt, c.contentHash,
          c.accessCount, c.source, c.tags,
          VectorDistance(c.vector, @queryVector) AS vectorDistance
        FROM c
        WHERE c.userId = @userId ${categoryFilter}
        ORDER BY VectorDistance(c.vector, @queryVector)
      `,
      parameters,
    };

    const { resources } = await (
      this.container.getRawContainer() as Container
    ).items
      .query<Omit<MemoryEntry, "vector"> & { vectorDistance: number }>(query, {
        partitionKey: userId,
      })
      .fetchAll();

    return resources.map((doc) => {
      const { vectorDistance, ...rest } = doc;
      const score = similarityFromVectorDistance(vectorDistance);
      return {
        entry: { ...rest, vector: [] } as MemoryEntry,
        score,
        finalScore: score,
      };
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
    const resources = await this.container.query<MemoryEntry>(
      {
        query:
          "SELECT TOP 1 * FROM c WHERE c.userId = @userId AND c.contentHash = @hash",
        parameters: [
          { name: "@userId", value: userId },
          { name: "@hash", value: hash },
        ],
      },
      { partitionKey: userId },
    );
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
    return this.container.count(
      "c.userId = @userId",
      [{ name: "@userId", value: userId }],
      { partitionKey: userId },
    );
  }

  /**
   * Count total memories for a user + source.
   * Used by auto-capture to enforce per-session limits across serverless instances.
   */
  async countBySource(userId: string, source: string): Promise<number> {
    await this.ensureInitialized();
    return this.container.count(
      "c.userId = @userId AND c.source = @source",
      [
        { name: "@userId", value: userId },
        { name: "@source", value: source },
      ],
      { partitionKey: userId },
    );
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

function isConflictError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === 409 || e.code === "Conflict" || e.statusCode === 409;
}
