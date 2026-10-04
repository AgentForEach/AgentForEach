/**
 * A vector search score (cosine similarity, -1..1, higher is closer; null
 * for a document without a vector) clamped to 0..1 for the thresholds
 * downstream. Cosmos `VectorDistance` with the cosine function returns this
 * similarity, not a distance: treating it as a distance inverts every score.
 */
export function similarityFromVectorDistance(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
