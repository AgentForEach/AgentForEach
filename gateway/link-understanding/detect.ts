/**
 * AgentForEach Link Understanding — URL Detection
 *
 * Detects HTTP/HTTPS URLs in user message text.
 * Skips media URLs (images, videos, audio) since those are handled
 * by the media pipeline (future).
 */

// ============================================================================
// URL Pattern
// ============================================================================

/**
 * Matches http:// and https:// URLs in text.
 *
 * Captures URLs that:
 *   - Start with http:// or https://
 *   - Include domain with at least one dot
 *   - May include path, query, and fragment
 *   - Stop at whitespace, angle brackets, quotes, or end of string
 */
const URL_PATTERN =
  /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * File extensions to skip (media files — handled separately).
 */
const MEDIA_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mkv",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
]);

// ============================================================================
// Detection
// ============================================================================

/**
 * Detect URLs in message text.
 *
 * @param text - The user's message text.
 * @param maxUrls - Maximum number of URLs to return.
 * @returns Deduplicated array of detected URLs (up to maxUrls).
 */
export function detectUrls(text: string, maxUrls: number): string[] {
  const matches = text.match(URL_PATTERN);
  if (!matches) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of matches) {
    // Clean trailing punctuation that's likely not part of the URL
    const url = cleanTrailingPunctuation(raw);

    // Skip media URLs
    if (isMediaUrl(url)) continue;

    // Deduplicate
    const normalized = url.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    result.push(url);
    if (result.length >= maxUrls) break;
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip trailing punctuation that was likely part of the surrounding text,
 * not the URL itself.
 */
function cleanTrailingPunctuation(url: string): string {
  // Remove trailing periods, commas, semicolons, colons (unless part of port)
  // Also remove matching trailing parens/brackets if no opening match
  let cleaned = url.replace(/[.,;!?]+$/, "");

  // Handle trailing parenthesis — only strip if unbalanced
  // (common in markdown: "check [this](https://example.com).")
  while (cleaned.endsWith(")") && countChar(cleaned, "(") < countChar(cleaned, ")")) {
    cleaned = cleaned.slice(0, -1);
  }

  return cleaned;
}

function countChar(str: string, char: string): number {
  let count = 0;
  for (const c of str) {
    if (c === char) count++;
  }
  return count;
}

/**
 * Check if a URL points to a media file based on extension.
 */
function isMediaUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const lastDot = pathname.lastIndexOf(".");
    if (lastDot === -1) return false;
    return MEDIA_EXTENSIONS.has(pathname.slice(lastDot));
  } catch {
    return false;
  }
}
