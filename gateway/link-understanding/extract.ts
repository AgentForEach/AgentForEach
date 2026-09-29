/**
 * AgentForEach Link Understanding — Content Extraction
 *
 * Extracts readable text from HTML using regex-based processing.
 * No heavy DOM dependency (no jsdom, no cheerio) — keeps the
 * serverless bundle small.
 *
 * Steps:
 *   1. Extract metadata (title, description, og:tags)
 *   2. Remove non-content elements (script, style, nav, footer, etc.)
 *   3. Strip HTML tags
 *   4. Normalize whitespace
 *   5. Truncate to maxContentChars
 */

import type { ExtractedContent, FetchResult } from "./types.js";

// ============================================================================
// Main Extractor
// ============================================================================

/**
 * Extract readable content from a fetch result.
 *
 * @param fetchResult - The fetched content.
 * @param maxContentChars - Maximum text length.
 * @returns Extracted content with title, description, and text.
 */
export function extractContent(
  fetchResult: FetchResult,
  maxContentChars: number,
): ExtractedContent {
  const { url, body, contentType } = fetchResult;

  // Plain text — return as-is (truncated)
  if (contentType.startsWith("text/plain")) {
    return {
      url,
      title: extractDomainTitle(url),
      description: "",
      text: truncate(body.trim(), maxContentChars),
    };
  }

  // JSON — pretty-print and return
  if (
    contentType.startsWith("application/json") ||
    contentType.startsWith("application/xml") ||
    contentType.startsWith("text/xml")
  ) {
    return {
      url,
      title: extractDomainTitle(url),
      description: "",
      text: truncate(body.trim(), maxContentChars),
    };
  }

  // HTML — extract metadata and content
  const title = extractTitle(body) || extractDomainTitle(url);
  const description = extractDescription(body);
  const text = extractTextFromHtml(body, maxContentChars);

  return { url, title, description, text };
}

// ============================================================================
// Metadata Extraction
// ============================================================================

/**
 * Extract the page title from HTML.
 * Tries (in order): og:title, <title> tag.
 */
function extractTitle(html: string): string {
  // og:title
  const ogTitle = extractMetaContent(html, "og:title");
  if (ogTitle) return decodeEntities(ogTitle);

  // <title> tag
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return decodeEntities(titleMatch[1].trim());

  return "";
}

/**
 * Extract the page description from HTML.
 * Tries: og:description, meta description.
 */
function extractDescription(html: string): string {
  const ogDesc = extractMetaContent(html, "og:description");
  if (ogDesc) return decodeEntities(ogDesc);

  const descMatch = html.match(
    /<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([\s\S]*?)["'][^>]*>/i,
  );
  if (descMatch?.[1]) return decodeEntities(descMatch[1].trim());

  // Try reversed attribute order: content before name
  const descMatch2 = html.match(
    /<meta[^>]+content\s*=\s*["']([\s\S]*?)["'][^>]+name\s*=\s*["']description["'][^>]*>/i,
  );
  if (descMatch2?.[1]) return decodeEntities(descMatch2[1].trim());

  return "";
}

/**
 * Extract content attribute from an Open Graph meta tag.
 */
function extractMetaContent(html: string, property: string): string {
  // property="og:..." content="..."
  const pattern1 = new RegExp(
    `<meta[^>]+property\\s*=\\s*["']${escapeRegex(property)}["'][^>]+content\\s*=\\s*["']([\\s\\S]*?)["'][^>]*>`,
    "i",
  );
  const match1 = html.match(pattern1);
  if (match1?.[1]) return match1[1].trim();

  // content="..." property="og:..."
  const pattern2 = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([\\s\\S]*?)["'][^>]+property\\s*=\\s*["']${escapeRegex(property)}["'][^>]*>`,
    "i",
  );
  const match2 = html.match(pattern2);
  if (match2?.[1]) return match2[1].trim();

  return "";
}

// ============================================================================
// Text Extraction
// ============================================================================

/**
 * Extract readable text from HTML.
 *
 * Strategy:
 *   1. Remove non-content elements entirely
 *   2. Convert block elements to newlines
 *   3. Strip all remaining HTML tags
 *   4. Decode HTML entities
 *   5. Normalize whitespace
 *   6. Truncate
 */
function extractTextFromHtml(html: string, maxChars: number): string {
  let text = html;

  // Remove elements that don't contain readable content
  text = removeElements(text, [
    "script",
    "style",
    "noscript",
    "iframe",
    "svg",
    "canvas",
    "nav",
    "footer",
    "header",
    "aside",
    "form",
  ]);

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Convert block elements to newlines for readability
  text = text.replace(
    /<\/?(?:p|div|br|h[1-6]|li|tr|blockquote|pre|hr|section|article|main|dd|dt)\b[^>]*>/gi,
    "\n",
  );

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  text = decodeEntities(text);

  // Normalize whitespace
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  // Collapse multiple blank lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return truncate(text.trim(), maxChars);
}

/**
 * Remove specified HTML elements and their content.
 */
function removeElements(html: string, tags: string[]): string {
  let result = html;
  for (const tag of tags) {
    const pattern = new RegExp(
      `<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`,
      "gi",
    );
    result = result.replace(pattern, "");
  }
  return result;
}

// ============================================================================
// Helpers
// ============================================================================

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode common HTML entities in one pass, so "&amp;lt;" becomes "&lt;"
 * rather than "<".
 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-z]+));/gi,
    (match, dec?: string, hex?: string, name?: string) => {
      if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
      const code = dec ? Number(dec) : parseInt(hex!, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    },
  );
}

/**
 * Extract a readable title from a URL's domain.
 */
function extractDomainTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
