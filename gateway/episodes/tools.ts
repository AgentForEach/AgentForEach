/**
 * AgentForEach Episode Layer — Function Tool Definitions & Handler
 *
 * Defines three tools for LLM-driven episodic memory management:
 *   - `episode_recall`  — search past episodes by topic/theme
 *   - `episode_create`  — create a new theme-based episode
 *   - `episode_update`  — contribute a highlight to an existing episode
 *
 * The LLM decides WHEN to manage episodes based on conversational
 * context — just like human episodic memory is cue-triggered.
 */

import type { EmbeddingsClient } from "../memory/embeddings.js";
import type { MemoryLayer, ToolDefinition } from "../memory/types.js";
import type { TemporalDecayConfig } from "../memory/config.js";
import { applyDecay, EVERGREEN_IMPORTANCE_THRESHOLD } from "../memory/temporal-decay.js";
import type { EpisodeStore } from "./store.js";
import type { EpisodeConfig } from "./config.js";
import type { EpisodeDocument, EpisodeHighlight } from "./types.js";
import { formatEpisodesContext } from "./recall.js";
import { buildEpisodeId, normalizeStringArray } from "./generator.js";

// ============================================================================
// Internal Signals
// ============================================================================

/** Thrown inside the episode updater to abort the write when session already contributed. */
class SessionDedupSignal extends Error {
  constructor() {
    super("session-dedup");
  }
}

// ============================================================================
// Tool Names
// ============================================================================

export const EPISODE_RECALL_TOOL_NAME = "episode_recall";
export const EPISODE_CREATE_TOOL_NAME = "episode_create";
export const EPISODE_UPDATE_TOOL_NAME = "episode_update";

// ============================================================================
// Tool Definitions
// ============================================================================

export const EPISODE_RECALL_TOOL: ToolDefinition = {
  type: "function",
  name: EPISODE_RECALL_TOOL_NAME,
  description:
    "Search past conversation episodes to recall what you and the user discussed " +
    "in previous sessions. Returns narrative summaries of relevant past themes " +
    "with highlights, decisions, and pending items. Use when the user references past " +
    "work, wants to continue a previous conversation, or asks about recent history.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to search for. Be descriptive about the topic, project, or activity. " +
          "Examples: 'wedding planning', 'memory architecture design', " +
          "'job search progress'.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const EPISODE_CREATE_TOOL: ToolDefinition = {
  type: "function",
  name: EPISODE_CREATE_TOOL_NAME,
  description:
    "Create a new episode for a life theme or project that doesn't match any existing episode. " +
    "Episodes track ongoing themes like 'Wedding Planning', 'Job Search', or 'Kitchen Renovation'. " +
    "Call episode_recall first to check if a matching episode already exists before creating a new one.",
  parameters: {
    type: "object",
    properties: {
      theme: {
        type: "string",
        description:
          "Short theme name (2-5 words): 'Wedding Planning', 'Memory System Design', 'Job Search'.",
      },
      summary: {
        type: "string",
        description: "Initial narrative summary (2-4 sentences) of what this episode is about.",
      },
      topics: {
        type: "array",
        items: { type: "string" },
        description: "1-5 topic tags for this episode.",
      },
      highlight: {
        type: "string",
        description: "First highlight entry — what happened in this session (1-2 sentences).",
      },
      decisions: {
        type: "array",
        items: { type: "string" },
        description: "Key decisions made so far (0-5 items).",
      },
      pending: {
        type: "array",
        items: { type: "string" },
        description: "Unresolved items or next steps (0-3 items).",
      },
      salience: {
        type: "number",
        description:
          "Emotional significance (0-1). Routine tasks=0.3-0.5, notable events=0.6-0.7, " +
          "major life events=0.8-1.0. Default: 0.5.",
      },
    },
    required: ["theme", "summary", "highlight"],
    additionalProperties: false,
  },
};

export const EPISODE_UPDATE_TOOL: ToolDefinition = {
  type: "function",
  name: EPISODE_UPDATE_TOOL_NAME,
  description:
    "Update an existing episode with new highlights from the current conversation. " +
    "Call this after episode_recall when the current conversation contributes to an " +
    "existing theme. You can update the summary, decisions, pending items, and status.",
  parameters: {
    type: "object",
    properties: {
      episodeId: {
        type: "string",
        description: "ID of the episode to update (from recall results).",
      },
      highlight: {
        type: "string",
        description:
          "What happened in this session related to the episode (1-2 sentences).",
      },
      summary: {
        type: "string",
        description: "Updated narrative summary incorporating the new highlight.",
      },
      decisions: {
        type: "array",
        items: { type: "string" },
        description: "Updated list of key decisions (replaces existing).",
      },
      pending: {
        type: "array",
        items: { type: "string" },
        description: "Updated list of unresolved items (replaces existing).",
      },
      status: {
        type: "string",
        enum: ["active", "concluded"],
        description:
          "Set to 'concluded' if the theme is complete (e.g., wedding is over, project shipped).",
      },
      salience: {
        type: "number",
        description:
          "Updated emotional significance (0-1). Adjust if the episode has become more or less important.",
      },
    },
    required: ["episodeId", "highlight"],
    additionalProperties: false,
  },
};

// ============================================================================
// Tool Guards
// ============================================================================

const EPISODE_TOOL_NAMES = new Set([
  EPISODE_RECALL_TOOL_NAME,
  EPISODE_CREATE_TOOL_NAME,
  EPISODE_UPDATE_TOOL_NAME,
]);

export function isEpisodeTool(toolName: string): boolean {
  return EPISODE_TOOL_NAMES.has(toolName);
}

export function getEpisodeToolDefinitions(): ToolDefinition[] {
  return [EPISODE_RECALL_TOOL, EPISODE_CREATE_TOOL, EPISODE_UPDATE_TOOL];
}

// ============================================================================
// Helpers
// ============================================================================

/** Parse and clamp a salience value to [0, 1]. Defaults to 0.5. */
function clampSalience(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

// ============================================================================
// Tool Handler
// ============================================================================

export class EpisodeToolHandler {
  private store: EpisodeStore;
  private config: EpisodeConfig;
  private embeddings?: EmbeddingsClient;
  private memoryLayer?: MemoryLayer;

  constructor(
    store: EpisodeStore,
    config: EpisodeConfig,
    embeddings?: EmbeddingsClient,
    memoryLayer?: MemoryLayer,
  ) {
    this.store = store;
    this.config = config;
    this.embeddings = embeddings;
    this.memoryLayer = memoryLayer;
  }

  async handle(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
    sessionId?: string,
    userTimezone?: string,
  ): Promise<string> {
    switch (toolName) {
      case EPISODE_RECALL_TOOL_NAME:
        return this.handleRecall(args, userId, userTimezone);
      case EPISODE_CREATE_TOOL_NAME:
        return this.handleCreate(args, userId, sessionId);
      case EPISODE_UPDATE_TOOL_NAME:
        return this.handleUpdate(args, userId, sessionId);
      default:
        return JSON.stringify({ error: `Unknown episode tool: ${toolName}` });
    }
  }

  // --------------------------------------------------------------------------
  // Recall Handler
  // --------------------------------------------------------------------------

  private async handleRecall(
    args: Record<string, unknown>,
    userId: string,
    userTimezone?: string,
  ): Promise<string> {
    const query =
      typeof args.query === "string" ? args.query.trim() : "";

    if (!query) {
      return JSON.stringify({ error: "query is required" });
    }

    try {
      const now = Date.now();

      // Strategy 1: Semantic search (preferred)
      if (this.embeddings) {
        const queryVector = await this.embeddings.embed(query);

        // Fetch more than needed — we re-rank after salience boost + decay
        const fetchLimit = this.config.recallLimit * 3;
        const results = await this.store.semanticSearch(
          queryVector,
          userId,
          fetchLimit,
          this.config.recallMaxAgeDays,
        );

        if (results.length === 0) {
          return "No past episodes found matching that topic.";
        }

        // Apply combined salience boost + temporal decay, then re-rank
        const ranked = this.rankWithSalienceAndDecay(results.map(r => ({
          episode: r.episode,
          baseScore: r.score,
        })), now);

        const episodes = ranked
          .slice(0, this.config.recallLimit)
          .map((r) => r.episode);
        const formatted = formatEpisodesContext(episodes, userTimezone);
        return formatted || "No past episodes found matching that topic.";
      }

      // Strategy 2: Temporal fallback (no embeddings)
      const fetchLimit = this.config.recallLimit * 3;
      const recent = await this.store.getRecent(
        userId,
        fetchLimit,
        this.config.recallMaxAgeDays,
      );

      if (!recent || recent.length === 0) {
        return "No past episodes found.";
      }

      // Apply salience boost + decay to temporal results (base score 1.0)
      const ranked = this.rankWithSalienceAndDecay(recent.map(ep => ({
        episode: ep,
        baseScore: 1.0,
      })), now);

      const episodes = ranked
        .slice(0, this.config.recallLimit)
        .map((r) => r.episode);
      const formatted = formatEpisodesContext(episodes, userTimezone);
      return formatted || "No past episodes found.";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Episode recall failed: ${message}` });
    }
  }

  // --------------------------------------------------------------------------
  // Create Handler
  // --------------------------------------------------------------------------

  private async handleCreate(
    args: Record<string, unknown>,
    userId: string,
    sessionId?: string,
  ): Promise<string> {
    const theme =
      typeof args.theme === "string" ? args.theme.trim() : "";
    const summary =
      typeof args.summary === "string"
        ? args.summary.trim().slice(0, this.config.maxSummaryChars)
        : "";
    const highlight =
      typeof args.highlight === "string" ? args.highlight.trim() : "";

    if (!theme) {
      return JSON.stringify({ error: "theme is required" });
    }
    if (!summary) {
      return JSON.stringify({ error: "summary is required" });
    }
    if (!highlight) {
      return JSON.stringify({ error: "highlight is required" });
    }

    const topics = normalizeStringArray(args.topics, 5);
    const decisions = normalizeStringArray(args.decisions, 5);
    const pending = normalizeStringArray(args.pending, 3);
    const salience = clampSalience(args.salience);

    try {
      const episodeId = buildEpisodeId(userId, theme);
      const now = new Date().toISOString();

      const initialHighlight: EpisodeHighlight = {
        date: now,
        sessionId: sessionId ?? "unknown",
        text: highlight,
      };

      // Generate embedding for semantic search
      let vector: number[] = [];
      if (this.config.generateVectors && this.embeddings) {
        try {
          vector = await this.embeddings.embed(`${theme}: ${summary}`);
        } catch {
          // Non-fatal — episode still useful without vector
        }
      }

      const episode: EpisodeDocument = {
        id: episodeId,
        userId,
        theme,
        summary,
        vector,
        topics,
        highlights: [initialHighlight],
        status: "active",
        salience,
        decisions,
        pending,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.upsert(episode);

      return JSON.stringify({
        success: true,
        episodeId,
        theme,
        message: `Episode "${theme}" created successfully.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Episode creation failed: ${message}` });
    }
  }

  // --------------------------------------------------------------------------
  // Update Handler
  // --------------------------------------------------------------------------

  private async handleUpdate(
    args: Record<string, unknown>,
    userId: string,
    sessionId?: string,
  ): Promise<string> {
    const episodeId =
      typeof args.episodeId === "string" ? args.episodeId.trim() : "";
    const highlight =
      typeof args.highlight === "string" ? args.highlight.trim() : "";

    if (!episodeId) {
      return JSON.stringify({ error: "episodeId is required" });
    }
    if (!highlight) {
      return JSON.stringify({ error: "highlight is required" });
    }

    try {
      // Use ETag-based conditional update to prevent lost writes when
      // two sessions (e.g., web + Telegram) update the same episode
      // concurrently. The updater is re-run on conflict with fresh data.
      const updated = await this.store.conditionalUpdate(
        userId,
        episodeId,
        async (episode) => {
          // Backfill salience for pre-existing episodes (backward compat)
          episode.salience ??= 0.5;

          // Session dedup check — done inside the updater so it's
          // evaluated against the latest state on each retry attempt.
          // Throws to abort the write (no point persisting unchanged doc).
          if (sessionId && episode.highlights.some((h) => h.sessionId === sessionId)) {
            throw new SessionDedupSignal();
          }

          // Append new highlight
          const now = new Date().toISOString();
          const newHighlight: EpisodeHighlight = {
            date: now,
            sessionId: sessionId ?? "unknown",
            text: highlight,
          };
          episode.highlights.push(newHighlight);

          // Trim highlights if exceeding cap
          if (episode.highlights.length > this.config.maxHighlightsPerEpisode) {
            episode.highlights = episode.highlights.slice(
              episode.highlights.length - this.config.maxHighlightsPerEpisode,
            );
          }

          // Update optional fields if provided
          if (typeof args.summary === "string" && args.summary.trim()) {
            episode.summary = args.summary.trim().slice(0, this.config.maxSummaryChars);
          }
          if (Array.isArray(args.decisions)) {
            episode.decisions = normalizeStringArray(args.decisions, 5);
          }
          if (Array.isArray(args.pending)) {
            episode.pending = normalizeStringArray(args.pending, 3);
          }
          if (args.status === "active" || args.status === "concluded") {
            episode.status = args.status;
          }
          if (typeof args.salience === "number") {
            episode.salience = clampSalience(args.salience);
          }

          // Re-embed for semantic search
          if (this.config.generateVectors && this.embeddings) {
            try {
              episode.vector = await this.embeddings.embed(
                `${episode.theme}: ${episode.summary}`,
              );
            } catch {
              // Non-fatal — keep existing vector
            }
          }

          episode.updatedAt = now;
          return episode;
        },
      );

      if (!updated) {
        return JSON.stringify({
          error: `Episode not found: ${episodeId}`,
        });
      }

      // Memory consolidation on conclusion (fire-and-forget)
      if (args.status === "concluded" && this.memoryLayer) {
        this.consolidateToMemory(updated, userId).catch(() => {});
      }

      return JSON.stringify({
        success: true,
        episodeId,
        theme: updated.theme,
        highlightCount: updated.highlights.length,
        message: `Episode "${updated.theme}" updated with new highlight.`,
      });
    } catch (err) {
      // Session already contributed — not an error, just a no-op
      if (err instanceof SessionDedupSignal) {
        return JSON.stringify({
          success: true,
          episodeId,
          message: "This session has already contributed to this episode.",
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Episode update failed: ${message}` });
    }
  }

  // --------------------------------------------------------------------------
  // Salience Boost + Temporal Decay Ranking
  // --------------------------------------------------------------------------

  /**
   * Re-rank episodes using combined salience boost and temporal decay.
   *
   * Salience boost: score * (0.5 + salience * 0.5)
   *   - salience 0.0 → 0.5x, salience 0.5 → 0.75x, salience 1.0 → 1.0x
   *
   * Temporal decay: exponential decay with salience-modified half-life.
   *   - Higher salience → slower decay (more durable memories)
   *   - Salience >= EVERGREEN_IMPORTANCE_THRESHOLD → exempt from decay
   */
  private rankWithSalienceAndDecay(
    items: { episode: EpisodeDocument; baseScore: number }[],
    now: number,
  ): { episode: EpisodeDocument; finalScore: number }[] {
    const ranked = items.map(({ episode, baseScore }) => {
      const salience = episode.salience ?? 0.5;

      // Salience boost
      let adjustedScore = baseScore * (0.5 + salience * 0.5);

      // Temporal decay (skip for evergreen episodes)
      if (this.config.decayEnabled && salience < EVERGREEN_IMPORTANCE_THRESHOLD) {
        const effectiveHalfLife = this.config.decayHalfLifeDays * (1 + salience);
        const decayConfig: TemporalDecayConfig = {
          enabled: true,
          halfLifeDays: effectiveHalfLife,
        };
        adjustedScore = applyDecay(adjustedScore, episode.updatedAt, decayConfig, now);
      }

      return { episode, finalScore: adjustedScore };
    });

    // Sort by finalScore descending (highest relevance first)
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    return ranked;
  }

  // --------------------------------------------------------------------------
  // Memory Consolidation (on episode conclusion)
  // --------------------------------------------------------------------------

  /**
   * Graduate key episode content to long-term semantic memory.
   *
   * When an episode concludes (wedding is over, project shipped), its
   * decisions and summary are stored as individual memory entries.
   * This mirrors how humans consolidate episodic memories into semantic
   * long-term memory during sleep/reflection.
   *
   * All calls are fire-and-forget — failure doesn't block the episode update.
   * MemoryLayer.store() handles dedup (exact + near-duplicate) internally.
   */
  private async consolidateToMemory(
    episode: EpisodeDocument,
    userId: string,
  ): Promise<void> {
    if (!this.memoryLayer) return;

    const source = `episode:${episode.id}`;
    const tags = [episode.theme.toLowerCase()];

    // Store each decision as a separate memory entry
    for (const decision of episode.decisions) {
      await this.memoryLayer.store(
        `[${episode.theme}] Decision: ${decision}`,
        { userId, category: "decision", importance: 0.85, source, tags },
      ).catch(() => {});
    }

    // Store the summary as an evergreen fact (importance 0.9 = exempt from memory decay)
    await this.memoryLayer.store(
      `[${episode.theme}] Summary: ${episode.summary}`,
      { userId, category: "fact", importance: 0.9, source, tags },
    ).catch(() => {});
  }
}
