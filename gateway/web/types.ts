/**
 * AgentForEach Web Layer — Type Definitions
 *
 * Configuration and result types for the web_search and web_fetch tools.
 * Supports four search providers: Tavily, Brave, Perplexity, and Grok.
 */

// ============================================================================
// Search Provider Type
// ============================================================================

export type SearchProvider = "tavily" | "brave" | "perplexity" | "grok";

// ============================================================================
// agentforeach.json "web" Section Shape
// ============================================================================

/**
 * Configuration shape as stored in agentforeach.json "web" section.
 */
export interface WebJsonConfig {
  /** Enable/disable web tools entirely. Default: false. */
  enabled?: boolean;

  /** Web search configuration. */
  search?: {
    /** Search provider: "tavily", "brave", "perplexity", or "grok". Default: "tavily". */
    provider?: SearchProvider;
    /** API key for the search provider (env-resolved). Used for Brave. */
    apiKey?: string;
    /** Maximum number of search results to return. Default: 5. */
    maxResults?: number;
    /** Safe search level (Brave only). Default: "moderate". */
    safesearch?: "off" | "moderate" | "strict";

    /** Tavily-specific configuration. */
    tavily?: {
      /** API key (env-resolved). Falls back to $TAVILY_API_KEY. */
      apiKey?: string;
      /** Search depth: "basic", "advanced", "fast", or "ultra-fast". Default: "basic". */
      searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
      /** Topic category. Default: "general". */
      topic?: "general" | "news" | "finance";
      /** Include an LLM-generated answer. Default: "basic". */
      includeAnswer?: boolean | "basic" | "advanced";
      /** Include cleaned page content in results. Default: false. */
      includeRawContent?: boolean | "markdown" | "text";
      /** Country to boost results from. */
      country?: string;
    };

    /** Perplexity-specific configuration. */
    perplexity?: {
      /** API key (env-resolved). Falls back to $PERPLEXITY_API_KEY or $OPENROUTER_API_KEY. */
      apiKey?: string;
      /** Base URL. Auto-detected from API key prefix if not set. */
      baseUrl?: string;
      /** Model name. Default: "sonar-pro". */
      model?: string;
    };

    /** Grok-specific configuration. */
    grok?: {
      /** API key (env-resolved). Falls back to $XAI_API_KEY. */
      apiKey?: string;
      /** Model name. Default: "grok-3-fast". */
      model?: string;
    };

    /** Failover chain for search providers. Tried in order on error. */
    failover?: {
      /** Enable failover. Default: false. */
      enabled?: boolean;
      /** Ordered list of providers to try. Default: ["tavily", "brave"]. */
      chain?: SearchProvider[];
    };
  };

  /** Rate limiting for web search calls. */
  rateLimit?: {
    /** Max web_search calls per session. Default: 10. */
    maxPerSession?: number;
    /** Max web_search calls per user per day. Default: 50. */
    maxPerUserDaily?: number;
    /** Minimum ms between consecutive search calls. Default: 2000. */
    cooldownMs?: number;
  };

  /** Web fetch configuration. */
  fetch?: {
    /** Fetch timeout in milliseconds. Default: 10000. */
    timeoutMs?: number;
    /** Maximum extracted content length in characters. Default: 8000. */
    maxContentChars?: number;
    /** User-Agent header for fetches. Default: "AgentForEachBot/1.0 (Web Fetch)". */
    userAgent?: string;
  };

  /** In-memory cache configuration. */
  cache?: {
    /** Enable response caching. Default: true. */
    enabled?: boolean;
    /** Cache TTL in milliseconds. Default: 300000 (5 minutes). */
    ttlMs?: number;
    /** Maximum cache entries. Default: 100. */
    maxEntries?: number;
  };
}

// ============================================================================
// Resolved Config
// ============================================================================

/**
 * Fully resolved web config with all defaults applied.
 */
export interface WebConfig {
  /** Whether web tools are enabled. */
  enabled: boolean;

  /** Web search settings. */
  search: {
    provider: SearchProvider;
    apiKey: string;
    maxResults: number;
    safesearch: "off" | "moderate" | "strict";

    /** Tavily-specific settings (resolved). */
    tavily: {
      apiKey: string;
      searchDepth: "basic" | "advanced" | "fast" | "ultra-fast";
      topic: "general" | "news" | "finance";
      includeAnswer: boolean | "basic" | "advanced";
      includeRawContent: boolean | "markdown" | "text";
      country?: string;
    };

    /** Perplexity-specific settings (resolved). */
    perplexity: {
      apiKey: string;
      baseUrl: string;
      model: string;
    };

    /** Grok-specific settings (resolved). */
    grok: {
      apiKey: string;
      model: string;
    };

    /** Failover chain for search providers (resolved). */
    failover: {
      enabled: boolean;
      chain: SearchProvider[];
    };
  };

  /** Rate limiting for web search calls (resolved). */
  rateLimit: {
    maxPerSession: number;
    maxPerUserDaily: number;
    cooldownMs: number;
  };

  /** Web fetch settings. */
  fetch: {
    timeoutMs: number;
    maxContentChars: number;
    userAgent: string;
  };

  /** In-memory cache settings. */
  cache: {
    enabled: boolean;
    ttlMs: number;
    maxEntries: number;
  };
}

// ============================================================================
// Brave Search API Response Types
// ============================================================================

/** A single web search result from Brave. */
export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

/** Brave Search API response shape (simplified). */
export interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
  query?: {
    original: string;
  };
}

// ============================================================================
// Perplexity API Response Types
// ============================================================================

/** Perplexity chat completions response (simplified). */
export interface PerplexitySearchResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
}

// ============================================================================
// Grok (xAI) API Response Types
// ============================================================================

/** Grok Responses API output block. */
export interface GrokOutputBlock {
  type?: string;
  role?: string;
  text?: string;
  content?: Array<{
    type?: string;
    text?: string;
    annotations?: Array<{
      type?: string;
      url?: string;
    }>;
  }>;
  annotations?: Array<{
    type?: string;
    url?: string;
  }>;
}

/** Grok Responses API response shape (simplified). */
export interface GrokSearchResponse {
  output?: GrokOutputBlock[];
  output_text?: string;
  citations?: string[];
}

// ============================================================================
// Tavily Search API Response Types
// ============================================================================

/** A single Tavily search result. */
export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content?: string | null;
}

/** Tavily Search API response shape. */
export interface TavilySearchResponse {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  response_time: number | string;
  images?: Array<{ url: string; description?: string }>;
}
