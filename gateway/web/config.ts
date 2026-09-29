/**
 * AgentForEach Web Layer — Configuration
 *
 * Loads web tool config from agentforeach.json ("web" section).
 * Follows the same cached-singleton pattern as link-understanding/config.ts
 * and episodes/config.ts.
 *
 * Supports four search providers:
 *   - Tavily (default) — agent-optimized results with optional LLM answer
 *   - Brave Search — traditional search results
 *   - Perplexity — AI-synthesized answers with citations
 *   - Grok (xAI) — AI-synthesized answers with citations
 */

import { loadConfigSection, resolveEnvValue } from "../utils/index.js";
import type { WebJsonConfig, WebConfig, SearchProvider } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_SEARCH_PROVIDER: SearchProvider = "tavily";
const DEFAULT_SEARCH_MAX_RESULTS = 5;
const DEFAULT_SEARCH_SAFESEARCH = "moderate" as const;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_MAX_CONTENT_CHARS = 8_000;
const DEFAULT_FETCH_USER_AGENT = "AgentForEachBot/1.0 (Web Fetch)";
const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes
const DEFAULT_CACHE_MAX_ENTRIES = 100;

// Tavily defaults
const DEFAULT_TAVILY_SEARCH_DEPTH = "basic" as const;
const DEFAULT_TAVILY_TOPIC = "general" as const;
const DEFAULT_TAVILY_INCLUDE_ANSWER: "basic" = "basic";

// Perplexity defaults
const DEFAULT_PERPLEXITY_BASE_URL = "https://api.perplexity.ai";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_PERPLEXITY_MODEL = "sonar-pro";

// Grok defaults
const DEFAULT_GROK_MODEL = "grok-3-fast";

// Failover defaults
const DEFAULT_FAILOVER_CHAIN: SearchProvider[] = ["tavily", "brave"];

// Rate limit defaults
const DEFAULT_RATE_LIMIT_MAX_PER_SESSION = 10;
const DEFAULT_RATE_LIMIT_MAX_PER_USER_DAILY = 50;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 2_000;

// ============================================================================
// Config Loader
// ============================================================================

let _webConfig: WebConfig | undefined;

/**
 * Load the web tools config from agentforeach.json and resolve all defaults.
 */
export function loadWebConfig(): WebConfig {
  if (_webConfig) return _webConfig;

  const section = loadConfigSection<WebJsonConfig>("web");
  const json = section ?? {};

  // Resolve Tavily API key: config → $TAVILY_API_KEY
  const tavilyApiKey =
    resolveEnvValue(json.search?.tavily?.apiKey) ??
    process.env.TAVILY_API_KEY ??
    "";

  // Resolve Perplexity API key: config → $PERPLEXITY_API_KEY → $OPENROUTER_API_KEY
  const perplexityApiKey =
    resolveEnvValue(json.search?.perplexity?.apiKey) ??
    process.env.PERPLEXITY_API_KEY ??
    process.env.OPENROUTER_API_KEY ??
    "";

  // Auto-detect Perplexity base URL from API key prefix
  const perplexityBaseUrl =
    resolveEnvValue(json.search?.perplexity?.baseUrl) ??
    resolvePerplexityBaseUrl(perplexityApiKey);

  // Resolve Grok API key: config → $XAI_API_KEY
  const grokApiKey =
    resolveEnvValue(json.search?.grok?.apiKey) ??
    process.env.XAI_API_KEY ??
    "";

  _webConfig = {
    enabled: json.enabled ?? false,
    search: {
      provider: json.search?.provider ?? DEFAULT_SEARCH_PROVIDER,
      apiKey: resolveEnvValue(json.search?.apiKey) ?? "",
      maxResults: json.search?.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS,
      safesearch: json.search?.safesearch ?? DEFAULT_SEARCH_SAFESEARCH,
      tavily: {
        apiKey: tavilyApiKey,
        searchDepth: json.search?.tavily?.searchDepth ?? DEFAULT_TAVILY_SEARCH_DEPTH,
        topic: json.search?.tavily?.topic ?? DEFAULT_TAVILY_TOPIC,
        includeAnswer: json.search?.tavily?.includeAnswer ?? DEFAULT_TAVILY_INCLUDE_ANSWER,
        includeRawContent: json.search?.tavily?.includeRawContent ?? false,
        country: json.search?.tavily?.country,
      },
      perplexity: {
        apiKey: perplexityApiKey,
        baseUrl: perplexityBaseUrl,
        model: json.search?.perplexity?.model ?? DEFAULT_PERPLEXITY_MODEL,
      },
      grok: {
        apiKey: grokApiKey,
        model: json.search?.grok?.model ?? DEFAULT_GROK_MODEL,
      },
      failover: {
        enabled: json.search?.failover?.enabled ?? false,
        chain: json.search?.failover?.chain ?? DEFAULT_FAILOVER_CHAIN,
      },
    },
    fetch: {
      timeoutMs: json.fetch?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      maxContentChars: json.fetch?.maxContentChars ?? DEFAULT_FETCH_MAX_CONTENT_CHARS,
      userAgent: json.fetch?.userAgent ?? DEFAULT_FETCH_USER_AGENT,
    },
    cache: {
      enabled: json.cache?.enabled !== false,
      ttlMs: json.cache?.ttlMs ?? DEFAULT_CACHE_TTL_MS,
      maxEntries: json.cache?.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES,
    },
    rateLimit: {
      maxPerSession: json.rateLimit?.maxPerSession ?? DEFAULT_RATE_LIMIT_MAX_PER_SESSION,
      maxPerUserDaily: json.rateLimit?.maxPerUserDaily ?? DEFAULT_RATE_LIMIT_MAX_PER_USER_DAILY,
      cooldownMs: json.rateLimit?.cooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    },
  };

  return _webConfig;
}

/**
 * Check whether web tools are enabled.
 */
export function isWebEnabled(): boolean {
  return loadWebConfig().enabled;
}

/**
 * Reset the cached config (for testing).
 */
export function resetWebConfig(): void {
  _webConfig = undefined;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Auto-detect Perplexity base URL from API key prefix.
 *
 * - Keys starting with "pplx-" → Perplexity direct API
 * - Keys starting with "sk-or-" → OpenRouter gateway
 * - Otherwise → Perplexity direct API (default)
 */
function resolvePerplexityBaseUrl(apiKey: string): string {
  if (apiKey.startsWith("sk-or-")) return OPENROUTER_BASE_URL;
  return DEFAULT_PERPLEXITY_BASE_URL;
}
