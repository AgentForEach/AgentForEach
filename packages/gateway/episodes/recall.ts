/**
 * AgentForEach Episode Layer — Episode Recall & Formatting
 *
 * Formats theme-based episodes into human-readable context for the LLM.
 *
 * Episodes are recalled via the `episode_recall` tool — the LLM decides
 * when to search. This module provides the formatting layer that converts
 * raw EpisodeDocument data into readable text with:
 *   - Theme name + status + recency
 *   - Narrative summary
 *   - Chronological highlights timeline
 *   - Decisions and pending items
 */

import type { EpisodeDocument } from "./types.js";

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format episodes into a human-readable context block.
 *
 * Example output:
 * ```
 * ### Wedding Planning (active, last updated 2 days ago)
 * ID: ep_abc123
 * Planning the destination wedding in Goa — venue research, guest list
 * management, and vendor coordination across multiple conversations.
 * Topics: wedding, Goa, venue, vendors
 * Highlights:
 * - Feb 20: Shortlisted 3 beach venues in South Goa, compared pricing
 * - Feb 22: Finalized guest list at 120, created seating chart draft
 * - Feb 24: Discussed photographer options, decided on candid style
 * Decisions:
 * - Beach venue over hotel ballroom
 * - Candid photography style
 * Pending:
 * - Finalize catering menu
 * - Book photographer by March 1
 * ```
 */
export function formatEpisodesContext(
  episodes: EpisodeDocument[],
  userTimezone?: string,
): string {
  const now = new Date();
  const lines: string[] = [];

  for (const ep of episodes) {
    const updatedAt = new Date(ep.updatedAt);
    const timeLabel = formatRelativeTime(updatedAt, now);

    const salience = ep.salience ?? 0.5;
    const significanceLabel = salience >= 0.8 ? ", significance: high" : "";
    lines.push(`### ${ep.theme} (${ep.status}, last updated ${timeLabel}${significanceLabel})`);
    lines.push(`ID: ${ep.id}`);
    lines.push(ep.summary);

    if (ep.topics.length > 0) {
      lines.push(`Topics: ${ep.topics.join(", ")}`);
    }

    if (ep.highlights.length > 0) {
      lines.push("Highlights:");
      for (const h of ep.highlights) {
        const dateLabel = formatShortDate(new Date(h.date), userTimezone);
        lines.push(`- ${dateLabel}: ${h.text}`);
      }
    }

    if (ep.decisions.length > 0) {
      lines.push("Decisions:");
      for (const d of ep.decisions) {
        lines.push(`- ${d}`);
      }
    }

    if (ep.pending.length > 0) {
      lines.push("Pending:");
      for (const p of ep.pending) {
        lines.push(`- ${p}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

// ============================================================================
// Time Formatting Helpers
// ============================================================================

/**
 * Format a date as a relative time label.
 * Examples: "earlier today", "yesterday", "2 days ago", "last week", "12 days ago"
 */
function formatRelativeTime(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 24) return "earlier today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "last week";
  return `${diffDays} days ago`;
}

/**
 * Format a date as a short human-readable string.
 * Examples: "Feb 22", "Jan 15"
 */
function formatShortDate(date: Date, userTimezone?: string): string {
  try {
    const options: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
    };
    if (userTimezone) {
      options.timeZone = userTimezone;
    }
    return date.toLocaleDateString("en-US", options);
  } catch {
    // Fallback if timezone is invalid
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
}
