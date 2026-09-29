/**
 * AgentForEach Knowledge Layer — Tool Definitions & Handler
 *
 * Defines `knowledge_search` as a function-type tool for the LLM.
 * Completely domain-agnostic — the tool description and parameters
 * make no assumptions about what kind of documents are in the index.
 *
 * Follows the same pattern as web/tools.ts and memory/tools.ts.
 */

import type { ToolDefinition } from "../memory/types.js";
import type { KnowledgeConfig, KnowledgeChunk, KnowledgeFacet } from "./types.js";
import { KnowledgeSearchClient } from "./client.js";
import { wrapExternalContent } from "../utils/external-content.js";

// ============================================================================
// Tool Names
// ============================================================================

export const KNOWLEDGE_SEARCH_TOOL_NAME = "knowledge_search";

// ============================================================================
// Tool Definitions
// ============================================================================

export const KNOWLEDGE_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  name: KNOWLEDGE_SEARCH_TOOL_NAME,
  description:
    "Search the knowledge base for relevant documents and information. " +
    "The knowledge base contains reference materials, guides, manuals, and " +
    "other documents uploaded by the user or administrator. Use this when " +
    "the user asks about topics that may be covered by these reference materials, " +
    "or when you need to look up specific information from uploaded documents.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query. Be specific and descriptive for better results. " +
          "Include key terms, names, or identifiers that might appear in the documents.",
      },
      q: {
        type: "string",
        description: "Alias for query.",
      },
      title: {
        type: "string",
        description:
          "Optional: filter results to a specific document by title. " +
          "Uses fuzzy matching — partial terms work (e.g., 'income tax' " +
          "matches 'Income Tax Act Sample'). Check the 'Available documents' " +
          "footer in previous results to see valid document titles.",
      },
      source: {
        type: "string",
        description:
          "Optional: filter results to a specific source document " +
          "(e.g., a filename or document identifier).",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (1-10). Default: 5.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/**
 * Get all knowledge tool definitions for registration with the LLM.
 */
export function getKnowledgeToolDefinitions(): ToolDefinition[] {
  return [KNOWLEDGE_SEARCH_TOOL];
}

/**
 * Check if a tool name is a knowledge tool.
 */
export function isKnowledgeTool(toolName: string): boolean {
  return toolName === KNOWLEDGE_SEARCH_TOOL_NAME;
}

// ============================================================================
// Tool Handler
// ============================================================================

/**
 * Handles `knowledge_search` tool calls from the LLM.
 *
 * Parses the arguments (with alias resolution), executes the search
 * against Azure AI Search, and formats results for the LLM.
 */
export class KnowledgeToolHandler {
  private client: KnowledgeSearchClient;
  private config: KnowledgeConfig;

  constructor(config: KnowledgeConfig) {
    this.client = new KnowledgeSearchClient(config);
    this.config = config;
  }

  /**
   * Handle a knowledge tool call.
   *
   * @param name - The tool name (must be "knowledge_search").
   * @param args - The parsed arguments from the LLM.
   * @returns Formatted search results as a string.
   */
  async handle(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (name !== KNOWLEDGE_SEARCH_TOOL_NAME) {
      return `Unknown knowledge tool: ${name}`;
    }

    // Resolve query from aliases
    const query =
      (typeof args.query === "string" && args.query) ||
      (typeof args.q === "string" && args.q) ||
      "";

    if (!query.trim()) {
      return "Error: query is required for knowledge_search.";
    }

    const limit = typeof args.limit === "number"
      ? Math.min(Math.max(1, Math.floor(args.limit)), 10)
      : this.config.searchLimit;

    try {
      const titleFilter =
        typeof args.title === "string" && args.title.trim()
          ? args.title.trim()
          : undefined;

      const { chunks: results, titleFacets } = await this.client.search({
        query,
        title: titleFilter,
        sources: typeof args.source === "string" ? [args.source] : undefined,
        top: limit,
      });

      // Filter by minimum score
      const filtered = results.filter((r) => r.score >= this.config.minScore);

      if (filtered.length === 0) {
        // Even with no results, show available documents if facets exist
        const footer = formatFacetFooter(titleFacets);
        return "No relevant results found in the knowledge base." + footer;
      }

      return formatSearchResults(filtered, titleFacets);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[knowledge] search error: ${msg}`);
      return `Error searching knowledge base: ${msg}`;
    }
  }
}

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Format search results for return to the LLM.
 * Each result shows the source, title, score, and content.
 * Appends an "Available documents" footer from facets.
 */
function formatSearchResults(
  results: KnowledgeChunk[],
  titleFacets?: KnowledgeFacet[],
): string {
  const parts = results.map((r, i) => {
    const lines: string[] = [];
    lines.push(`[${i + 1}] ${r.title || "Untitled"}`);

    const meta: string[] = [];
    if (r.source) meta.push(`source: ${r.source}`);
    if (meta.length > 0) {
      lines.push(`  (${meta.join(" | ")})`);
    }

    // Use highlight if available, otherwise raw chunk
    const text = r.highlights?.length
      ? r.highlights.join(" … ")
      : r.chunk;

    // Wrap external content in security boundary
    lines.push(wrapExternalContent(text.slice(0, 2000), r.source || "knowledge-base"));

    return lines.join("\n");
  });

  return parts.join("\n\n") + formatFacetFooter(titleFacets);
}

/**
 * Format a footer showing available document titles from facet results.
 * Helps the LLM discover which documents can be filtered by title.
 */
function formatFacetFooter(titleFacets?: KnowledgeFacet[]): string {
  if (!titleFacets?.length) return "";

  const docList = titleFacets
    .map((f) => `  • ${f.value} (${f.count} chunk${f.count === 1 ? "" : "s"})`)
    .join("\n");

  return (
    "\n\n---\nAvailable documents in knowledge base:\n" +
    docList +
    "\n(Use the 'title' parameter to filter by document.)"
  );
}
