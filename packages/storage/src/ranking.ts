/**
 * AgentForEach Storage SDK — Ranking helpers
 *
 * Cosine similarity, BM25 and weighted reciprocal rank fusion (RRF). The
 * in-memory adapter ranks with them, and an adapter whose database has
 * vector search but no native hybrid ranking can fuse in the application.
 */

/** Constant of Cosmos DB's RRF (and the usual choice in the literature). */
export const RRF_K = 60;

/** Cosine similarity of two equal-length vectors (-1..1); 0 if either is all zeros. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Lower-cased word tokens: letters, digits and combining marks, any script
 * (marks matter: Devanagari vowel signs, for one, sit inside words).
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
}

/**
 * BM25 scores (k1 = 1.2, b = 0.75) of each text against the query terms,
 * with document frequencies taken from `texts` itself.
 */
export function bm25Scores(texts: readonly string[], terms: readonly string[], k1 = 1.2, b = 0.75): number[] {
  const docs = texts.map(tokenize);
  const queryTokens = [...new Set(terms.flatMap(tokenize))];
  const n = docs.length;
  if (n === 0 || queryTokens.length === 0) return docs.map(() => 0);
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / n || 1;
  const docFrequency = new Map<string, number>();
  for (const token of queryTokens) {
    docFrequency.set(token, docs.filter((d) => d.includes(token)).length);
  }
  return docs.map((tokens) => {
    let score = 0;
    for (const token of queryTokens) {
      const tf = tokens.filter((t) => t === token).length;
      if (tf === 0) continue;
      const df = docFrequency.get(token)!;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * tokens.length) / avgLength));
    }
    return score;
  });
}

/**
 * Dense ranks (from 1) of scores, higher is better: equal scores share a
 * rank and the next distinct score takes the next rank, as Cosmos DB's RRF
 * ranks its component scores.
 */
export function denseRanks(scores: readonly number[]): number[] {
  const distinct = [...new Set(scores)].sort((a, b) => b - a);
  const rankOf = new Map(distinct.map((score, i) => [score, i + 1]));
  return scores.map((score) => rankOf.get(score)!);
}

/**
 * Fuse per-component scores (one array per component, one score per
 * candidate) by weighted RRF over dense ranks. Returns candidate indexes,
 * best first; ties keep candidate order.
 */
export function fuseRanks(componentScores: readonly (readonly number[])[], weights: readonly number[], k = RRF_K): number[] {
  if (weights.length !== componentScores.length) {
    throw new Error("fuseRanks: one weight per component");
  }
  const n = componentScores[0]?.length ?? 0;
  const fused = new Array<number>(n).fill(0);
  componentScores.forEach((scores, c) => {
    denseRanks(scores).forEach((rank, i) => {
      fused[i] += weights[c] / (k + rank);
    });
  });
  return fused.map((_, i) => i).sort((a, b) => fused[b] - fused[a] || a - b);
}

/**
 * Weighted reciprocal rank fusion of positional rankings (for adapters that
 * only get ranked lists back). Each ranking lists keys best first; a key
 * scores sum(weight_i / (k + rank_i)) with ranks from 1. Returns keys best
 * first; ties keep the order in which keys first appear.
 */
export function reciprocalRankFusion<K>(
  rankings: readonly (readonly K[])[],
  weights: readonly number[] = rankings.map(() => 1),
  k = RRF_K,
): K[] {
  if (weights.length !== rankings.length) {
    throw new Error("reciprocalRankFusion: one weight per ranking");
  }
  const scores = new Map<K, number>();
  rankings.forEach((ranking, i) => {
    ranking.forEach((key, index) => {
      scores.set(key, (scores.get(key) ?? 0) + weights[i] / (k + index + 1));
    });
  });
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
}
