// ============================================================================
// Truncation Helper
// ============================================================================

/**
 * Truncate rendered content using head+tail strategy.
 * Head + tail ratios sum to 1.0 (no wasted budget).
 */
export function truncateHeadTail(
  content: string,
  docType: string,
  maxChars: number,
  headRatio: number = 0.8,
  tailRatio: number = 0.2,
): string {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;

  const markerText = `[...truncated, ${docType} has ${trimmed.length} chars, showing ${maxChars}...]`;
  const markerLen = markerText.length + 2; // +2 for newlines
  const available = maxChars - markerLen;
  if (available <= 0) return markerText;

  const headChars = Math.floor(
    available * (headRatio / (headRatio + tailRatio)),
  );
  const tailChars = available - headChars;
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  return [head, markerText, tail].join("\n");
}