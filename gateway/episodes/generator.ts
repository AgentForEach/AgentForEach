/**
 * AgentForEach Episode Layer — Utilities
 *
 * Helper functions for episode ID generation and response parsing.
 *
 * Note: Episode generation is now LLM-driven via tools (episode_create,
 * episode_update). There is no background generation process.
 * These utilities are used by the tool handlers in tools.ts.
 */

import { createHash } from "node:crypto";

// ============================================================================
// Episode ID Generation
// ============================================================================

/**
 * Deterministic episode ID from userId + theme.
 * Normalizes the theme to lowercase trimmed for consistent hashing.
 * Ensures idempotent storage (same user + theme → same episode ID).
 */
export function buildEpisodeId(userId: string, theme: string): string {
  const normalizedTheme = theme.trim().toLowerCase();
  const hash = createHash("sha256")
    .update(`${userId}:${normalizedTheme}`)
    .digest("hex")
    .slice(0, 16);
  return `ep_${hash}`;
}

// ============================================================================
// String Array Normalization
// ============================================================================

/**
 * Normalize an unknown value into a string array with a max item count.
 * Filters out non-strings and empty strings.
 */
export function normalizeStringArray(
  value: unknown,
  maxItems: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .slice(0, maxItems)
    .map((s) => s.trim());
}
