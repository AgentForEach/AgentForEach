/**
 * AgentForEach Digests Module — Public API
 *
 * Short-lived session summaries for recency awareness.
 * Gives the agent a "previously on…" recap without polluting
 * long-term semantic memory.
 */

export type { DigestDocument } from "./types.js";
export {
  loadDigestConfig,
  isDigestsEnabled,
  resetDigestConfig,
} from "./config.js";
export type { DigestConfig, DigestJsonConfig } from "./config.js";
export { DigestStore } from "./store.js";
export {
  DigestToolHandler,
  getDigestToolDefinitions,
  isDigestTool,
  SESSION_SEARCH_TOOL_NAME,
} from "./tools.js";
