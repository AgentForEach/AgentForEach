/**
 * AgentForEach Link Understanding — Content Fetcher
 *
 * Fetches URL content with safety guardrails:
 *   - SSRF protection via safeFetch (connect-time address checks, every
 *     redirect hop re-validated, max 5)
 *   - Timeout
 *   - Content-Type filtering (only text/html, text/plain, application/json)
 *   - Body size limiting (1MB max)
 */

import { isSsrfBlocked, readBodyText, safeFetch } from "../utils/safe-fetch.js";
import { validateUrl } from "./ssrf-guard.js";
import type { FetchResult, LinkUnderstandingConfig } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum body size to read (1MB) — default. */
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** Content types we'll process — defaults. */
const DEFAULT_ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
];

// ============================================================================
// Fetcher
// ============================================================================

/**
 * Fetch a URL's content with safety guardrails.
 *
 * @param url - The URL to fetch.
 * @param config - Link understanding configuration.
 * @returns FetchResult with body text or error.
 */
export async function fetchUrlContent(
  url: string,
  config: LinkUnderstandingConfig,
): Promise<FetchResult> {
  // Cheap pre-check; safeFetch re-checks every address it connects to.
  const ssrfCheck = validateUrl(url);
  if (!ssrfCheck.valid) {
    return {
      url,
      status: 0,
      contentType: "",
      body: "",
      ok: false,
      error: `SSRF blocked: ${ssrfCheck.reason}`,
    };
  }

  try {
    const response = await safeFetch(url, {
      timeoutMs: config.fetchTimeoutMs,
      headers: {
        "User-Agent": config.userAgent,
        Accept: "text/html, text/plain, application/json, */*;q=0.1",
      },
    });

    // Check Content-Type
    const contentType = response.headers.get("content-type") ?? "";
    const mimeType = contentType.split(";")[0]!.trim().toLowerCase();

    const allowedContentTypes = config.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
    if (!allowedContentTypes.some((allowed) => mimeType.startsWith(allowed))) {
      await response.body?.cancel().catch(() => {});
      return {
        url,
        status: response.status,
        contentType: mimeType,
        body: "",
        ok: false,
        error: `Unsupported content type: ${mimeType}`,
      };
    }

    // Read body with size limit
    const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const { text: body } = await readBodyText(response, maxBodyBytes);

    return {
      url,
      status: response.status,
      contentType: mimeType,
      body,
      ok: response.ok,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err) {
    let message: string;
    if (isSsrfBlocked(err)) {
      message = err.cause instanceof Error ? err.cause.message : err.message;
    } else if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      message = `Fetch timeout (${config.fetchTimeoutMs}ms)`;
    } else {
      message = err instanceof Error ? err.message : String(err);
    }

    return {
      url,
      status: 0,
      contentType: "",
      body: "",
      ok: false,
      error: message,
    };
  }
}
