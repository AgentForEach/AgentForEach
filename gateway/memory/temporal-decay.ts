/**
 * AgentForEach Memory Layer — Temporal Decay
 *
 * Recency-aware scoring: older memories decay in relevance.
 *
 * Uses exponential decay: score * e^(-λ * ageInDays)
 * where λ = ln(2) / halfLifeDays
 *
 * Applied client-side after Cosmos DB returns search results.
 *
 * Memories with importance >= EVERGREEN_IMPORTANCE_THRESHOLD are exempt
 * from decay.
 */

import type { MemorySearchResult } from "./types.js";
import type { TemporalDecayConfig } from "./config.js";
import { DEFAULT_TEMPORAL_DECAY_CONFIG } from "./config.js";

/** Memories at or above this importance are exempt from temporal decay. */
export const EVERGREEN_IMPORTANCE_THRESHOLD = 0.9;

// ============================================================================
// Decay Calculation
// ============================================================================

const MS_PER_DAY = 86_400_000;

/**
 * Calculate the temporal decay multiplier for a given age in days.
 *
 * @param ageInDays - Age of the memory in days (fractional OK).
 * @param halfLifeDays - Half-life: after this many days, multiplier = 0.5.
 * @returns Multiplier in (0, 1]. Returns 1 for age = 0.
 */
export function calculateDecayMultiplier(
  ageInDays: number,
  halfLifeDays: number,
): number {
  if (ageInDays <= 0) return 1;
  if (halfLifeDays <= 0) return 1;
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageInDays);
}

/**
 * Apply temporal decay to a single score.
 *
 * @param score - The original relevance score.
 * @param createdAt - ISO 8601 creation timestamp of the memory.
 * @param config - Temporal decay configuration.
 * @param now - Optional reference time (defaults to Date.now()).
 * @returns The decayed score.
 */
export function applyDecay(
  score: number,
  createdAt: string,
  config: TemporalDecayConfig = DEFAULT_TEMPORAL_DECAY_CONFIG,
  now?: number,
): number {
  if (!config.enabled) return score;

  const createdMs = new Date(createdAt).getTime();
  const nowMs = now ?? Date.now();
  const ageInDays = Math.max(0, (nowMs - createdMs) / MS_PER_DAY);

  const multiplier = calculateDecayMultiplier(ageInDays, config.halfLifeDays);
  return score * multiplier;
}

// ============================================================================
// Batch Application to Search Results
// ============================================================================

/**
 * Apply temporal decay to an array of search results.
 * Sets `decayedScore` on each result and updates `finalScore`.
 *
 * Results are re-sorted by `finalScore` descending after decay.
 *
 * @param results - Array of search results (mutated in place).
 * @param config - Temporal decay configuration.
 * @param evergreenThreshold - Importance threshold for evergreen exemption (default: 0.9).
 * @returns The same array, sorted by finalScore descending.
 */
export function applyTemporalDecay(
  results: MemorySearchResult[],
  config: TemporalDecayConfig = DEFAULT_TEMPORAL_DECAY_CONFIG,
  evergreenThreshold = EVERGREEN_IMPORTANCE_THRESHOLD,
): MemorySearchResult[] {
  if (!config.enabled || results.length === 0) return results;

  const now = Date.now();

  for (const result of results) {
    // Evergreen exemption: high-importance memories never decay
    //
    if (result.entry.importance >= evergreenThreshold) {
      result.decayedScore = result.score;
      result.finalScore = result.score;
      continue;
    }

    result.decayedScore = applyDecay(
      result.score,
      result.entry.createdAt,
      config,
      now,
    );
    result.finalScore = result.decayedScore;
  }

  // Re-sort by finalScore descending
  results.sort((a, b) => b.finalScore - a.finalScore);

  return results;
}
