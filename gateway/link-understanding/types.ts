/**
 * AgentForEach Link Understanding — Types
 *
 * Type definitions for URL detection, content fetching, and extraction.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface LinkUnderstandingConfig {
  /** Enable link understanding. Default: false. */
  enabled: boolean;
  /** Maximum number of URLs to process per message. Default: 3. */
  maxUrls: number;
  /** Fetch timeout in milliseconds. Default: 8000. */
  fetchTimeoutMs: number;
  /** Maximum extracted content length in characters. Default: 6000. */
  maxContentChars: number;
  /** User-Agent header for fetches. */
  userAgent: string;
  /** Maximum body size to read in bytes. Default: 1048576 (1MB). */
  maxBodyBytes?: number;
  /** Content types allowed for processing. Defaults to common text types. */
  allowedContentTypes?: string[];
}

// ============================================================================
// Fetch Results
// ============================================================================

export interface FetchResult {
  /** The fetched URL. */
  url: string;
  /** HTTP status code. */
  status: number;
  /** Content-Type header value. */
  contentType: string;
  /** Raw body text (HTML, plain text, or JSON). */
  body: string;
  /** Whether the fetch succeeded. */
  ok: boolean;
  /** Error message if fetch failed. */
  error?: string;
}

// ============================================================================
// Extracted Content
// ============================================================================

export interface ExtractedContent {
  /** The source URL. */
  url: string;
  /** Page title (from <title> or og:title). */
  title: string;
  /** Meta description (from <meta description> or og:description). */
  description: string;
  /** Extracted readable text content, truncated to maxContentChars. */
  text: string;
}

// ============================================================================
// Resolution Result
// ============================================================================

export interface LinkResolutionResult {
  /** URLs that were detected in the message. */
  detectedUrls: string[];
  /** Successfully resolved content. */
  resolved: ExtractedContent[];
  /** Formatted context block to inject into the prompt. */
  contextBlock: string;
}
