/**
 * AgentForEach Episode Layer — Configuration
 *
 * Loads episode configuration from agentforeach.json ("episodes" section).
 * Follows the same modular config pattern as memory/, auth/, llms/.
 *
 * Key design choices:
 *   - Embedding config reused from `llms.embedding` (no duplication)
 *   - Storage shared via the StorageAdapter (no duplicate config)
 *   - Config cached after first load (reset for testing)
 */

import { loadConfigSection } from "../utils/index.js";

// ============================================================================
// agentforeach.json "episodes" Section Shape
// ============================================================================

/**
 * Configuration shape as stored in agentforeach.json "episodes" section.
 */
export interface EpisodeJsonConfig {
  /** Enable/disable the episode subsystem entirely. Default: true. */
  enabled?: boolean;

  /** Cosmos DB container name for episodes. Default: "episodes". */
  containerId?: string;

  /** Max episodes recalled into prompt. Default: 3. */
  recallLimit?: number;

  /** Max age in days for episode recall. Default: 14. */
  recallMaxAgeDays?: number;

  /** Max characters for episode summary. Default: 600. */
  maxSummaryChars?: number;

  /** Whether to generate embedding vectors. Default: true. */
  generateVectors?: boolean;

  /** Max highlights per episode before oldest are trimmed. Default: 20. */
  maxHighlightsPerEpisode?: number;

  /** Soft cap on active episodes per user. Default: 10. */
  maxActiveEpisodes?: number;

  /** Enable temporal decay for episode recall ranking. Default: true. */
  decayEnabled?: boolean;

  /** Half-life in days for episode decay. Default: 60 (episodes are more durable than memories). */
  decayHalfLifeDays?: number;
}

// ============================================================================
// Resolved Config
// ============================================================================

/**
 * Fully resolved episode config with all defaults applied.
 */
export type EpisodeConfig = {
  /** Whether episodes are enabled. */
  enabled: boolean;

  /** Cosmos DB container name. */
  containerId: string;

  /** Max episodes recalled into prompt. */
  recallLimit: number;

  /** Max age in days for episode recall (hard cutoff). */
  recallMaxAgeDays: number;

  /** Max characters for episode summary. */
  maxSummaryChars: number;

  /** Whether to generate embedding vectors. */
  generateVectors: boolean;

  /** Max highlights per episode before oldest are trimmed. */
  maxHighlightsPerEpisode: number;

  /** Soft cap on active episodes per user. */
  maxActiveEpisodes: number;

  /** Whether temporal decay is enabled for episode recall. */
  decayEnabled: boolean;

  /** Half-life in days for episode decay curve. */
  decayHalfLifeDays: number;
};

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONTAINER_ID = "episodes";
const DEFAULT_RECALL_LIMIT = 3;
const DEFAULT_RECALL_MAX_AGE_DAYS = 90;
const DEFAULT_MAX_SUMMARY_CHARS = 600;
const DEFAULT_MAX_HIGHLIGHTS_PER_EPISODE = 20;
const DEFAULT_MAX_ACTIVE_EPISODES = 10;
const DEFAULT_DECAY_ENABLED = true;
const DEFAULT_DECAY_HALF_LIFE_DAYS = 60;

// ============================================================================
// Config Loader
// ============================================================================

let _episodeConfig: EpisodeConfig | undefined;

/**
 * Load episode config from agentforeach.json and resolve all defaults.
 */
export function loadEpisodeConfig(): EpisodeConfig {
  if (_episodeConfig) return _episodeConfig;

  const section = loadConfigSection<EpisodeJsonConfig>("episodes");
  const json = section ?? {};

  _episodeConfig = {
    enabled: json.enabled !== false,
    containerId: json.containerId ?? DEFAULT_CONTAINER_ID,
    recallLimit: json.recallLimit ?? DEFAULT_RECALL_LIMIT,
    recallMaxAgeDays: json.recallMaxAgeDays ?? DEFAULT_RECALL_MAX_AGE_DAYS,
    maxSummaryChars: json.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
    generateVectors: json.generateVectors !== false,
    maxHighlightsPerEpisode:
      json.maxHighlightsPerEpisode ?? DEFAULT_MAX_HIGHLIGHTS_PER_EPISODE,
    maxActiveEpisodes:
      json.maxActiveEpisodes ?? DEFAULT_MAX_ACTIVE_EPISODES,
    decayEnabled: json.decayEnabled ?? DEFAULT_DECAY_ENABLED,
    decayHalfLifeDays: json.decayHalfLifeDays ?? DEFAULT_DECAY_HALF_LIFE_DAYS,
  };

  return _episodeConfig;
}

// ============================================================================
// Resolved Accessors
// ============================================================================

/** Check whether the episode subsystem is enabled. */
export function isEpisodesEnabled(): boolean {
  return loadEpisodeConfig().enabled;
}

/** Get the resolved container ID. */
export function resolveContainerId(): string {
  return loadEpisodeConfig().containerId;
}

/**
 * Reset the cached config (for testing).
 */
export function resetEpisodeConfig(): void {
  _episodeConfig = undefined;
}
