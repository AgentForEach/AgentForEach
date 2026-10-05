/**
 * AgentForEach Memory Layer — Public API
 *
 * Factory function `createMemoryLayer()` wires up all components:
 *   - Memory store (on the shared storage adapter)
 *   - OpenAI embeddings client (resolved from llms config)
 *   - Auto-recall middleware
 *   - Auto-capture middleware
 *   - Function tool handlers
 *
 * Configuration is resolved from agentforeach.json ("memory" section) using the
 * same modular config pattern as auth/, llms/, and websocket/:
 *
 * ```ts
 * import { createMemoryLayer } from "./memory/index.js";
 * import { getSharedStorage } from "./database/index.js";
 *
 * const memory = createMemoryLayer(getSharedStorage());
 * await memory.initialize();
 * ```
 *
 * Embedding model and API key are resolved from the `llms.embedding` section.
 * Storage is shared through the `StorageAdapter` instance — no duplicate
 * endpoint/key config needed.
 */

import {
  loadMemoryConfig,
  validateConfig,
  type MemoryConfig,
} from "./config.js";
import type {
  MemoryLayer,
  MemoryEntry,
  MemorySearchResult,
  ToolDefinition,
} from "./types.js";
import { resolveStoreProvider } from "./providers/index.js";
import { EmbeddingsClient } from "./embeddings.js";
import { AutoRecall } from "./auto-recall.js";
import { AutoCapture } from "./auto-capture.js";
import { MemoryToolHandler, getToolDefinitions } from "./tools.js";
import { detectCategory } from "./security.js";
import { applyTemporalDecay } from "./temporal-decay.js";
import { applyMMR } from "./mmr.js";
import type { StorageAdapter } from "@agentforeach/storage";

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a fully-wired memory layer instance.
 *
 * Call `initialize()` before first use to open the memories collection.
 *
 * Configuration is auto-resolved from agentforeach.json ("memory" section).
 * Embedding config comes from the "llms.embedding" section.
 * Pass an explicit `config` to override the auto-resolved values
 * (useful for tests or standalone usage).
 *
 * @param storage - Shared storage adapter (required).
 * @param config - Optional explicit MemoryConfig. If omitted, resolved
 *                 automatically from agentforeach.json via `loadMemoryConfig()`.
 * @returns A MemoryLayer implementation.
 */
export function createMemoryLayer(
  storage: StorageAdapter,
  config?: MemoryConfig,
): MemoryLayer {
  const resolved = config ? validateConfig(config) : loadMemoryConfig();

  // Core components — store is resolved via the provider registry
  const store = resolveStoreProvider(resolved, storage);
  const embeddings = new EmbeddingsClient(
    resolved.embeddingApiKey,
    resolved.embeddingModel,
    resolved.maxEmbeddingChars,
    resolved.embeddingBaseUrl,
    resolved.embeddingProvider,
  );

  // Middleware
  const autoRecall = new AutoRecall(store, embeddings, resolved);
  const autoCapture = new AutoCapture(store, embeddings, resolved);

  // Tool handler
  const toolHandler = new MemoryToolHandler(store, embeddings, resolved);

  // Public API
  return {
    // -- Store --
    async store(text, options) {
      const vector = await embeddings.embed(text);

      // Exact duplicate check
      const exactDup = await store.findByContentHash(text, options.userId);
      if (exactDup) return null;

      // Near-duplicate check
      const nearDup = await store.findDuplicate(vector, options.userId);
      if (nearDup) return null;

      // Detect category if not provided
      const category = options.category ?? detectCategory(text);

      return store.store(
        text,
        vector,
        options.userId,
        category,
        options.importance ?? 0.5,
        options.source,
        options.tags,
      );
    },

    // -- Search --
    async search(query, options) {
      const limit = options.limit ?? resolved.searchLimit;
      const minScore = options.minScore ?? resolved.searchMinScore;

      const queryVector = await embeddings.embed(query);

      // Fetch more for post-processing
      const fetchLimit = limit * 3;
      let results: MemorySearchResult[];

      if (query.trim().split(/\s+/).length >= 2) {
        results = await store.hybridSearch(
          query,
          queryVector,
          options.userId,
          fetchLimit,
          options.categories,
        );
      } else {
        results = await store.vectorSearch(
          queryVector,
          options.userId,
          fetchLimit,
          options.categories,
        );
      }

      // Post-processing pipeline
      const shouldDecay =
        options.temporalDecay ?? resolved.temporalDecay.enabled;
      if (shouldDecay) {
        results = applyTemporalDecay(results, {
          ...resolved.temporalDecay,
          enabled: true,
        });
      }

      const shouldMMR = options.mmr ?? resolved.mmr.enabled;
      if (shouldMMR) {
        results = applyMMR(results, { ...resolved.mmr, enabled: true });
      }

      return results.filter((r) => r.finalScore >= minScore).slice(0, limit);
    },

    // -- Delete --
    async delete(id, userId) {
      return store.delete(id, userId);
    },

    // -- Forget --
    async forget(query, userId) {
      const queryVector = await embeddings.embed(query);
      return store.deleteBySearch(queryVector, userId);
    },

    // -- Count --
    async count(userId) {
      return store.count(userId);
    },

    // -- Auto-Recall --
    async recall(userMessage, userId) {
      return autoRecall.recall(userMessage, userId);
    },

    // -- Auto-Capture --
    async capture(userMessage, userId, source?) {
      return autoCapture.capture(userMessage, userId, source);
    },

    // -- Tools --
    getToolDefinitions() {
      // enabled:false means OFF: no tools offered, so the model can neither
      // search nor write memories on a deployment that turned memory off.
      return resolved.enabled ? getToolDefinitions() : [];
    },

    async handleToolCall(toolName, args, userId) {
      return toolHandler.handle(toolName, args, userId);
    },

    // -- Initialize --
    async initialize() {
      await store.initialize();
    },
  };
}

// ============================================================================
// Re-exports
// ============================================================================

// Types
export type {
  MemoryLayer,
  MemoryEntry,
  MemorySearchResult,
  MemoryStoreProvider,
  ToolDefinition,
} from "./types.js";

export type {
  MemoryConfig,
  MemoryJsonConfig,
  MemoryCategory,
  TemporalDecayConfig,
  MMRConfig,
} from "./config.js";

// Config loaders
export {
  loadMemoryConfig,
  isMemoryEnabled,
  resolveContainerId,
  resolveEmbeddingApiKey,
  resolveEmbeddingModel,
  resolveEmbeddingBaseUrl,
  resetMemoryConfig,
  validateConfig,
} from "./config.js";

// Store providers
export { StorageMemoryStore, memoriesCollection } from "./providers/storage.js";
export { NoopMemoryStore } from "./providers/noop.js";
export {
  resolveStoreProvider,
  registerStoreProvider,
  getRegisteredProviders,
} from "./providers/index.js";
export type { StoreProviderFactory } from "./providers/index.js";

// Classes (for advanced usage / testing)
export { EmbeddingsClient } from "./embeddings.js";
export { AutoRecall } from "./auto-recall.js";
export { AutoCapture } from "./auto-capture.js";
export { MemoryToolHandler, getToolDefinitions } from "./tools.js";

// Utils
export {
  shouldCapture,
  detectCategory,
  looksLikePromptInjection,
  escapeForPrompt,
  formatMemoriesContext,
} from "./security.js";
export {
  applyTemporalDecay,
  applyDecay,
  calculateDecayMultiplier,
} from "./temporal-decay.js";
export { applyMMR } from "./mmr.js";
export { extractKeywords, expandQueryForFts } from "./query-expansion.js";

