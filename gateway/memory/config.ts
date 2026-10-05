/**
 * AgentForEach Memory Layer — Configuration
 *
 * Loads memory configuration from agentforeach.json ("memory" section).
 * Follows the same modular config pattern as auth/, llms/, websocket/.
 *
 * Key integration points:
 *   - Uses shared `loadConfigSection()` from utils/config
 *   - Resolves embedding config from the `llms` section (no duplication)
 *   - Database connection is resolved from env vars / shared database layer
 *   - Env vars still work as overrides — config is the base, env vars win
 */

import { loadConfigSection } from "../utils/index.js";
import { resolveEmbeddingConfig } from "../llms/index.js";

// ============================================================================
// Memory Categories
// ============================================================================

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "context",
  "other",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// ============================================================================
// Embedding Config
// ============================================================================

/** Supported embedding models and their vector dimensions. */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  "amazon.titan-embed-text-v2:0": 1024,
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
};

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export function vectorDimsForModel(model: string): number {
  const dims = EMBEDDING_DIMENSIONS[model];
  if (!dims) {
    throw new Error(
      `Unsupported embedding model: ${model}. Supported: ${Object.keys(EMBEDDING_DIMENSIONS).join(", ")}`,
    );
  }
  return dims;
}

// ============================================================================
// Temporal Decay Config
// ============================================================================

export type TemporalDecayConfig = {
  enabled: boolean;
  /** Half-life in days — after this many days, score is halved. */
  halfLifeDays: number;
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

// ============================================================================
// MMR Config
// ============================================================================

export type MMRConfig = {
  /** Enable/disable MMR re-ranking. Default: false (opt-in). */
  enabled: boolean;
  /** Lambda: 0 = max diversity, 1 = max relevance. Default: 0.7. */
  lambda: number;
};

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

// ============================================================================
// agentforeach.json "memory" Section Shape
// ============================================================================

/**
 * Configuration shape as stored in agentforeach.json "memory" section.
 *
 * Embedding API key and model are NOT duplicated here — they come
 * from the `llms.embedding` section via `resolveEmbeddingConfig()`.
 *
 * Database connection is NOT duplicated here — it comes from the
 * agentforeach.json "database" section (resolved via `loadDatabaseConfig()`)
 * and the shared storage adapter passed to `createMemoryLayer()`.
 */
export interface MemoryJsonConfig {
  /** Enable/disable the memory subsystem entirely. Default: true. */
  enabled?: boolean;

  /** Store provider name. Default: "storage" ("cosmosdb", its old name, also works). */
  provider?: string;

  /** Cosmos DB container name for memories. Default: "memories". */
  containerId?: string;

  /** Enable automatic memory capture from user messages. Default: false. */
  autoCapture?: boolean;

  /** Enable automatic memory injection into agent context. Default: true. */
  autoRecall?: boolean;

  /** Max message length eligible for auto-capture (100–10000). Default: 500. */
  captureMaxChars?: number;

  /** Search defaults. */
  search?: {
    /** Default number of results returned. Default: 5. */
    limit?: number;
    /** Minimum score threshold (0–1). Default: 0.1. */
    minScore?: number;
  };

  /** Auto-recall specific settings. */
  recall?: {
    /** Max memories injected into context. Default: 3. */
    limit?: number;
    /** Minimum score for injection. Default: 0.3. */
    minScore?: number;
  };

  /** Auto-capture specific settings. */
  capture?: {
    /** Maximum memories per conversation/source. Default: 3. */
    maxPerConversation?: number;
  };

  /** Duplicate detection similarity threshold (0–1). Default: 0.95. */
  duplicateThreshold?: number;

  /** Default importance for auto-captured and tool-stored memories. Default: 0.7. */
  defaultImportance?: number;

  /** Importance threshold for evergreen memories (exempt from temporal decay). Default: 0.9. */
  evergreenImportanceThreshold?: number;

  /** Max characters for embedding text sanitization. Default: 8000. */
  maxEmbeddingChars?: number;

  /** Max full-text search terms in hybrid queries. Default: 5. */
  maxFulltextTerms?: number;

  /** Vector similarity threshold for near-match detection. Default: 0.7. */
  vectorSimilarityThreshold?: number;

  /** High confidence threshold for auto-actions (e.g. auto-delete). Default: 0.9. */
  highConfidenceThreshold?: number;

  /** Minimum candidate threshold for presenting options. Default: 0.5. */
  candidateThreshold?: number;

  /** Temporal decay settings for recency-aware scoring. */
  temporalDecay?: Partial<TemporalDecayConfig>;

  /** MMR settings for diversity-aware re-ranking. */
  mmr?: Partial<MMRConfig>;
}

// ============================================================================
// Resolved Config (used internally by memory components)
// ============================================================================

/**
 * Fully resolved memory config with all defaults applied.
 * This is what memory components actually consume.
 */
export type MemoryConfig = {
  /** Whether memory is enabled. */
  enabled: boolean;

  /** Store provider name (e.g. "storage", "noop"). */
  storeProvider: string;

  /** Cosmos DB container name. */
  containerId: string;

  /** Embedding API key (resolved from llms config). */
  embeddingApiKey: string;

  /** Embedding provider (llms.embedding.provider); "bedrock" needs no API key. */
  embeddingProvider?: string;

  /** Embedding model (resolved from llms config). */
  embeddingModel: string;

  /** Embedding base URL (resolved from llms config). */
  embeddingBaseUrl: string | undefined;

  /** Enable automatic memory capture from user messages. */
  autoCapture: boolean;

  /** Enable automatic memory injection into agent context. */
  autoRecall: boolean;

  /** Max message length eligible for auto-capture. */
  captureMaxChars: number;

  /** Search defaults. */
  searchLimit: number;
  searchMinScore: number;

  /** Auto-recall specific settings. */
  recallLimit: number;
  recallMinScore: number;

  /** Auto-capture limit per conversation, counted over the last 24 hours. */
  captureMaxPerConversation: number;

  /** Duplicate detection similarity threshold. */
  duplicateThreshold: number;

  /** Temporal decay settings. */
  temporalDecay: TemporalDecayConfig;

  /** MMR settings. */
  mmr: MMRConfig;

  /** Default importance for auto-captured and tool-stored memories. */
  defaultImportance: number;

  /** Importance threshold for evergreen memories (exempt from temporal decay). */
  evergreenImportanceThreshold: number;

  /** Max characters for embedding text sanitization. */
  maxEmbeddingChars: number;

  /** Max full-text search terms in hybrid queries. */
  maxFulltextTerms: number;

  /** Vector similarity threshold for near-match detection. */
  vectorSimilarityThreshold: number;

  /** High confidence threshold for auto-actions. */
  highConfidenceThreshold: number;

  /** Minimum candidate threshold for presenting options. */
  candidateThreshold: number;
};

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONTAINER_ID = "memories";
const DEFAULT_CAPTURE_MAX_CHARS = 800;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.1;
const DEFAULT_RECALL_LIMIT = 3;
const DEFAULT_RECALL_MIN_SCORE = 0.3;
const DEFAULT_MAX_CAPTURES_PER_CONVERSATION = 5;
const DEFAULT_DUPLICATE_THRESHOLD = 0.95;
const DEFAULT_IMPORTANCE = 0.7;
const DEFAULT_EVERGREEN_IMPORTANCE_THRESHOLD = 0.9;
const DEFAULT_MAX_EMBEDDING_CHARS = 8000;
const DEFAULT_MAX_FULLTEXT_TERMS = 5;
const DEFAULT_VECTOR_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 0.9;
const DEFAULT_CANDIDATE_THRESHOLD = 0.5;

// Re-export constants still referenced by sibling memory files.
// Others are used only within loadMemoryConfig() / validateConfig() above.
export {
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_DUPLICATE_THRESHOLD as DUPLICATE_SIMILARITY_THRESHOLD,
};

// ============================================================================
// Config Loader
// ============================================================================

let _memoryConfig: MemoryConfig | undefined;

/**
 * Load memory config from agentforeach.json and resolve all defaults + dependencies.
 *
 * Embedding config is resolved from the `llms.embedding` section —
 * memory doesn't maintain its own API keys or model references.
 */
export function loadMemoryConfig(): MemoryConfig {
  if (_memoryConfig) return _memoryConfig;

  const section = loadConfigSection<MemoryJsonConfig>("memory");
  const json = section ?? {};

  // Resolve embedding from llms config (single source of truth)
  const embedding = resolveEmbeddingConfig();
  const embeddingApiKey = embedding.apiKey ?? "";
  const embeddingModel = embedding.model;
  const embeddingBaseUrl = embedding.baseUrl;

  // Validate embedding model is supported
  vectorDimsForModel(embeddingModel);

  // Validate captureMaxChars bounds
  const captureMaxChars = json.captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS;
  if (captureMaxChars < 100 || captureMaxChars > 10_000) {
    throw new Error("memory: captureMaxChars must be between 100 and 10000");
  }

  // `enabled` is the master switch: disabled means the whole surface is off,
  // not just parts of it. Without this, a deployment flipping enabled:false
  // still had the memory tools offered to the model and auto-recall/capture
  // running if their own flags said so — "disabled" that still reads and
  // writes memories.
  const enabled = json.enabled !== false;
  _memoryConfig = {
    enabled,
    storeProvider: json.provider ?? "storage",
    containerId: json.containerId ?? DEFAULT_CONTAINER_ID,
    embeddingApiKey,
    embeddingProvider: embedding.provider,
    embeddingModel,
    embeddingBaseUrl,
    autoCapture: enabled && (json.autoCapture ?? false),
    autoRecall: enabled && json.autoRecall !== false,
    captureMaxChars,
    searchLimit: json.search?.limit ?? DEFAULT_SEARCH_LIMIT,
    searchMinScore: json.search?.minScore ?? DEFAULT_MIN_SCORE,
    recallLimit: json.recall?.limit ?? DEFAULT_RECALL_LIMIT,
    recallMinScore: json.recall?.minScore ?? DEFAULT_RECALL_MIN_SCORE,
    captureMaxPerConversation:
      json.capture?.maxPerConversation ?? DEFAULT_MAX_CAPTURES_PER_CONVERSATION,
    duplicateThreshold: json.duplicateThreshold ?? DEFAULT_DUPLICATE_THRESHOLD,
    temporalDecay: { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...json.temporalDecay },
    mmr: { ...DEFAULT_MMR_CONFIG, ...json.mmr },
    defaultImportance: json.defaultImportance ?? DEFAULT_IMPORTANCE,
    evergreenImportanceThreshold: json.evergreenImportanceThreshold ?? DEFAULT_EVERGREEN_IMPORTANCE_THRESHOLD,
    maxEmbeddingChars: json.maxEmbeddingChars ?? DEFAULT_MAX_EMBEDDING_CHARS,
    maxFulltextTerms: json.maxFulltextTerms ?? DEFAULT_MAX_FULLTEXT_TERMS,
    vectorSimilarityThreshold: json.vectorSimilarityThreshold ?? DEFAULT_VECTOR_SIMILARITY_THRESHOLD,
    highConfidenceThreshold: json.highConfidenceThreshold ?? DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
    candidateThreshold: json.candidateThreshold ?? DEFAULT_CANDIDATE_THRESHOLD,
  };

  return _memoryConfig;
}

// ============================================================================
// Resolved Accessors
// ============================================================================

/** Check whether the memory subsystem is enabled. */
export function isMemoryEnabled(): boolean {
  return loadMemoryConfig().enabled;
}

/** Get the resolved container ID. */
export function resolveContainerId(): string {
  return loadMemoryConfig().containerId;
}

/** Get the resolved embedding API key (from llms config). */
export function resolveEmbeddingApiKey(): string {
  return loadMemoryConfig().embeddingApiKey;
}

/** Get the resolved embedding model (from llms config). */
export function resolveEmbeddingModel(): string {
  return loadMemoryConfig().embeddingModel;
}

/** Get the resolved embedding base URL (from llms config). */
export function resolveEmbeddingBaseUrl(): string | undefined {
  return loadMemoryConfig().embeddingBaseUrl;
}

// ============================================================================
// Config Validation (simplified)
// ============================================================================

/**
 * Validate that a MemoryConfig has all required fields.
 * Used when callers provide explicit config (bypassing agentforeach.json).
 */
export function validateConfig(config: MemoryConfig): MemoryConfig {
  if (!config.embeddingApiKey && config.embeddingProvider !== "bedrock") {
    throw new Error("memory: embedding API key is required");
  }
  vectorDimsForModel(config.embeddingModel);

  const captureMaxChars = config.captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS;
  if (captureMaxChars < 100 || captureMaxChars > 10_000) {
    throw new Error("memory: captureMaxChars must be between 100 and 10000");
  }

  // Same master switch loadMemoryConfig applies to the JSON path: a layer
  // built from an explicit config with enabled:false must not recall or
  // capture either.
  return {
    ...config,
    autoCapture: config.enabled && config.autoCapture,
    autoRecall: config.enabled && config.autoRecall,
  };
}

/**
 * Reset the cached config (for testing).
 */
export function resetMemoryConfig(): void {
  _memoryConfig = undefined;
}
