/**
 * AgentForEach Web Layer — Public API
 *
 * Barrel exports for the web tools subsystem.
 *
 * Provides LLM-callable tools for web search and URL content fetching:
 *   - web_search  — search the web via Tavily, Brave, Perplexity, or Grok
 *   - web_fetch   — fetch and extract readable content from a URL
 *
 * Usage:
 * ```ts
 * import {
 *   loadWebConfig,
 *   isWebEnabled,
 *   WebToolHandler,
 *   getWebToolDefinitions,
 *   isWebTool,
 * } from "./web/index.js";
 *
 * const config = loadWebConfig();
 * if (config.enabled) {
 *   const tools = getWebToolDefinitions();
 *   const handler = new WebToolHandler(config);
 *   const result = await handler.handle("web_search", { query: "..." }, userId);
 * }
 * ```
 */

// -- Types --
export type {
  WebConfig,
  WebJsonConfig,
  SearchProvider,
  BraveSearchResult,
  BraveSearchResponse,
  PerplexitySearchResponse,
  GrokSearchResponse,
  TavilySearchResult,
  TavilySearchResponse,
} from "./types.js";

// -- Config --
export { loadWebConfig, isWebEnabled, resetWebConfig } from "./config.js";

// -- Tools --
export {
  WebToolHandler,
  getWebToolDefinitions,
  isWebTool,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
} from "./tools.js";
