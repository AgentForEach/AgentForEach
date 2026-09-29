/**
 * AgentForEach Memory Layer — Function Tool Definitions & Handlers
 *
 * Defines `memory_search`, `memory_store`, and `memory_forget` as
 * function-type tools for the OpenAI Responses API.
 *
 * Ported from OpenClaw's memory tool definitions in:
 *   src/tools/definitions/memory-search.ts
 *   src/tools/definitions/memory-store.ts
 *   src/tools/definitions/memory-forget.ts
 *
 * These are registered with the Responses API as `type: "function"` tools.
 * When the model calls one, the orchestration service invokes `handleToolCall()`
 * and feeds the result back as function output.
 */

import { MEMORY_CATEGORIES, type MemoryConfig } from "./config.js";
import type {
  ToolDefinition,
  MemorySearchResult,
  MemoryStoreProvider,
} from "./types.js";
import { EmbeddingsClient } from "./embeddings.js";
import { applyTemporalDecay } from "./temporal-decay.js";
import { applyMMR } from "./mmr.js";
import { escapeForPrompt } from "./security.js";
import { DEFAULT_SEARCH_LIMIT } from "./config.js";

// ============================================================================
// Tool Definitions
// ============================================================================

export const MEMORY_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  name: "memory_search",
  description:
    "Search through stored memories to find relevant information about the user. " +
    "Use this when the user asks about something you might have previously learned, " +
    "or when you need to recall preferences, facts, or past decisions.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query. Be specific and descriptive for better results.",
      },
      q: {
        type: "string",
        description: "Alias for query.",
      },
      text: {
        type: "string",
        description: "Alias for query.",
      },
      message: {
        type: "string",
        description: "Alias for query.",
      },
      limit: {
        type: "number",
        description: `Maximum number of results to return (1-20). Default: ${DEFAULT_SEARCH_LIMIT}.`,
      },
      category: {
        type: "string",
        description:
          "Filter by category: " +
          "preference (user likes/dislikes), " +
          "fact (personal info, names, dates), " +
          "decision (choices the user made), " +
          "entity (people, places, projects), " +
          "other.",
        enum: [...MEMORY_CATEGORIES],
      },
      type: {
        type: "string",
        description: "Alias for category.",
        enum: [...MEMORY_CATEGORIES],
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const MEMORY_STORE_TOOL: ToolDefinition = {
  type: "function",
  name: "memory_store",
  description:
    "Store a new memory about the user. Use this when the user shares personal " +
    "information, preferences, decisions, or explicitly asks you to remember something. " +
    "The memory text should be a concise, factual statement.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The memory to store. Should be a clear, concise factual statement. " +
          "Example: 'User prefers dark mode in all applications'",
      },
      memory: {
        type: "string",
        description: "Alias for text.",
      },
      content: {
        type: "string",
        description: "Alias for text.",
      },
      message: {
        type: "string",
        description: "Alias for text.",
      },
      fact: {
        type: "string",
        description: "Alias for text.",
      },
      category: {
        type: "string",
        description:
          "What kind of memory: " +
          "preference (likes/dislikes/style choices), " +
          "fact (name, birthday, job, personal info), " +
          "decision (choices made, e.g. 'chose React over Vue'), " +
          "entity (people, places, projects mentioned), " +
          "other. Default: other.",
        enum: [...MEMORY_CATEGORIES],
      },
      type: {
        type: "string",
        description: "Alias for category.",
        enum: [...MEMORY_CATEGORIES],
      },
      importance: {
        type: "number",
        description:
          "0-1 score. Default: 0.7. " +
          "High (0.8-1.0): name, contacts, critical facts. " +
          "Low (0.3-0.5): casual mentions, minor preferences.",
      },
      score: {
        type: "number",
        description: "Alias for importance (0-1).",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

export const MEMORY_FORGET_TOOL: ToolDefinition = {
  type: "function",
  name: "memory_forget",
  description:
    "Delete stored memories matching a query or by specific id. Use this when the user asks you to " +
    "forget something, or when information is no longer relevant. " +
    "If you have the memory id from a previous search, pass it directly for precise deletion. " +
    "Otherwise, provide a query to find and delete similar memories.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Description of what to forget. Will search for similar memories to delete. " +
          "Required if id is not provided.",
      },
      id: {
        type: "string",
        description:
          "The specific memory id to delete (from a previous memory_search result). " +
          "If provided, deletes this exact memory without searching.",
      },
      memory_id: {
        type: "string",
        description: "Alias for id.",
      },
      memoryId: {
        type: "string",
        description: "Alias for id.",
      },
      text: {
        type: "string",
        description: "Alias for query.",
      },
      message: {
        type: "string",
        description: "Alias for query.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * Get all memory tool definitions for registration with the Responses API.
 */
export function getToolDefinitions(): ToolDefinition[] {
  return [MEMORY_SEARCH_TOOL, MEMORY_STORE_TOOL, MEMORY_FORGET_TOOL];
}

// ============================================================================
// Tool Call Handler
// ============================================================================

export class MemoryToolHandler {
  private store: MemoryStoreProvider;
  private embeddings: EmbeddingsClient;
  private config: MemoryConfig;

  constructor(
    store: MemoryStoreProvider,
    embeddings: EmbeddingsClient,
    config: MemoryConfig,
  ) {
    this.store = store;
    this.embeddings = embeddings;
    this.config = config;
  }

  private pickStringArg(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): string | undefined {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
    }
    return undefined;
  }

  private pickNumberArg(
    args: Record<string, unknown>,
    keys: readonly string[],
  ): number | undefined {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string") {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  }

  /**
   * Handle a function tool call from the model.
   *
   * @param toolName - One of: memory_search, memory_store, memory_forget
   * @param args - The parsed arguments from the model.
   * @param userId - The user id (injected by orchestration, not from model).
   * @returns String result to feed back as function output.
   */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    switch (toolName) {
      case "memory_search":
        return this.handleSearch(args, userId);
      case "memory_store":
        return this.handleStore(args, userId);
      case "memory_forget":
        return this.handleForget(args, userId);
      default:
        return `Unknown memory tool: ${toolName}`;
    }
  }

  // --------------------------------------------------------------------------
  // memory_search
  // --------------------------------------------------------------------------

  private async handleSearch(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const query = this.pickStringArg(args, ["query", "q", "text", "message"]);
    if (!query) return "Error: query is required.";

    const limitRaw = this.pickNumberArg(args, ["limit"]);
    const limit = Math.min(
      Math.max(1, limitRaw ?? this.config.searchLimit),
      20,
    );
    const categoryRaw = this.pickStringArg(args, ["category", "type"]);
    const categories =
      categoryRaw &&
      MEMORY_CATEGORIES.includes(
        categoryRaw as (typeof MEMORY_CATEGORIES)[number],
      )
        ? [categoryRaw]
        : undefined;

    // Embed query
    const queryVector = await this.embeddings.embed(query);

    // Hybrid search
    const fetchLimit = limit * 3; // over-fetch for post-processing
    let results: MemorySearchResult[];

    if (query.trim().split(/\s+/).length >= 2) {
      results = await this.store.hybridSearch(
        query,
        queryVector,
        userId,
        fetchLimit,
        categories,
      );
    } else {
      results = await this.store.vectorSearch(
        queryVector,
        userId,
        fetchLimit,
        categories,
      );
    }

    if (results.length === 0) {
      return "No matching memories found.";
    }

    // Post-process: temporal decay → MMR
    results = applyTemporalDecay(results, this.config.temporalDecay, this.config.evergreenImportanceThreshold);
    results = applyMMR(results, this.config.mmr);

    // Filter & limit
    results = results
      .filter((r) => r.finalScore >= this.config.searchMinScore)
      .slice(0, limit);

    if (results.length === 0) {
      return "No matching memories found above the relevance threshold.";
    }

    // Touch memories
    for (const r of results) {
      this.store.touchMemory(r.entry.id, r.entry.userId).catch(() => {});
    }

    // Format result
    const lines = results.map((r, i) => {
      const escaped = escapeForPrompt(r.entry.text);
      return `${i + 1}. [${r.entry.category}] ${escaped} (id: ${r.entry.id}, score: ${r.finalScore.toFixed(2)}, stored: ${r.entry.createdAt})`;
    });

    return `Found ${results.length} matching memories:\n${lines.join("\n")}`;
  }

  // --------------------------------------------------------------------------
  // memory_store
  // --------------------------------------------------------------------------

  private async handleStore(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const text = this.pickStringArg(args, [
      "text",
      "memory",
      "content",
      "message",
      "fact",
    ]);
    if (!text) return "Error: text is required.";
    if (text.length > 1000)
      return "Error: memory text is too long (max 1000 chars).";

    const categoryRaw =
      this.pickStringArg(args, ["category", "type"]) ?? "other";
    const category = MEMORY_CATEGORIES.includes(
      categoryRaw as (typeof MEMORY_CATEGORIES)[number],
    )
      ? categoryRaw
      : "other";
    const importanceRaw = this.pickNumberArg(args, ["importance", "score"]);
    const importance = Math.min(1, Math.max(0, importanceRaw ?? this.config.defaultImportance));

    // Exact duplicate check
    const exactDup = await this.store.findByContentHash(text, userId);
    if (exactDup) {
      return "This memory already exists (exact match).";
    }

    // Embed
    const vector = await this.embeddings.embed(text);

    // Near-duplicate check
    const nearDup = await this.store.findDuplicate(vector, userId);
    if (nearDup) {
      return `A very similar memory already exists: "${escapeForPrompt(nearDup.text)}"`;
    }

    // Store
    const entry = await this.store.store(
      text,
      vector,
      userId,
      category,
      importance,
    );

    return `Memory stored successfully (id: ${entry.id}, category: ${entry.category}).`;
  }

  // --------------------------------------------------------------------------
  // memory_forget
  // --------------------------------------------------------------------------

  private async handleForget(
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    const query = this.pickStringArg(args, ["query", "text", "message"]);
    const id = this.pickStringArg(args, ["id", "memory_id", "memoryId"]);

    // Direct deletion by id
    if (id) {
      const ok = await this.store.delete(id, userId);
      if (ok) return `Memory ${id} deleted successfully.`;
      return `Memory ${id} not found.`;
    }

    // Search-based deletion with confirmation flow
    if (!query) return "Error: either query or id is required.";

    const queryVector = await this.embeddings.embed(query);
    const results = await this.store.vectorSearch(queryVector, userId, 5);

    if (results.length === 0) {
      return "No matching memories found to forget.";
    }

    // If exactly one high-confidence match, auto-delete
    const highConfidence = results.filter((r) => r.score >= this.config.highConfidenceThreshold);
    if (highConfidence.length === 1) {
      const ok = await this.store.delete(highConfidence[0].entry.id, userId);
      if (ok) {
        return `Forgot memory: "${escapeForPrompt(highConfidence[0].entry.text)}"`;
      }
      return "Failed to delete the matching memory.";
    }

    // Multiple matches — return candidates for user confirmation
    const candidates = results.filter((r) => r.score >= this.config.candidateThreshold).slice(0, 5);

    if (candidates.length === 0) {
      return "No sufficiently similar memories found to forget.";
    }

    const lines = candidates.map((r, i) => {
      return `${i + 1}. [${r.entry.category}] "${escapeForPrompt(r.entry.text)}" (id: ${r.entry.id}, score: ${r.score.toFixed(2)})`;
    });

    return (
      `Found ${candidates.length} matching memories. Please confirm which to forget ` +
      `by calling memory_forget with the specific id:\n${lines.join("\n")}`
    );
  }
}
