/**
 * AgentForEach Link Understanding — Content Extraction
 *
 * Extracts readable text from HTML with small linear scanners.
 * No heavy DOM dependency (no jsdom, no cheerio) — keeps the
 * serverless bundle small.
 *
 * Steps:
 *   1. Extract metadata (title, description, og:tags)
 *   2. Remove comments and non-content elements (script, style, nav, …)
 *   3. Strip the remaining tags, block elements becoming newlines
 *   4. Decode entities and normalize whitespace
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
  const metas = parseMetaTags(body);
  const title = extractTitle(body, metas) || extractDomainTitle(url);
  const description = extractDescription(metas);
  const text = extractTextFromHtml(body, maxContentChars);

  return { url, title, description, text };
}

// ============================================================================
// Metadata Extraction
// ============================================================================
//
// Every scan below is linear in the page size. Fetched pages are attacker
// controlled (up to 1 MB), and a backtracking regex over them blocks the
// shared worker for every user on the instance.

/**
 * Extract the page title from HTML.
 * Tries (in order): og:title, <title> tag.
 */
function extractTitle(html: string, metas: MetaTag[]): string {
  const ogTitle = metaContent(metas, "property", "og:title");
  if (ogTitle) return decodeEntities(ogTitle);

  const open = indexOfTag(html, "title", 0);
  if (open === -1) return "";
  const openEnd = html.indexOf(">", open);
  if (openEnd === -1) return "";
  const close = indexOfCI(html, "</title", openEnd + 1);
  if (close === -1) return "";
  return decodeEntities(html.slice(openEnd + 1, close).trim());
}

/**
 * Extract the page description from HTML.
 * Tries: og:description, meta description.
 */
function extractDescription(metas: MetaTag[]): string {
  const desc =
    metaContent(metas, "property", "og:description") ||
    metaContent(metas, "name", "description");
  return desc ? decodeEntities(desc) : "";
}

type MetaTag = Map<string, string>;

/** The attributes of every <meta> tag, in document order. */
function parseMetaTags(html: string): MetaTag[] {
  const tags: MetaTag[] = [];
  let i = 0;
  while ((i = indexOfTag(html, "meta", i)) !== -1) {
    const end = findTagEnd(html, i + 5);
    // An unterminated tag runs to the end of the page; nothing after it is a tag.
    if (end === -1) break;
    tags.push(parseAttributes(html.slice(i + 5, end)));
    i = end + 1;
  }
  return tags;
}

function metaContent(metas: MetaTag[], key: string, value: string): string {
  for (const attrs of metas) {
    if (attrs.get(key)?.toLowerCase() === value) return attrs.get("content")?.trim() ?? "";
  }
  return "";
}

/**
 * Index of the ">" that ends a tag, skipping quoted attribute values; -1 if
 * none. A quote opens a value only right after "=" (as in HTML): in
 * `class=x'y` it's part of the unquoted value.
 */
function findTagEnd(html: string, from: number): number {
  let quote = "";
  let afterEquals = false;
  for (let i = from; i < html.length; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if ((c === '"' || c === "'") && afterEquals) {
      quote = c;
    } else if (c === ">") {
      return i;
    }
    if (!isSpace(c)) afterEquals = c === "=";
  }
  return -1;
}

/** Parse `name="value" name='value' name=value name` into a map (first wins). */
function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const n = source.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(source[i]!) || source[i] === "/")) i++;
    const nameStart = i;
    while (i < n && !isSpace(source[i]!) && source[i] !== "=" && source[i] !== "/") i++;
    const name = source.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(source[i]!)) i++;
    let value = "";
    if (source[i] === "=") {
      i++;
      while (i < n && isSpace(source[i]!)) i++;
      const quote = source[i];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, i + 1);
        const stop = close === -1 ? n : close;
        value = source.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(source[i]!)) i++;
        value = source.slice(valueStart, i);
      }
    }
    if (name && !attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

// ============================================================================
// Text Extraction
// ============================================================================

/** Elements whose content is never readable text. */
const SKIPPED_ELEMENTS = new Set([
  "script", "style", "noscript", "iframe", "svg", "canvas",
  "nav", "footer", "header", "aside", "form",
]);

/**
 * Of those, the ones whose content a browser never parses as HTML: unclosed,
 * they run to the end of the page. Any other unclosed element is just a tag.
 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript", "iframe"]);

/** Elements that start a new line. */
const BLOCK_ELEMENTS = new Set([
  "p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr",
  "blockquote", "pre", "hr", "section", "article", "main", "dd", "dt",
]);

/**
 * Extract readable text from HTML in one pass: drop comments, doctypes and
 * non-content elements, turn block elements into newlines and other tags
 * into spaces; then decode entities, normalise whitespace and truncate.
 */
function extractTextFromHtml(html: string, maxChars: number): string {
  const parts: string[] = [];
  const n = html.length;
  let i = 0;
  // The next "</name" for each element name, from the last search (-1: none
  // left). Searches only move forward, so thousands of unclosed tags of one
  // name still cost one pass.
  const nextClose = new Map<string, number>();
  const findClose = (name: string, from: number): number => {
    const known = nextClose.get(name);
    if (known !== undefined && (known === -1 || known >= from)) return known;
    const found = indexOfTag(html, `/${name}`, from);
    nextClose.set(name, found);
    return found;
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break; // an unclosed comment hides the rest, as in a browser
      i = end + 3;
      continue;
    }

    const next = html[lt + 1] ?? "";
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt);
      if (end === -1) break;
      i = end + 1;
      continue;
    }

    const closing = next === "/";
    const nameStart = closing ? lt + 2 : lt + 1;
    let nameEnd = nameStart;
    while (nameEnd < n && isTagNameChar(html[nameEnd]!, nameEnd === nameStart)) nameEnd++;
    if (nameEnd === nameStart) {
      // "<" not followed by a tag name is text ("1 < 2").
      parts.push("<");
      i = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const end = findTagEnd(html, nameEnd);
    if (end === -1) break; // an unterminated tag runs to the end of the page

    const selfClosing = html[end - 1] === "/";
    if (!closing && !selfClosing && SKIPPED_ELEMENTS.has(name)) {
      const close = findClose(name, end + 1);
      const closeEnd = close === -1 ? -1 : html.indexOf(">", close);
      if (closeEnd !== -1) {
        parts.push(" ");
        i = closeEnd + 1;
        continue;
      }
      // Unclosed: a script or style swallows the rest, as in a browser.
      if (RAW_TEXT_ELEMENTS.has(name)) break;
    }

    parts.push(BLOCK_ELEMENTS.has(name) ? "\n" : " ");
    i = end + 1;
  }

  const text = decodeEntities(parts.join(""))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return truncate(text.trim(), maxChars);
}

// ============================================================================
// Scanning
// ============================================================================

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
}

function isTagNameChar(c: string, first: boolean): boolean {
  const code = c.charCodeAt(0) | 0x20; // ASCII lower case
  if (code >= 0x61 && code <= 0x7a) return true;
  return !first && ((c >= "0" && c <= "9") || c === "-");
}

/** Case-insensitive indexOf for an ASCII needle (a literal search, so linear). */
function indexOfCI(haystack: string, needle: string, from: number): number {
  const pattern = new RegExp(escapeRegex(needle), "gi");
  pattern.lastIndex = from;
  return pattern.exec(haystack)?.index ?? -1;
}

/** Index of the next `<name` start tag at or after `from` (not `<names...`). */
function indexOfTag(html: string, name: string, from: number): number {
  let i = from;
  while ((i = indexOfCI(html, `<${name}`, i)) !== -1) {
    const after = html[i + name.length + 1] ?? "";
    if (after === "" || after === ">" || after === "/" || isSpace(after)) return i;
    i += name.length + 1;
  }
  return -1;
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
