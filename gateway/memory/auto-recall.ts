/**
 * AgentForEach Memory Layer — Auto-Recall Middleware
 *
 * Pre-request middleware: given a user message, retrieves relevant
 * memories from Cosmos DB and formats them as an XML block for
 * injection into the system prompt.
 *
 * Pipeline:
 *   user message → embed → hybrid search → temporal decay → MMR → format
 */

import type { MemoryConfig } from "./config.js";
import type { MemorySearchResult, MemoryStoreProvider } from "./types.js";
import { EmbeddingsClient } from "./embeddings.js";
import { applyTemporalDecay } from "./temporal-decay.js";
import { applyMMR } from "./mmr.js";
import { formatMemoriesContext } from "./security.js";

// ============================================================================
// Auto-Recall
// ============================================================================

export class AutoRecall {
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

  /**
   * Recall relevant memories for a user message.
   *
   * Pipeline:
   * 1. Embed the user message
   * 2. Hybrid search (vector + BM25) in Cosmos DB
   * 3. Apply temporal decay (if enabled)
   * 4. Apply MMR re-ranking (if enabled)
   * 5. Filter by minimum score
   * 6. Format as XML context block
   *
   * @param userMessage - The user's current message.
   * @param userId - The user's id (partition key).
   * @returns Formatted `<relevant-memories>` XML string, or empty string.
   */
  async recall(userMessage: string, userId: string): Promise<string> {
    if (!this.config.autoRecall) return "";

    // Skip very short messages
    if (userMessage.trim().length < 5) return "";

    // 1. Embed
    const queryVector = await this.embeddings.embed(userMessage);

    // 2. Hybrid search — fetch more than needed for post-processing
    const fetchLimit = this.config.recallLimit * 3;
    let results: MemorySearchResult[];

    // Use hybrid search if query has enough text for BM25
    if (userMessage.trim().split(/\s+/).length >= 2) {
      results = await this.store.hybridSearch(
        userMessage,
        queryVector,
        userId,
        fetchLimit,
      );
    } else {
      results = await this.store.vectorSearch(queryVector, userId, fetchLimit);
    }

    if (results.length === 0) return "";

    // 3. Temporal decay
    results = applyTemporalDecay(results, this.config.temporalDecay);

    // 4. MMR re-ranking
    results = applyMMR(results, this.config.mmr);

    // 5. Filter by minimum score and limit
    results = results
      .filter((r) => r.finalScore >= this.config.recallMinScore)
      .slice(0, this.config.recallLimit);

    if (results.length === 0) return "";

    // Touch retrieved memories (update access count, non-blocking)
    for (const r of results) {
      this.store.touchMemory(r.entry.id, r.entry.userId).catch(() => {});
    }

    // 6. Format
    return formatMemoriesContext(results);
  }
}
