/**
 * AgentForEach Digests Module — Tool Definitions & Handler
 *
 * Exposes a `session_search` tool that lets the LLM search across
 * past conversation sessions. Combines two search strategies:
 *   1. Keyword search on digest summaries (short-lived, 7-day TTL)
 *   2. Vector search on compaction memories (long-lived, in memory store)
 *
 * Results are merged, deduplicated by sessionId, and returned
 * in reverse chronological order.
 */

import type { MemoryLayer, ToolDefinition } from "../memory/types.js";
import { escapeForPrompt } from "../memory/security.js";
import type { DigestStore } from "./store.js";
import type { DigestConfig } from "./config.js";

// ============================================================================
// Tool Name
// ============================================================================

export const SESSION_SEARCH_TOOL_NAME = "session_search";

// ============================================================================
// Tool Definition
// ============================================================================

export const SESSION_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  name: SESSION_SEARCH_TOOL_NAME,
  description:
    "Search across past conversation sessions to find what was discussed " +
    "in previous conversations. Use when the user asks about something from " +
    "a prior session, references past work, or wants to find a past discussion. " +
    "This searches session summaries and digests, not individual messages.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to search for across past sessions. Be descriptive about the topic.",
      },
      maxAgeDays: {
        type: "number",
        description:
          "Maximum age of sessions to search in days. Default: 7.",
      },
      limit: {
        type: "number",
        description:
          "Maximum number of results to return (1-10). Default: 5.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

// ============================================================================
// Guards
// ============================================================================

export function isDigestTool(toolName: string): boolean {
  return toolName === SESSION_SEARCH_TOOL_NAME;
}

export function getDigestToolDefinitions(): ToolDefinition[] {
  return [SESSION_SEARCH_TOOL];
}

// ============================================================================
// Handler
// ============================================================================

export class DigestToolHandler {
  private digestStore: DigestStore;
  private memoryLayer: MemoryLayer;
  private config: DigestConfig;

  constructor(
    digestStore: DigestStore,
    memoryLayer: MemoryLayer,
    config: DigestConfig,
  ) {
    this.digestStore = digestStore;
    this.memoryLayer = memoryLayer;
    this.config = config;
  }

  async handle(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
  ): Promise<string> {
    if (toolName !== SESSION_SEARCH_TOOL_NAME) {
      return JSON.stringify({ error: `Unknown digest tool: ${toolName}` });
    }

    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }

    const maxAgeDays =
      typeof args.maxAgeDays === "number"
        ? Math.max(1, Math.min(90, args.maxAgeDays))
        : 7;
    const limit =
      typeof args.limit === "number"
        ? Math.max(1, Math.min(10, args.limit))
        : 5;

    try {
      // Strategy 1: Search digests by keyword
      const digestResults = await this.digestStore.searchByKeyword(
        userId,
        query,
        limit,
        maxAgeDays,
      );

      // Strategy 2: Search memory entries with source prefix "compaction:"
      const memoryResults = await this.memoryLayer.search(query, {
        userId,
        limit,
      });
      const compactionMemories = memoryResults.filter(
        (r) => r.entry.source?.startsWith("compaction:"),
      );

      // Merge and deduplicate (by sessionId)
      const seen = new Set<string>();
      const results: Array<{
        sessionId: string;
        summary: string;
        date: string;
        source: "digest" | "memory";
        topics?: string[];
      }> = [];

      for (const digest of digestResults) {
        if (seen.has(digest.sessionId)) continue;
        seen.add(digest.sessionId);
        results.push({
          sessionId: digest.sessionId,
          summary: digest.summary,
          date: digest.createdAt.split("T")[0],
          source: "digest",
          topics: digest.topics,
        });
      }

      for (const mem of compactionMemories) {
        const sessionId = mem.entry.source?.replace("compaction:", "") ?? "";
        if (!sessionId || seen.has(sessionId)) continue;
        seen.add(sessionId);
        results.push({
          sessionId,
          summary: mem.entry.text,
          date: mem.entry.createdAt.split("T")[0],
          source: "memory",
        });
      }

      if (results.length === 0) {
        return "No matching past sessions found.";
      }

      // Sort by date descending
      results.sort((a, b) => b.date.localeCompare(a.date));

      const lines = results.slice(0, limit).map((r, i) => {
        const topicsStr = r.topics?.length
          ? ` [${r.topics.join(", ")}]`
          : "";
        return `${i + 1}. (${r.date})${topicsStr}: ${escapeForPrompt(r.summary)}`;
      });

      return `Found ${results.length} matching past session(s):\n${lines.join("\n")}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Session search failed: ${message}` });
    }
  }
}
