/**
 * AgentForEach Knowledge Layer — Auto-Recall Middleware
 *
 * Pre-request middleware: given a user message, retrieves relevant
 * knowledge chunks from Azure AI Search and formats them as an XML
 * block for injection into the system prompt.
 *
 * Mirrors the pattern of memory/auto-recall.ts but queries a search
 * index instead of a Cosmos DB vector container.
 *
 * Domain-agnostic — contextTags are optional hints from the user's
 * profile or memory, not hard-coded domain concepts.
 */

import type { KnowledgeConfig, KnowledgeChunk } from "./types.js";
import { KnowledgeSearchClient } from "./client.js";

// ============================================================================
// Auto-Recall
// ============================================================================

export class KnowledgeRecall {
  private client: KnowledgeSearchClient;
  private config: KnowledgeConfig;

  constructor(config: KnowledgeConfig) {
    this.client = new KnowledgeSearchClient(config);
    this.config = config;
  }

  /**
   * Recall relevant knowledge for a user message.
   *
   * Pipeline:
   * 1. Skip if message is too short or auto-recall is disabled
   * 2. Hybrid search in Azure AI Search (BM25 + vector + reranker)
   * 3. Filter by minimum score
   * 4. Format as `<relevant-knowledge>` XML context block
   *
   * @param userMessage - The user's current message.
   * @param contextTags - Optional hint tags from the user's profile
   *   (e.g., from IDENTITY prompt doc or memory). These are used as
   *   filter hints, not hard-coded domain logic.
   * @returns Formatted XML string, or empty string if nothing relevant.
   */
  async recall(
    userMessage: string,
    contextTags?: string[],
  ): Promise<string> {
    if (!this.config.autoRecall) return "";

    // Skip very short messages (unlikely to benefit from knowledge recall)
    if (userMessage.trim().length < 10) return "";

    try {
      const { chunks: results } = await this.client.search({
        query: userMessage,
        top: this.config.recallLimit,
      });

      // Filter by minimum score
      const relevant = results.filter((r) => r.score >= this.config.minScore);

      if (relevant.length === 0) return "";

      return formatKnowledgeContext(relevant);
    } catch (error) {
      // Non-fatal — proceed without knowledge context
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[knowledge] auto-recall failed: ${msg}`);
      return "";
    }
  }
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format knowledge chunks as an XML context block for system prompt injection.
 *
 * Format matches the existing `<relevant-memories>` pattern from memory/security.ts
 * so the LLM processes both context sources consistently.
 */
function formatKnowledgeContext(chunks: KnowledgeChunk[]): string {
  if (chunks.length === 0) return "";

  const items = chunks.map((chunk) => {
    const metaParts: string[] = [];
    if (chunk.source) metaParts.push(`source="${escapeXml(chunk.source)}"`);

    const metaStr = metaParts.length > 0 ? ` ${metaParts.join(" ")}` : "";
    const title = chunk.title ? `  <title>${escapeXml(chunk.title)}</title>\n` : "";

    return (
      `<knowledge-item${metaStr}>\n` +
      title +
      `  <content>${escapeXml(chunk.chunk.slice(0, 1500))}</content>\n` +
      `</knowledge-item>`
    );
  });

  return (
    `<relevant-knowledge count="${chunks.length}">\n` +
    items.join("\n") +
    "\n</relevant-knowledge>"
  );
}

/**
 * Escape special XML characters in content.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
