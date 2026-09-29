/**
 * AgentForEach Sessions Module — Types
 *
 * Core type definitions for conversation session management.
 *
 * Two containers:
 *   "sessions"             — session metadata, partition key: /userId
 *   "session-messages-v2"  — individual messages, partition key: /pk
 *                            (`{userId}:{sessionId}:{instanceId}`)
 *
 * Messages are only reachable through their owner's session: the partition
 * key includes the owner and the session's instanceId, so two users with the
 * same sessionId, or a session recreated after TTL or /new, never share
 * messages.
 *
 * Messages are stored as individual documents (one per message) in the
 * messages container rather than embedded in the session document.
 * This avoids Cosmos DB's 2MB document limit and enables per-message queries.
 *
 * When messages exceed a configurable threshold, older messages are
 * summarized by the LLM (compaction) and the summary is stored on the
 * session document. Compacted messages are then deleted.
 */

import type { ProviderId, UsageStats } from "../llms/index.js";

// ============================================================================
// Session Document
// ============================================================================

/**
 * A conversation session stored in Cosmos DB.
 *
 * The session document holds metadata and compaction state.
 * Messages are stored separately in the messages container.
 *
 * Container: "sessions"
 * Partition key: /userId
 * Document ID: `{userId}:{sessionId}`
 */
export interface Session {
  /** Document ID: `{userId}:{sessionId}`. */
  id: string;

  /** Owner user. Partition key. */
  userId: string;

  /** Agent this session belongs to. */
  agentId: string;

  /** Index signature required by Cosmos DB BaseDocument. */
  [key: string]: unknown;

  /** Human-readable session identifier. */
  sessionId: string;

  /**
   * Random id minted when this session document is created. Part of the
   * message partition key, so a recreated session (same sessionId after TTL
   * expiry or /new) starts with an empty history and no id collisions.
   * Missing on sessions created before messages were partitioned this way.
   */
  instanceId?: string;

  /**
   * Next sequence number for messages. Incremented atomically on append.
   * Also serves as the total message count for the session.
   */
  messageSeq: number;

  /** ISO-8601 timestamp of creation. */
  createdAt: string;

  /** ISO-8601 timestamp of last activity. */
  updatedAt: string;

  /** Cosmos DB TTL in seconds (auto-expire inactive sessions). */
  ttl?: number;

  /** Denormalized preview of the last message (for efficient listing). */
  lastMessagePreview?: string;

  /**
   * The execution currently answering in this session, if any. Lets exactly
   * one turn run per session at a time (see SessionStore.acquireRunLease).
   */
  activeRun?: { leaseId: string; runId: string; expiresAtMs: number };

  /** Provider-specific conversation state for multi-turn linking. */

  conversationState?: {
    /** OpenAI: previous_response_id for chained responses. */
    previousResponseId?: string;
    /** OpenAI: reusable container ID for shell tool. */
    containerId?: string;
  };

  /** Session metadata. */
  metadata?: Record<string, string>;

  // -- Compaction --

  /** LLM-generated summary of compacted (older) messages. */
  compactionSummary?: string;

  /** Seq number up to which messages have been compacted (exclusive). */
  lastCompactedSeq?: number;

  /** ISO-8601 timestamp of last compaction. */
  lastCompactedAt?: string;
}

// ============================================================================
// Session Message (logical type — used as input by the runner)
// ============================================================================

/**
 * A single message in the session history.
 *
 * This is the logical/input type used by the runner when appending messages.
 * For the stored Cosmos document shape, see `MessageDocument`.
 */
export interface SessionMessage {
  /** Message role. */
  role: "user" | "assistant";

  /** Message text content. */
  content: string;

  /** ISO-8601 timestamp. */
  timestamp: string;

  /** Optional caller-supplied idempotency key (stored on user messages). */
  idempotencyKey?: string;

  /** Model that generated an assistant message. */
  model?: string;

  /** Provider that generated an assistant message. */
  providerId?: ProviderId;

  /** Token usage for assistant messages. */
  usage?: UsageStats;

  /** Run ID that generated this assistant message. */
  runId?: string;

  /** Channel the message originated from (e.g., "telegram"). */
  channelName?: string;

}

// ============================================================================
// Message Document (stored in messages container)
// ============================================================================

/**
 * A single message stored as its own document in the messages container.
 *
 * Container: "session-messages-v2"
 * Partition key: /pk = `{userId}:{sessionId}:{instanceId}`
 * Document ID: `{instanceId}:{seqPadded}` (e.g., "k3x9…:000042")
 */
export interface MessageDocument {
  /** Document ID: `{instanceId}:{seqPadded}`. */
  id: string;

  /** Partition key: `{userId}:{sessionId}:{instanceId}` (see messagePartitionKey). */
  pk: string;

  /** Session this message belongs to. */
  sessionId: string;

  /** Owner user (denormalized; isolation comes from `pk`). */
  userId: string;

  /** Monotonic sequence number within the session (0-based). */
  seq: number;

  /** Message role. */
  role: "user" | "assistant";

  /** Message text content. */
  content: string;

  /** ISO-8601 timestamp. */
  timestamp: string;

  /** Index signature for Cosmos BaseDocument compatibility. */
  [key: string]: unknown;

  // -- Assistant-specific --

  /** Model that generated an assistant message. */
  model?: string;

  /** Provider that generated an assistant message. */
  providerId?: ProviderId;

  /** Token usage for assistant messages. */
  usage?: UsageStats;

  /** Run ID that generated this assistant message. */
  runId?: string;

  // -- User-specific --

  /** Idempotency key for duplicate suppression. */
  idempotencyKey?: string;

  /** Channel the message originated from (e.g., "telegram"). */
  channelName?: string;

  /** Per-document TTL in seconds (sessions.messageTtlSeconds). */
  ttl?: number;
}

// ============================================================================
// Session Summary
// ============================================================================

/**
 * Lightweight session summary for listing.
 * `messageCount` comes from `session.messageSeq`.
 */
export interface SessionSummary {
  sessionId: string;
  agentId: string;
  messageCount: number;
  lastMessage: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Session Config (agentforeach.json "session" section shape)
// ============================================================================

/**
 * Configuration shape as stored in agentforeach.json "session" section.
 *
 * Database connection is NOT duplicated here — it comes from the
 * agentforeach.json "database" section (resolved via `loadDatabaseConfig()`)
 * and the shared `DatabaseProvider` instance.
 */
export interface SessionJsonConfig {
  /** Cosmos DB container name for sessions. Default: "sessions". */
  containerId?: string;

  /** Default session inactivity TTL in seconds. Default: 86400 (24h). */
  ttlSeconds?: number;

  /** Max recent messages to load for LLM history. Default: 100. */
  maxHistoryMessages?: number;

  /** Default agent ID for sessions without an explicit agent. Default: "default". */
  defaultAgentId?: string;

  /** Cosmos DB container name for messages. Default: "session-messages-v2". */
  messagesContainerId?: string;

  /**
   * How long a message document lives, in seconds. Garbage collection for
   * sessions that ended: a recreated session gets a new instanceId, so old
   * messages are never read again. Active sessions compact by age at half
   * this value, before anything expires. Default: 604800 (7 days); 0 = never.
   */
  messageTtlSeconds?: number;

  /** Number of messages before triggering compaction. Default: 60. */
  compactionThreshold?: number;

  /** Number of recent messages to retain after compaction. Default: 20. */
  compactionRetainCount?: number;

  /** Model to use for compaction summaries (defaults to provider's default). */
  compactionModel?: string;

  /** Temperature for compaction LLM calls. Default: 0.3. */
  compactionTemperature?: number;

  /** Max output tokens for compaction summaries. Default: 4000. */
  compactionMaxOutputTokens?: number;

  /** Max preview length for session listing. Default: 120. */
  maxPreviewLength?: number;
}
