/**
 * Cosmos `VectorDistance` with the cosine function returns a SIMILARITY
 * (-1..1, higher is closer; ORDER BY VectorDistance already lists the closest
 * first), not a distance. Clamp it to 0..1 for the thresholds downstream.
 * Treating it as a distance inverts every score.
 */
export function similarityFromVectorDistance(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
