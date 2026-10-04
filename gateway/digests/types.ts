/**
 * AgentForEach Digests Module — Types
 *
 * Short-lived session summaries for recency awareness.
 * Digests give the agent a "previously on…" recap of recent sessions
 * without polluting the long-term semantic memory store.
 *
 * Storage: Azure Cosmos DB with per-document TTL (auto-expire).
 * Partition key: /userId
 */

import type { Doc } from "@agentforeach/storage";

/**
 * A digest is a compact summary of a session, stored with a TTL
 * so it auto-expires after a configurable period (default 7 days).
 *
 * Digests are created:
 *   - After compaction (via the `after_compaction` hook)
 *   - Before session reset (via the `before_reset` hook)
 */
export interface DigestDocument extends Doc {
  /** Document ID. Format: `dg_{sessionId}`. */
  id: string;
  /** Owner user. Partition key. */
  userId: string;
  /** Session this digest summarizes. */
  sessionId: string;
  /** Agent the session belonged to. */
  agentId: string;
  /** LLM-generated session summary text. */
  summary: string;
  /** Extracted topic tags from the session. */
  topics: string[];
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** Cosmos DB TTL in seconds (auto-expire). */
  ttl: number;
}
