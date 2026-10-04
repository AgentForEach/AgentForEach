/**
 * AgentForEach Memory Layer — Types
 *
 * Core type definitions for the Cosmos DB-backed memory system.
 */

import type { MemoryCategory } from "./config.js";

// ============================================================================
// Cosmos DB Document Types
// ============================================================================

/**
 * A stored memory entry in Cosmos DB.
 *
 * Partition key: /userId
 * Vector index on: /vector  (cosine, DiskANN, dims per embedding model)
 * Full-text index on: /text
 */
export type MemoryEntry = {
  /** Cosmos DB document id (UUID). */
  id: string;
  /** Owner user id — serves as partition key. */
  userId: string;
  /** The memory text content. */
  text: string;
  /** Embedding vector (float32[]) for vector search. */
  vector: number[];
  /** Auto-detected or user-assigned category. */
  category: MemoryCategory;
  /** Importance score 0–1. Higher = more important. Default: 0.5. */
  importance: number;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last access/retrieval. */
  lastAccessedAt: string;
  /** SHA-256 hash of `text` for deduplication. */
  contentHash: string;
  /** Number of times this memory has been retrieved. */
  accessCount: number;
  /** Optional source reference (e.g., conversationId). */
  source?: string;
  /** Optional metadata tags. */
  tags?: string[];
};

/**
 * A memory search result — enriched with scoring metadata.
 */
export type MemorySearchResult = {
  /** The memory entry. */
  entry: MemoryEntry;
  /** Combined relevance score (RRF or weighted). Higher is better. */
  score: number;
  /** Score after temporal decay is applied (if enabled). */
  decayedScore?: number;
  /** Score after MMR re-ranking is applied (if enabled). */
  mmrScore?: number;
  /** The final score used for ranking. */
  finalScore: number;
};

// ============================================================================
// Search & Store Options
// ============================================================================

export type MemorySearchOptions = {
  /** Maximum results to return. */
  limit?: number;
  /** Minimum score threshold (0–1). */
  minScore?: number;
  /** Filter to specific categories. */
  categories?: MemoryCategory[];
  /** Filter to specific user. Required. */
  userId: string;
  /** Apply temporal decay? Overrides config if set. */
  temporalDecay?: boolean;
  /** Apply MMR re-ranking? Overrides config if set. */
  mmr?: boolean;
};

export type MemoryStoreOptions = {
  /** Owner user id. Required. */
  userId: string;
  /** Category override (auto-detected if omitted). */
  category?: MemoryCategory;
  /** Importance override (0–1, default 0.5). */
  importance?: number;
  /** Source identifier (e.g., conversationId). */
  source?: string;
  /** Optional tags. */
  tags?: string[];
};

// ============================================================================
// Memory Layer Interface
// ============================================================================

/**
 * Abstract store provider that memory components (auto-recall, auto-capture,
 * tools) depend on.  Implementations live under `providers/`.
 *
 * The interface matches the public surface of `StorageMemoryStore` so existing
 * code works unchanged — but consumers now depend on the interface, not the
 * concrete class.
 */
export interface MemoryStoreProvider {
  /** Human-readable provider name (e.g. "storage", "noop"). */
  readonly name: string;

  /** Create/verify the backing store (container, table, etc.). */
  initialize(): Promise<void>;

  // -- Write -----------------------------------------------------------------

  /** Persist a memory entry. Must generate id, contentHash, timestamps. */
  store(
    text: string,
    vector: number[],
    userId: string,
    category: string,
    importance: number,
    source?: string,
    tags?: string[],
  ): Promise<MemoryEntry>;

  // -- Read / Search ---------------------------------------------------------

  /** Hybrid (vector + full-text) search.  Returns ranked results. */
  hybridSearch(
    queryText: string,
    queryVector: number[],
    userId: string,
    limit: number,
    categories?: string[],
  ): Promise<MemorySearchResult[]>;

  /** Vector-only search (for short queries). */
  vectorSearch(
    queryVector: number[],
    userId: string,
    limit: number,
    categories?: string[],
  ): Promise<MemorySearchResult[]>;

  /** Near-duplicate check via vector similarity. */
  findDuplicate(vector: number[], userId: string): Promise<MemoryEntry | null>;

  /** Exact duplicate check via content hash. */
  findByContentHash(text: string, userId: string): Promise<MemoryEntry | null>;

  // -- Delete ----------------------------------------------------------------

  /** Delete a single memory by id.  Returns true if found & deleted. */
  delete(id: string, userId: string): Promise<boolean>;

  /** Delete memories matching a vector query.  Returns count deleted. */
  deleteBySearch(
    queryVector: number[],
    userId: string,
    limit?: number,
  ): Promise<number>;

  // -- Counts ----------------------------------------------------------------

  /** Total memories for a user. */
  count(userId: string): Promise<number>;

  /**
   * Memories for a user + source (for per-conversation rate limiting),
   * optionally only those created at or after `since` (ISO time).
   */
  countBySource(userId: string, source: string, since?: string): Promise<number>;

  // -- Maintenance -----------------------------------------------------------

  /** Update lastAccessedAt + increment accessCount (best-effort). */
  touchMemory(id: string, userId: string): Promise<void>;
}

/**
 * The public API for the memory layer.
 * Returned by `createMemoryLayer()`.
 */
export interface MemoryLayer {
  /** Store a new memory. Returns the created entry (or null if rejected/duplicate). */
  store(text: string, options: MemoryStoreOptions): Promise<MemoryEntry | null>;

  /** Search memories using hybrid vector + BM25 search. */
  search(
    query: string,
    options: MemorySearchOptions,
  ): Promise<MemorySearchResult[]>;

  /** Delete a specific memory by id. */
  delete(id: string, userId: string): Promise<boolean>;

  /** Delete all memories matching a query (returns count deleted). */
  forget(query: string, userId: string): Promise<number>;

  /** Count total memories for a user. */
  count(userId: string): Promise<number>;

  /**
   * Auto-recall middleware: given a user message, return formatted
   * relevant memories for injection into system prompt.
   * Returns empty string if auto-recall is disabled or no matches.
   */
  recall(userMessage: string, userId: string): Promise<string>;

  /**
   * Auto-capture middleware: given a user message, decide whether
   * to capture it as a memory and store if appropriate.
   * Returns the captured entry (or null if skipped).
   */
  capture(
    userMessage: string,
    userId: string,
    source?: string,
  ): Promise<MemoryEntry | null>;

  /** Get the function tool definitions for the OpenAI Responses API. */
  getToolDefinitions(): ToolDefinition[];

  /**
   * Handle a function tool call from the OpenAI Responses API.
   * Returns the string result to feed back as tool output.
   */
  handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string>;

  /** Initialize the Cosmos DB container (create if not exists). */
  initialize(): Promise<void>;
}

// ============================================================================
// OpenAI Responses API Tool Types
// ============================================================================

/**
 * Function tool definition compatible with OpenAI Responses API.
 * These are registered as `type: "function"` tools.
 */
export type ToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type ToolParameterProperty = {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
};
