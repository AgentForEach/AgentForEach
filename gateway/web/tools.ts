/**
 * AgentForEach Web Layer — Tool Definitions & Handler
 *
 * Defines `web_search` and `web_fetch` as function-type tools for the LLM.
 *
 * - `web_search`: Searches the web via Tavily, Brave, Perplexity, or Grok.
 * - `web_fetch`: Fetches and extracts readable content from a URL.
 *
 * Reuses SSRF protection and content extraction from link-understanding/.
 * All external content is wrapped in security boundaries before returning
 * to the LLM to mitigate prompt injection from web pages.
 */

import type { ToolDefinition } from "../memory/types.js";
import type { LinkUnderstandingConfig } from "../link-understanding/types.js";
import { fetchUrlContent } from "../link-understanding/fetch.js";
import { extractContent } from "../link-understanding/extract.js";
import { wrapExternalContent } from "../utils/external-content.js";
import { sharedRateLimiter, type RateLimiter } from "../ratelimit/index.js";
import type {
  WebConfig,
  SearchProvider,
  BraveSearchResponse,
  PerplexitySearchResponse,
  GrokSearchResponse,
  GrokOutputBlock,
  TavilySearchResponse,
} from "./types.js";

// ============================================================================
// Tool Names
// ============================================================================

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_FETCH_TOOL_NAME = "web_fetch";

// ============================================================================
// Tool Definitions
// ============================================================================

export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: "function",
  name: WEB_SEARCH_TOOL_NAME,
  description:
    "Search the web for current information. Returns relevant web results " +
    "or an AI-synthesized answer with citations depending on the configured provider. " +
    "Use this when the user asks about recent events, current data, or anything that " +
    "may require up-to-date information beyond your training data.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Be specific for better results.",
      },
      q: {
        type: "string",
        description: "Alias for query.",
      },
      count: {
        type: "number",
        description: "Number of results to return (1-10). Default: 5. Applies to Brave only.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export const WEB_FETCH_TOOL: ToolDefinition = {
  type: "function",
  name: WEB_FETCH_TOOL_NAME,
  description:
    "Fetch and extract readable content from a URL. Returns the page title, description, " +
    "and main text content. Use this to read articles, documentation, or any web page " +
    "the user shares or that appeared in search results.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch. Must be a valid HTTP or HTTPS URL.",
      },
      extract_content: {
        type: "string",
        description:
          'Whether to extract readable text from HTML. Default: "true". ' +
          'Set to "false" to return raw body text.',
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

/**
 * Get all web tool definitions for registration with the LLM.
 */
export function getWebToolDefinitions(): ToolDefinition[] {
  return [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
}

/**
 * Check if a tool name is a web tool.
 */
export function isWebTool(toolName: string): boolean {
  return toolName === WEB_SEARCH_TOOL_NAME || toolName === WEB_FETCH_TOOL_NAME;
}

// ============================================================================
// In-Memory Cache
// ============================================================================

interface CacheEntry {
  value: string;
  expiresAt: number;
}

class SimpleCache {
  private store = new Map<string, CacheEntry>();
  private enabled: boolean;
  private ttlMs: number;
  private maxEntries: number;

  constructor(config: WebConfig["cache"]) {
    this.enabled = config.enabled;
    this.ttlMs = config.ttlMs;
    this.maxEntries = config.maxEntries;
  }

  get(key: string): string | undefined {
    if (!this.enabled) return undefined;

    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: string): void {
    if (!this.enabled) return;

    // Evict oldest entries if at capacity
    if (this.store.size >= this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

// ============================================================================
// Search Rate Limiter
// ============================================================================

/**
 * The in-process part of web search's limits: per-session counts and a
 * per-handler cooldown between calls. The per-user daily limit, which caps a
 * paid search API's use, is counted in storage (see WebToolHandler), so it
 * holds across instances and Worker isolates.
 */
class SearchRateLimiter {
  private sessionCounts = new Map<string, number>();
  private lastCallMs = 0;
  private limits: WebConfig["rateLimit"];

  constructor(limits: WebConfig["rateLimit"]) {
    this.limits = limits;
  }

  /**
   * Check if a search call is allowed. Returns null if OK, or an error string.
   */
  check(userId: string, sessionId?: string): string | null {
    const now = Date.now();

    // Cooldown check
    if (this.limits.cooldownMs > 0 && now - this.lastCallMs < this.limits.cooldownMs) {
      return "Rate limit: please wait a moment before searching again.";
    }

    // Per-session check
    if (sessionId && this.limits.maxPerSession > 0) {
      const count = this.sessionCounts.get(sessionId) ?? 0;
      if (count >= this.limits.maxPerSession) {
        return `Rate limit: maximum ${this.limits.maxPerSession} searches per session reached.`;
      }
    }

    return null;
  }

  /**
   * Record a successful search call.
   */
  record(userId: string, sessionId?: string): void {
    this.lastCallMs = Date.now();

    if (sessionId) {
      this.sessionCounts.set(sessionId, (this.sessionCounts.get(sessionId) ?? 0) + 1);
    }
  }
}

// ============================================================================
// Tool Handler
// ============================================================================

/**
 * Handler for web_search and web_fetch tool calls.
 *
 * Supports four search providers:
 *   - Tavily — agent-optimized results with optional LLM answer (default)
 *   - Brave Search — traditional search results (titles, URLs, snippets)
 *   - Perplexity — AI-synthesized answer with citations
 *   - Grok (xAI) — AI-synthesized answer with citations
 *
 * Supports failover: if the primary provider fails, tries the next
 * provider in the configured chain.
 *
 * Follows the same pattern as MemoryToolHandler:
 *   - Constructor takes config
 *   - `handle()` dispatches by tool name
 *   - Returns string result for the LLM
 */
export class WebToolHandler {
  private config: WebConfig;
  private cache: SimpleCache;
  private rateLimiter: SearchRateLimiter;
  /** web.rateLimit.maxPerUserDaily, counted in storage; undefined when 0 (no limit). */
  private readonly dailyLimiter: (() => RateLimiter) | undefined;

  /** @param options.dailyLimiter The per-user daily counter (default: the shared one, in storage). */
  constructor(config: WebConfig, options: { dailyLimiter?: RateLimiter } = {}) {
    this.config = config;
    this.cache = new SimpleCache(config.cache);
    this.rateLimiter = new SearchRateLimiter(config.rateLimit);
    const perDay = config.rateLimit.maxPerUserDaily;
    if (perDay > 0) {
      this.dailyLimiter = () => options.dailyLimiter ?? sharedRateLimiter("search", { perMinute: 0, perDay });
    }
  }

  /**
   * Handle a web tool call from the LLM.
   *
   * @param toolName - "web_search" or "web_fetch"
   * @param args - Parsed arguments from the model.
   * @param userId - The user id for rate limiting.
   * @param sessionId - Optional session id for per-session limits.
   * @returns String result to feed back as function output.
   */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
    sessionId?: string,
  ): Promise<string> {
    switch (toolName) {
      case WEB_SEARCH_TOOL_NAME: {
        // Rate limit web_search only (not web_fetch)
        const limitError = this.rateLimiter.check(userId, sessionId);
        if (limitError) return limitError;
        // Counts the attempt: a search that then fails still used the API.
        if (this.dailyLimiter && !(await this.dailyLimiter().check(userId)).allowed) {
          return `Rate limit: maximum ${this.config.rateLimit.maxPerUserDaily} searches per day reached.`;
        }

        const result = await this.handleSearch(args);

        // Only count successful calls (not cache hits that start with the same prefix)
        if (!result.startsWith("Error:") && !result.startsWith("Rate limit:")) {
          this.rateLimiter.record(userId, sessionId);
        }

        return result;
      }
      case WEB_FETCH_TOOL_NAME:
        return this.handleFetch(args);
      default:
        return `Unknown web tool: ${toolName}`;
    }
  }

  // --------------------------------------------------------------------------
  // web_search — Provider Dispatch (with failover)
  // --------------------------------------------------------------------------

  private async handleSearch(args: Record<string, unknown>): Promise<string> {
    const query = pickStringArg(args, ["query", "q"]);
    if (!query) return "Error: query is required.";

    const { failover } = this.config.search;

    // If failover is enabled, try each provider in the chain
    if (failover.enabled && failover.chain.length > 0) {
      const errors: string[] = [];

      for (const provider of failover.chain) {
        const result = await this.dispatchSearch(provider, query, args);

        // If result is not an error, return it
        if (!result.startsWith("Error:")) {
          return result;
        }

        errors.push(`${provider}: ${result}`);
      }

      // All providers failed
      return `Error: all search providers failed.\n${errors.join("\n")}`;
    }

    // No failover — use the configured primary provider
    return this.dispatchSearch(this.config.search.provider, query, args);
  }

  /**
   * Dispatch a search to a specific provider.
   */
  private dispatchSearch(
    provider: SearchProvider,
    query: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (provider) {
      case "tavily":
        return this.searchTavily(query, args);
      case "perplexity":
        return this.searchPerplexity(query);
      case "grok":
        return this.searchGrok(query);
      case "brave":
      default:
        return this.searchBrave(query, args);
    }
  }

  // --------------------------------------------------------------------------
  // Tavily Search
  // --------------------------------------------------------------------------

  private async searchTavily(
    query: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const { tavily } = this.config.search;
    const countRaw = pickNumberArg(args, ["count"]);
    const maxResults = Math.min(Math.max(1, countRaw ?? this.config.search.maxResults), 20);

    // Check cache
    const cacheKey = `tavily:${query}:${maxResults}:${tavily.searchDepth}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!tavily.apiKey) {
      return "Error: Tavily is not configured. Set TAVILY_API_KEY or configure search.tavily.apiKey.";
    }

    try {
      const body: Record<string, unknown> = {
        query,
        max_results: maxResults,
        search_depth: tavily.searchDepth,
        topic: tavily.topic,
        include_answer: tavily.includeAnswer,
      };

      if (tavily.includeRawContent) {
        body.include_raw_content = tavily.includeRawContent;
      }
      if (tavily.country) {
        body.country = tavily.country;
      }

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tavily.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return `Error: Tavily returned HTTP ${response.status}. ${response.statusText}`;
      }

      const data = (await response.json()) as TavilySearchResponse;

      const parts: string[] = [];

      // Include the LLM-generated answer if present
      if (data.answer) {
        parts.push(`Answer: ${data.answer}`);
        parts.push("");
      }

      // Include search results
      if (data.results && data.results.length > 0) {
        parts.push(`Results (${data.results.length}):`);
        for (const [i, r] of data.results.entries()) {
          const lines = [`[${i + 1}] ${r.title}`, `    URL: ${r.url}`];
          if (r.content) {
            lines.push(`    ${r.content}`);
          }
          if (r.score != null) {
            lines.push(`    Relevance: ${(r.score * 100).toFixed(0)}%`);
          }
          parts.push(lines.join("\n"));
        }
      } else if (!data.answer) {
        return `No results from Tavily for "${query}".`;
      }

      const formatted = wrapExternalContent(
        parts.join("\n\n"),
        `Tavily Search: "${query}"`,
      );

      const result = data.answer
        ? `Tavily answer + ${data.results?.length ?? 0} results for "${query}":\n\n${formatted}`
        : `Found ${data.results.length} results for "${query}":\n\n${formatted}`;

      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: Tavily search failed — ${message}`;
    }
  }

  // --------------------------------------------------------------------------
  // Brave Search
  // --------------------------------------------------------------------------

  private async searchBrave(
    query: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const countRaw = pickNumberArg(args, ["count"]);
    const count = Math.min(Math.max(1, countRaw ?? this.config.search.maxResults), 10);

    // Check cache
    const cacheKey = `brave:${query}:${count}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!this.config.search.apiKey) {
      return "Error: Brave Search is not configured. Set BRAVE_SEARCH_API_KEY.";
    }

    try {
      const params = new URLSearchParams({
        q: query,
        count: String(count),
        safesearch: this.config.search.safesearch,
      });

      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": this.config.search.apiKey,
          },
        },
      );

      if (!response.ok) {
        return `Error: Brave Search returned HTTP ${response.status}. ${response.statusText}`;
      }

      const data = (await response.json()) as BraveSearchResponse;
      const results = data.web?.results ?? [];

      if (results.length === 0) {
        return `No web results found for "${query}".`;
      }

      const lines = results.map((r, i) => {
        const parts = [`[${i + 1}] ${r.title}`, `    URL: ${r.url}`];
        if (r.description) {
          parts.push(`    ${r.description}`);
        }
        return parts.join("\n");
      });

      const formatted = wrapExternalContent(
        lines.join("\n\n"),
        `Brave Search: "${query}"`,
      );

      const result = `Found ${results.length} web results for "${query}":\n\n${formatted}`;
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: Brave Search failed — ${message}`;
    }
  }

  // --------------------------------------------------------------------------
  // Perplexity Search (Chat Completions API)
  // --------------------------------------------------------------------------

  private async searchPerplexity(query: string): Promise<string> {
    const { perplexity } = this.config.search;

    // Check cache
    const cacheKey = `perplexity:${query}:${perplexity.model}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!perplexity.apiKey) {
      return "Error: Perplexity is not configured. Set PERPLEXITY_API_KEY or configure search.perplexity.apiKey.";
    }

    // Determine model name — strip "perplexity/" prefix for direct API
    const model = perplexity.baseUrl.includes("openrouter")
      ? `perplexity/${perplexity.model}`
      : perplexity.model;

    try {
      const response = await fetch(
        `${perplexity.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${perplexity.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: query }],
          }),
        },
      );

      if (!response.ok) {
        return `Error: Perplexity returned HTTP ${response.status}. ${response.statusText}`;
      }

      const data = (await response.json()) as PerplexitySearchResponse;
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        return `No results from Perplexity for "${query}".`;
      }

      // Build result with answer + citations
      const parts: string[] = [content];

      if (data.citations && data.citations.length > 0) {
        parts.push("");
        parts.push("Sources:");
        data.citations.forEach((url, i) => {
          parts.push(`  [${i + 1}] ${url}`);
        });
      }

      const formatted = wrapExternalContent(
        parts.join("\n"),
        `Perplexity Search: "${query}"`,
      );

      const result = `Perplexity answer for "${query}":\n\n${formatted}`;
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: Perplexity search failed — ${message}`;
    }
  }

  // --------------------------------------------------------------------------
  // Grok Search (xAI Responses API)
  // --------------------------------------------------------------------------

  private async searchGrok(query: string): Promise<string> {
    const { grok } = this.config.search;

    // Check cache
    const cacheKey = `grok:${query}:${grok.model}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (!grok.apiKey) {
      return "Error: Grok is not configured. Set XAI_API_KEY or configure search.grok.apiKey.";
    }

    try {
      const response = await fetch(
        "https://api.x.ai/v1/responses",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${grok.apiKey}`,
          },
          body: JSON.stringify({
            model: grok.model,
            input: [{ role: "user", content: query }],
            tools: [{ type: "web_search" }],
          }),
        },
      );

      if (!response.ok) {
        return `Error: Grok returned HTTP ${response.status}. ${response.statusText}`;
      }

      const data = (await response.json()) as GrokSearchResponse;
      const { content, citations } = extractGrokContent(data);

      if (!content) {
        return `No results from Grok for "${query}".`;
      }

      // Build result with answer + citations
      const parts: string[] = [content];

      if (citations.length > 0) {
        parts.push("");
        parts.push("Sources:");
        citations.forEach((url, i) => {
          parts.push(`  [${i + 1}] ${url}`);
        });
      }

      const formatted = wrapExternalContent(
        parts.join("\n"),
        `Grok Search: "${query}"`,
      );

      const result = `Grok answer for "${query}":\n\n${formatted}`;
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: Grok search failed — ${message}`;
    }
  }

  // --------------------------------------------------------------------------
  // web_fetch — URL Content Fetching (reuses link-understanding)
  // --------------------------------------------------------------------------

  private async handleFetch(args: Record<string, unknown>): Promise<string> {
    const url = pickStringArg(args, ["url"]);
    if (!url) return "Error: url is required.";

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return `Error: invalid URL — "${url}"`;
    }

    const extractFlag = pickStringArg(args, ["extract_content"]);
    const shouldExtract = extractFlag !== "false";

    // Check cache
    const cacheKey = `fetch:${url}:${shouldExtract}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      // Build a LinkUnderstandingConfig from our web fetch config
      // This lets us reuse the full fetch pipeline (SSRF protection, timeout, etc.)
      const linkConfig: LinkUnderstandingConfig = {
        enabled: true,
        maxUrls: 1,
        fetchTimeoutMs: this.config.fetch.timeoutMs,
        maxContentChars: this.config.fetch.maxContentChars,
        userAgent: this.config.fetch.userAgent,
      };

      const fetchResult = await fetchUrlContent(url, linkConfig);

      if (!fetchResult.ok) {
        return `Error: failed to fetch "${url}" — ${fetchResult.error}`;
      }

      let result: string;

      if (shouldExtract) {
        // Extract readable content (HTML → text, metadata)
        const extracted = extractContent(fetchResult, this.config.fetch.maxContentChars);

        const parts: string[] = [];
        parts.push(`URL: ${extracted.url}`);
        if (extracted.title) parts.push(`Title: ${extracted.title}`);
        if (extracted.description) parts.push(`Description: ${extracted.description}`);
        parts.push("---");
        parts.push(extracted.text);

        result = wrapExternalContent(parts.join("\n"), url);
      } else {
        // Return raw body (still wrapped for safety)
        const truncated =
          fetchResult.body.length > this.config.fetch.maxContentChars
            ? fetchResult.body.slice(0, this.config.fetch.maxContentChars) + "...[truncated]"
            : fetchResult.body;

        result = wrapExternalContent(truncated, url);
      }

      // Cache the result
      this.cache.set(cacheKey, result);

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: failed to fetch "${url}" — ${message}`;
    }
  }
}

// ============================================================================
// Grok Response Parser
// ============================================================================

/**
 * Extract content and citations from a Grok Responses API response.
 *
 * The Grok API returns a complex nested structure. This function navigates:
 *   1. output[].content[] where type === "output_text" (primary)
 *   2. output[] where type === "output_text" (top-level blocks)
 *   3. data.output_text (deprecated fallback)
 *
 * Citations are extracted from annotations (type === "url_citation")
 * or the top-level citations array.
 */
function extractGrokContent(data: GrokSearchResponse): {
  content: string;
  citations: string[];
} {
  const citations = new Set<string>();

  // Try top-level citations first
  if (data.citations) {
    for (const url of data.citations) {
      if (url) citations.add(url);
    }
  }

  // Strategy 1: Look for message output with content blocks
  if (data.output) {
    for (const block of data.output) {
      if (block.type === "message" && block.content) {
        for (const contentBlock of block.content) {
          if (contentBlock.type === "output_text" && contentBlock.text) {
            // Extract annotations from content blocks
            collectAnnotationUrls(contentBlock.annotations, citations);
            collectAnnotationUrls(block.annotations, citations);
            return { content: contentBlock.text, citations: [...citations] };
          }
        }
      }
    }

    // Strategy 2: Top-level output_text blocks
    for (const block of data.output) {
      if (block.type === "output_text" && block.text) {
        collectAnnotationUrls(block.annotations, citations);
        return { content: block.text, citations: [...citations] };
      }
    }
  }

  // Strategy 3: Deprecated output_text field
  if (data.output_text) {
    return { content: data.output_text, citations: [...citations] };
  }

  return { content: "", citations: [...citations] };
}

/**
 * Collect URLs from annotation arrays (url_citation type).
 */
function collectAnnotationUrls(
  annotations: GrokOutputBlock["annotations"],
  urls: Set<string>,
): void {
  if (!annotations) return;
  for (const ann of annotations) {
    if (ann.type === "url_citation" && ann.url) {
      urls.add(ann.url);
    }
  }
}

// ============================================================================
// Argument Helpers
// ============================================================================

/**
 * Pick the first non-empty string value from a list of possible argument keys.
 */
function pickStringArg(
  args: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/**
 * Pick the first valid number value from a list of possible argument keys.
 */
function pickNumberArg(
  args: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
