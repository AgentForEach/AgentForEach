/**
 * AgentForEach Memory Layer — Maximal Marginal Relevance (MMR) Re-ranking
 *
 * Diversity-aware re-ranking to reduce redundancy in search results.
 * Ported from OpenClaw's src/memory/mmr.ts.
 *
 * MMR iteratively selects items that balance relevance with novelty:
 *   MMR(d) = λ * Relevance(d) - (1-λ) * max(Similarity(d, selected))
 *
 * Uses Jaccard token similarity as the inter-document similarity metric
 * (operates on text, not vectors — avoids needing full vector storage
 * in search results from Cosmos DB).
 */

import type { MemorySearchResult } from "./types.js";
import type { MMRConfig } from "./config.js";
import { DEFAULT_MMR_CONFIG } from "./config.js";

// ============================================================================
// Tokenization & Similarity
// ============================================================================

/**
 * Tokenize text into a set of lowercase word tokens.
 * Simple whitespace + punctuation split suitable for Jaccard similarity.
 */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return new Set(tokens);
}

/**
 * Compute Jaccard similarity between two token sets.
 * J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * @returns Similarity in [0, 1]. 0 = no overlap, 1 = identical.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================================
// MMR Score Computation
// ============================================================================

/**
 * Compute the MMR score for a candidate document.
 *
 * MMR(d) = λ * normalizedRelevance - (1-λ) * maxSimilarityToSelected
 *
 * @param relevance - Normalized relevance score in [0, 1].
 * @param candidateTokens - Token set of the candidate.
 * @param selectedTokenSets - Token sets of already-selected documents.
 * @param lambda - Trade-off: 1 = pure relevance, 0 = pure diversity.
 */
function computeMMRScore(
  relevance: number,
  candidateTokens: Set<string>,
  selectedTokenSets: Set<string>[],
  lambda: number,
): number {
  let maxSim = 0;
  for (const selectedTokens of selectedTokenSets) {
    const sim = jaccardSimilarity(candidateTokens, selectedTokens);
    if (sim > maxSim) maxSim = sim;
  }
  return lambda * relevance - (1 - lambda) * maxSim;
}

// ============================================================================
// MMR Re-ranking
// ============================================================================

/**
 * Apply MMR re-ranking to search results.
 *
 * Iteratively selects the result with the highest MMR score
 * (balancing relevance and diversity) until all results are selected.
 *
 * Sets `mmrScore` on each result and updates `finalScore`.
 * Results are returned in MMR-selected order.
 *
 * @param results - Array of search results (a new sorted array is returned).
 * @param config - MMR configuration.
 * @returns New array sorted by MMR selection order.
 */
export function applyMMR(
  results: MemorySearchResult[],
  config: MMRConfig = DEFAULT_MMR_CONFIG,
): MemorySearchResult[] {
  if (!config.enabled || results.length <= 1) return results;

  const lambda = Math.max(0, Math.min(1, config.lambda));

  // I6: Lambda=1 fast path — pure relevance, no diversity needed
  if (lambda === 1) {
    return [...results].sort((a, b) => b.finalScore - a.finalScore);
  }

  // Normalize scores to [0, 1]
  const maxScore = Math.max(...results.map((r) => r.finalScore));
  const minScore = Math.min(...results.map((r) => r.finalScore));
  const scoreRange = maxScore - minScore || 1;

  // Pre-tokenize all candidate texts
  const tokenSets = results.map((r) => tokenize(r.entry.text));

  // Track which candidates are still available
  const available = new Set<number>(results.map((_, i) => i));
  const selected: MemorySearchResult[] = [];
  const selectedTokenSets: Set<string>[] = [];

  while (available.size > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;
    let bestOriginalScore = -Infinity;

    for (const idx of available) {
      const normalizedRelevance =
        (results[idx].finalScore - minScore) / scoreRange;
      const mmrScore = computeMMRScore(
        normalizedRelevance,
        tokenSets[idx],
        selectedTokenSets,
        lambda,
      );
      // I5: Tiebreaker — use original score when MMR scores are equal
      if (
        mmrScore > bestMMR ||
        (mmrScore === bestMMR && results[idx].finalScore > bestOriginalScore)
      ) {
        bestMMR = mmrScore;
        bestIdx = idx;
        bestOriginalScore = results[idx].finalScore;
      }
    }

    if (bestIdx === -1) break;

    available.delete(bestIdx);
    const result = { ...results[bestIdx] };
    result.mmrScore = bestMMR;
    // I4: Preserve original finalScore — MMR only determines ordering,
    // not the score value used for downstream filtering
    selected.push(result);
    selectedTokenSets.push(tokenSets[bestIdx]);
  }

  return selected;
}
