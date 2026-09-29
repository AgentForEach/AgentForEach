/**
 * AgentForEach Knowledge Layer — Type Definitions
 *
 * Domain-agnostic types for the hybrid search knowledge base backed by
 * Azure AI Search.  The knowledge module knows nothing about compliance,
 * medicine, or any specific domain — it stores **chunks of text with
 * metadata tags** and retrieves them via hybrid search (BM25 + vector +
 * semantic reranker).
 *
 * Domain specificity lives in SKILL.md files, prompt documents, and the
 * blob metadata attached to uploaded source documents.
 */

import type { ToolDefinition } from "../memory/types.js";

// ============================================================================
// agentforeach.json "knowledge" Section Shape
// ============================================================================

/**
 * Configuration shape as stored in agentforeach.json "knowledge" section.
 */
export interface KnowledgeJsonConfig {
  /** Enable/disable the knowledge base module. Default: false. */
  enabled?: boolean;

  /** Azure AI Search endpoint URL (env-resolved, e.g. "$SEARCH_ENDPOINT"). */
  endpoint?: string;

  /** Azure AI Search admin/query API key (env-resolved, e.g. "$SEARCH_API_KEY"). */
  apiKey?: string;

  /** Name of the search index. Default: "knowledge-base". */
  indexName?: string;

  /**
   * Automatically inject relevant knowledge chunks into the system prompt
   * before the user's message (similar to memory auto-recall).
   * Default: true.
   */
  autoRecall?: boolean;

  /** Max chunks to inject via auto-recall. Default: 3. */
  recallLimit?: number;

  /** Max chunks to return from an explicit knowledge_search tool call. Default: 5. */
  searchLimit?: number;

  /** Minimum relevance score (0–1) to include a chunk. Default: 0.02. */
  minScore?: number;

  /** Semantic configuration name on the AI Search index. Default: "default". */
  semanticConfig?: string;

  /**
   * Default query type for searches. "semantic" uses the L2 semantic
   * reranker (requires Basic tier or above); "simple" performs hybrid
   * BM25 + vector search (works on all tiers, including Free).
   * Default: "semantic".
   */
  queryType?: "simple" | "semantic";

  /** API version for the Azure AI Search REST API. Default: "2024-07-01". */
  apiVersion?: string;
}

// ============================================================================
// Resolved Config
// ============================================================================

/**
 * Fully-resolved knowledge config ready for use at runtime.
 */
export interface KnowledgeConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  indexName: string;
  autoRecall: boolean;
  recallLimit: number;
  searchLimit: number;
  minScore: number;
  semanticConfig: string;
  queryType: "simple" | "semantic";
  apiVersion: string;
}

// ============================================================================
// Search Types
// ============================================================================

/**
 * A single chunk of knowledge retrieved from the search index.
 * All metadata fields are generic (no domain-specific semantics).
 */
export interface KnowledgeChunk {
  /** Unique identifier for this chunk within the index. */
  chunkId: string;

  /** Identifier of the parent/source document (e.g., base64-encoded blob path). */
  parentId: string;

  /** The text content of this chunk. */
  chunk: string;

  /** Title of the parent document (blob file name). */
  title: string;

  /** Source document path (blob storage path). */
  source: string;

  /** Relevance score from the search engine (higher is better). */
  score: number;

  /** Highlighted text snippets from the search engine. */
  highlights?: string[];

  /** Extractive captions from the semantic ranker (L2 reranking). */
  captions?: string[];
}

/**
 * Options for a knowledge search query.
 * All filter fields are optional and domain-agnostic.
 */
export interface KnowledgeSearchOptions {
  /** The search query text. */
  query: string;

  /**
   * Filter by document title (fuzzy full-text match).
   * Uses `search.ismatch` in the OData filter for natural language matching —
   * e.g., "income tax" matches "Income Tax Act Sample".
   */
  title?: string;

  /** Filter by source document path(s). */
  sources?: string[];

  /** Filter by parent document ID. */
  parentId?: string;

  /** Maximum number of results to return. */
  top?: number;

  /**
   * Query type:
   *   - "simple"   — BM25 only
   *   - "semantic" — hybrid (BM25 + vector) with semantic reranker
   * Default: "semantic".
   */
  queryType?: "simple" | "semantic";
}

// ============================================================================
// Search Result Types
// ============================================================================

/**
 * A single facet bucket (value + count) returned by Azure AI Search.
 */
export interface KnowledgeFacet {
  value: string;
  count: number;
}

/**
 * Full search result from the client, including chunks and optional facets.
 * Facets are always requested but only used by the tool handler to show
 * available documents in the results footer.
 */
export interface KnowledgeSearchResult {
  /** Matched knowledge chunks. */
  chunks: KnowledgeChunk[];

  /** Facet buckets for document titles (distinct values with chunk counts). */
  titleFacets?: KnowledgeFacet[];
}

// ============================================================================
// Knowledge Layer Interface
// ============================================================================

/**
 * Public API surface for the knowledge module.
 *
 * Follows the same shape as `MemoryLayer` — factory-created, with
 * search, recall, tool definitions, and tool dispatch.
 */
export interface KnowledgeLayer {
  /** Search the knowledge base explicitly. */
  search(options: KnowledgeSearchOptions): Promise<KnowledgeChunk[]>;

  /**
   * Auto-recall: retrieve relevant knowledge for a user message
   * and format it as an XML context block for prompt injection.
   *
   * @param userMessage - The user's current message.
   * @param contextTags - Optional hint tags from the user's profile/memory.
   * @returns Formatted `<relevant-knowledge>` XML string, or empty string.
   */
  recall(userMessage: string, contextTags?: string[]): Promise<string>;

  /** Get the tool definitions to register with the LLM. */
  getToolDefinitions(): ToolDefinition[];

  /** Dispatch a tool call from the LLM. */
  handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string>;
}
