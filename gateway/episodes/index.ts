/**
 * AgentForEach Episode Layer — Public API
 *
 * Barrel exports for the episodic memory subsystem.
 *
 * Episodes capture theme-based life arcs ("Wedding Planning",
 * "Job Search", "Kitchen Renovation") that span multiple sessions
 * and accumulate highlights over time.
 *
 * The LLM manages episodes via three tools:
 *   - episode_recall  — search past episodes by topic
 *   - episode_create  — create a new theme-based episode
 *   - episode_update  — contribute a highlight to an existing episode
 *
 * Usage:
 * ```ts
 * import {
 *   EpisodeStore,
 *   loadEpisodeConfig,
 *   EpisodeToolHandler,
 *   getEpisodeToolDefinitions,
 * } from "./episodes/index.js";
 *
 * const store = new EpisodeStore(getSharedStorage());
 * await store.initialize();
 *
 * // Register tools for LLM to call on-demand
 * const tools = getEpisodeToolDefinitions();
 * const handler = new EpisodeToolHandler(store, config, embeddings);
 * ```
 */

// -- Types --
export type {
  EpisodeDocument,
  EpisodeHighlight,
} from "./types.js";

// -- Config --
export {
  loadEpisodeConfig,
  isEpisodesEnabled,
  resolveContainerId,
  resetEpisodeConfig,
} from "./config.js";
export type { EpisodeConfig, EpisodeJsonConfig } from "./config.js";

// -- Store --
export { EpisodeStore } from "./store.js";
export type { EpisodeSearchResult } from "./store.js";

// -- Tools --
export {
  EpisodeToolHandler,
  getEpisodeToolDefinitions,
  isEpisodeTool,
  EPISODE_RECALL_TOOL_NAME,
  EPISODE_CREATE_TOOL_NAME,
  EPISODE_UPDATE_TOOL_NAME,
} from "./tools.js";

// -- Utilities --
export { buildEpisodeId, normalizeStringArray } from "./generator.js";

// -- Recall (used internally by tool handler) --
export { formatEpisodesContext } from "./recall.js";
