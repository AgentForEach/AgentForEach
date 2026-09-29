/**
 * AgentForEach Link Understanding — Barrel Exports
 *
 * Public API for the link understanding subsystem.
 * Detects URLs in user messages, fetches their content, extracts
 * readable text, and formats a context block for prompt injection.
 */

// Types
export type {
  LinkUnderstandingConfig,
  FetchResult,
  ExtractedContent,
  LinkResolutionResult,
} from "./types.js";

// Config
export { loadLinkConfig, resetLinkConfig } from "./config.js";

// Detection
export { detectUrls } from "./detect.js";

// SSRF Guard
export { validateUrl } from "./ssrf-guard.js";

// Fetch
export { fetchUrlContent } from "./fetch.js";

// Extract
export { extractContent } from "./extract.js";

// ============================================================================
// High-level API — resolveLinks()
// ============================================================================

import { detectUrls } from "./detect.js";
import { fetchUrlContent } from "./fetch.js";
import { extractContent } from "./extract.js";
import type { LinkUnderstandingConfig, ExtractedContent, LinkResolutionResult } from "./types.js";

/**
 * Resolve all links in a user message.
 *
 * This is the main entry point used by the runner pipeline.
 * Detects URLs, fetches them in parallel, extracts content,
 * and formats a context block for injection into the system prompt.
 *
 * @param message - The user's message text.
 * @param config - Link understanding configuration.
 * @returns Resolution result with detected URLs, extracted content, and formatted context.
 */
export async function resolveLinks(
  message: string,
  config: LinkUnderstandingConfig,
): Promise<LinkResolutionResult> {
  // Detect URLs in the message
  const detectedUrls = detectUrls(message, config.maxUrls);

  if (detectedUrls.length === 0) {
    return { detectedUrls: [], resolved: [], contextBlock: "" };
  }

  // Fetch all URLs in parallel (non-fatal failures are filtered out)
  const fetchResults = await Promise.allSettled(
    detectedUrls.map((url) => fetchUrlContent(url, config)),
  );

  // Extract content from successful fetches
  const resolved: ExtractedContent[] = [];

  for (const result of fetchResults) {
    if (result.status === "rejected") continue;
    const fetchResult = result.value;
    if (!fetchResult.ok) continue;

    const extracted = extractContent(fetchResult, config.maxContentChars);
    if (extracted.text.trim().length > 0) {
      resolved.push(extracted);
    }
  }

  if (resolved.length === 0) {
    return { detectedUrls, resolved: [], contextBlock: "" };
  }

  // Format the context block
  const contextBlock = formatContextBlock(resolved);

  return { detectedUrls, resolved, contextBlock };
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format extracted content into a context block for prompt injection.
 */
function formatContextBlock(contents: ExtractedContent[]): string {
  const entries = contents.map((content, i) => {
    const parts = [`[${i + 1}] ${content.url}`];
    if (content.title) parts.push(`Title: ${content.title}`);
    if (content.description) parts.push(`Description: ${content.description}`);
    parts.push("---");
    parts.push(content.text);
    return parts.join("\n");
  });

  return [
    "<link-context>",
    "The user shared the following links. Here is their content:",
    "",
    entries.join("\n\n"),
    "</link-context>",
  ].join("\n");
}
