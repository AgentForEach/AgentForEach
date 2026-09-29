/**
 * AgentForEach Knowledge Layer — Public API
 *
 * Barrel export for the knowledge base subsystem.
 *
 * Provides a domain-agnostic hybrid search layer backed by Azure AI Search.
 * Documents are uploaded to Blob Storage and automatically indexed
 * (cracked, chunked, embedded) by an AI Search indexer.
 *
 * The knowledge module follows the same factory pattern as memory/:
 *
 * ```ts
 * import {
 *   createKnowledgeLayer,
 *   loadKnowledgeConfig,
 *   isKnowledgeEnabled,
 *   getKnowledgeToolDefinitions,
 *   isKnowledgeTool,
 * } from "./knowledge/index.js";
 *
 * const config = loadKnowledgeConfig();
 * if (config.enabled) {
 *   const knowledge = createKnowledgeLayer(config);
 *   const tools = knowledge.getToolDefinitions();
 *   const recalled = await knowledge.recall("user question", ["tag1"]);
 *   const results = await knowledge.search({ query: "..." });
 * }
 * ```
 */

import type {
  KnowledgeConfig,
  KnowledgeLayer,
  KnowledgeChunk,
  KnowledgeSearchOptions,
} from "./types.js";
import { KnowledgeSearchClient } from "./client.js";
import { KnowledgeRecall } from "./auto-recall.js";
import {
  KnowledgeToolHandler,
  getKnowledgeToolDefinitions,
} from "./tools.js";

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a fully-wired knowledge layer instance.
 *
 * No `initialize()` needed (unlike memory/sessions) — the Azure AI Search
 * index and indexer are provisioned by the infra layer (Pulumi).
 *
 * @param config - Resolved KnowledgeConfig (from loadKnowledgeConfig()).
 * @returns A KnowledgeLayer implementation.
 */
export function createKnowledgeLayer(config: KnowledgeConfig): KnowledgeLayer {
  const client = new KnowledgeSearchClient(config);
  const recall = new KnowledgeRecall(config);
  const toolHandler = new KnowledgeToolHandler(config);

  return {
    // -- Search --
    async search(options: KnowledgeSearchOptions): Promise<KnowledgeChunk[]> {
      const top = options.top ?? config.searchLimit;
      const { chunks: results } = await client.search({ ...options, top });
      return results.filter((r) => r.score >= config.minScore);
    },

    // -- Auto-Recall --
    async recall(userMessage: string, contextTags?: string[]): Promise<string> {
      return recall.recall(userMessage, contextTags);
    },

    // -- Tools --
    getToolDefinitions() {
      return getKnowledgeToolDefinitions();
    },

    async handleToolCall(
      name: string,
      args: Record<string, unknown>,
    ): Promise<string> {
      return toolHandler.handle(name, args);
    },
  };
}

// ============================================================================
// Re-exports
// ============================================================================

// Types
export type {
  KnowledgeLayer,
  KnowledgeChunk,
  KnowledgeSearchOptions,
  KnowledgeConfig,
  KnowledgeJsonConfig,
} from "./types.js";

// Config
export {
  loadKnowledgeConfig,
  isKnowledgeEnabled,
  resetKnowledgeConfig,
} from "./config.js";

// Client
export { KnowledgeSearchClient } from "./client.js";

// Auto-recall
export { KnowledgeRecall } from "./auto-recall.js";

// Tools
export {
  KnowledgeToolHandler,
  getKnowledgeToolDefinitions,
  isKnowledgeTool,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_SEARCH_TOOL_NAME,
} from "./tools.js";
