/**
 * AgentForEach Episode Layer — Types
 *
 * Data model for episodic memory — theme-based life arcs that span
 * multiple sessions and accumulate highlights over time.
 *
 * Episodes bridge the gap between:
 *   - Working memory (context window, 100 messages) — volatile
 *   - Long-term semantic memory (memory entries) — atomic facts
 *
 * Unlike session summaries, episodes represent ongoing life themes
 * ("Wedding Planning", "Job Search", "Kitchen Renovation") that
 * persist across sessions and are managed by the LLM via tools.
 */

import type { Doc } from "@agentforeach/storage";

// ============================================================================
// Episode Highlight (individual contribution from a session)
// ============================================================================

/**
 * A single highlight — a key moment contributed by one session.
 *
 * Highlights form a chronological timeline within an episode.
 * Each session can contribute at most one highlight per episode.
 */
export interface EpisodeHighlight {
  /** ISO-8601 timestamp when this highlight was added. */
  date: string;
  /** Session that contributed this highlight. */
  sessionId: string;
  /** What happened — 1-2 sentences. */
  text: string;
}

// ============================================================================
// Episode Document (Cosmos DB)
// ============================================================================

/**
 * A theme-based episode — an ongoing narrative arc spanning sessions.
 *
 * Stored in the `episodes` Cosmos DB container.
 * Partition key: `/userId`
 *
 * Episodes are created and updated by the LLM via tools, not by
 * background processes. The LLM decides when to create, update,
 * or conclude episodes based on conversational context.
 */
export interface EpisodeDocument extends Doc {
  /** Deterministic ID: "ep_{hash(userId:normalizedTheme)}" */
  id: string;
  /** User who owns this episode. Partition key. */
  userId: string;
  /** The life theme: "Wedding Planning", "Kitchen Renovation". */
  theme: string;
  /** Current narrative summary — evolves with each contribution. */
  summary: string;
  /** Embedding vector of theme+summary for semantic search. */
  vector: number[];
  /** 1-5 topic tags. */
  topics: string[];
  /** Chronological timeline of key moments (newest last). */
  highlights: EpisodeHighlight[];
  /** Whether this episode is still active or has concluded. */
  status: "active" | "concluded";
  /** Emotional significance (0-1). Higher = more important life event. Default: 0.5. */
  salience: number;
  /** Key decisions made across all contributing sessions. */
  decisions: string[];
  /** Current unresolved items — updated (not appended) each contribution. */
  pending: string[];
  /** ISO-8601 timestamp when the episode was first created. */
  createdAt: string;
  /** ISO-8601 timestamp of the last contribution. */
  updatedAt: string;
}
