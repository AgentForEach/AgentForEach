/**
 * AgentForEach Channels — Message Splitting
 *
 * Every chat channel caps message length and every one of them needs the same
 * splitting rule. This lived privately inside the Telegram plugin until
 * WhatsApp became the second consumer; one copy is the point.
 */

/**
 * Split a message into chunks respecting the max length limit.
 *
 * Splitting priority:
 *   1. Try to split at a newline near the limit
 *   2. Fall back to splitting at a space
 *   3. Hard split at the limit (last resort)
 *
 * @param text - Full message text.
 * @param maxLength - Maximum characters per chunk.
 * @returns Array of text chunks.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline near the max length
    let splitAt = remaining.lastIndexOf("\n", maxLength);

    if (splitAt <= 0 || splitAt < maxLength * 0.5) {
      // Fall back to space split
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }

    if (splitAt <= 0) {
      // Hard split at the limit
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
