/**
 * AgentForEach Memory Layer — Auto-Capture Middleware
 *
 * Post-response middleware: given a user message, determines whether
 * it contains memory-worthy information and stores it if appropriate.
 *
 * Pipeline:
 *   user message → shouldCapture() → detectCategory() → embed
 *   → dedup check → store to Cosmos DB
 *
 * Rate-limited per conversation via `config.captureMaxPerConversation`,
 * counted over the last 24 hours: a Telegram or WhatsApp chat keeps one
 * session id for good, so a lifetime count would stop capturing forever.
 * In serverless mode, when `source` is provided, counting is done from Cosmos
 * so limits are enforced across multiple function instances.
 */

import type { MemoryConfig } from "./config.js";
import type { MemoryEntry, MemoryStoreProvider } from "./types.js";
import { EmbeddingsClient } from "./embeddings.js";
import { shouldCapture, detectCategory } from "./security.js";

// ============================================================================
// Auto-Capture
// ============================================================================

/** Window the per-conversation capture limit is counted over. */
const CAPTURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export class AutoCapture {
  private store: MemoryStoreProvider;
  private embeddings: EmbeddingsClient;
  private config: MemoryConfig;

  /** Local fallback counter when no source/session id is available. */
  private captureCounts = new Map<string, number>();

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
   * Attempt to capture a user message as a memory.
   *
   * Pipeline:
   * 1. Check if auto-capture is enabled
   * 2. Check per-conversation rate limit
   * 3. Run shouldCapture() heuristics
   * 4. Detect category
   * 5. Check for exact hash duplicate
   * 6. Embed the text
   * 7. Check for near-duplicate (vector similarity)
   * 8. Store to Cosmos DB
   *
   * @param userMessage - The user's message text.
   * @param userId - The user's id (partition key).
   * @param source - Optional source identifier (e.g., conversationId).
   * @returns The captured MemoryEntry, or null if skipped.
   */
  async capture(
    userMessage: string,
    userId: string,
    source?: string,
  ): Promise<MemoryEntry | null> {
    // 1. Enabled?
    if (!this.config.autoCapture) return null;

    // 2. Rate limit
    const normalizedSource = source?.trim();
    const sessionKey = normalizedSource || "default";
    const fallbackKey = `${userId}:${sessionKey}`;
    const currentCount = normalizedSource
      ? await this.store.countBySource(userId, sessionKey, new Date(Date.now() - CAPTURE_WINDOW_MS).toISOString())
      : (this.captureCounts.get(fallbackKey) ?? 0);
    if (currentCount >= this.config.captureMaxPerConversation) return null;

    // 3. Capture eligibility
    const maxChars = this.config.captureMaxChars;
    if (!shouldCapture(userMessage, maxChars)) return null;

    // 4. Category
    const category = detectCategory(userMessage);

    // 5. Exact duplicate check (content hash)
    const exactDup = await this.store.findByContentHash(userMessage, userId);
    if (exactDup) return null;

    // 6. Embed
    const vector = await this.embeddings.embed(userMessage);

    // 7. Near-duplicate check (vector similarity)
    const nearDup = await this.store.findDuplicate(vector, userId);
    if (nearDup) return null;

    // 8. Store
    const entry = await this.store.store(
      userMessage,
      vector,
      userId,
      category,
      this.config.defaultImportance,
      normalizedSource,
    );

    // Increment local fallback counter only when no source/session id is provided.
    if (!normalizedSource) {
      this.captureCounts.set(fallbackKey, currentCount + 1);
    }

    return entry;
  }

  /**
   * Reset capture counters. Call when starting a new conversation.
   */
  resetCounters(sessionKey?: string): void {
    if (!sessionKey) {
      this.captureCounts.clear();
      return;
    }

    const suffix = `:${sessionKey}`;
    for (const key of this.captureCounts.keys()) {
      if (key.endsWith(suffix)) {
        this.captureCounts.delete(key);
      }
    }
  }

  /**
   * Get current capture count for a session.
   */
  getCaptureCount(sessionKey = "default"): number {
    const suffix = `:${sessionKey}`;
    let total = 0;
    for (const [key, value] of this.captureCounts.entries()) {
      if (key.endsWith(suffix)) {
        total += value;
      }
    }
    return total;
  }
}
