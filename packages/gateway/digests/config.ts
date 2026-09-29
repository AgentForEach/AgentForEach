/**
 * AgentForEach Digests Module — Configuration
 *
 * Loads digest configuration from agentforeach.json ("digests" section).
 * Follows the same modular config pattern as episodes/, memory/, etc.
 */

import { loadConfigSection } from "../utils/index.js";

// ============================================================================
// agentforeach.json "digests" Section Shape
// ============================================================================

export interface DigestJsonConfig {
  /** Enable/disable the digests subsystem. Default: true. */
  enabled?: boolean;
  /** Cosmos DB container name for digests. Default: "session-digests". */
  containerId?: string;
  /** TTL in seconds for digest documents. Default: 604800 (7 days). */
  ttlSeconds?: number;
  /** Maximum number of recent digests to inject into the prompt. Default: 5. */
  recallLimit?: number;
  /** Maximum characters for the digest summary. Default: 300. */
  maxSummaryChars?: number;
}

// ============================================================================
// Resolved Config
// ============================================================================

export type DigestConfig = {
  enabled: boolean;
  containerId: string;
  ttlSeconds: number;
  recallLimit: number;
  maxSummaryChars: number;
};

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONTAINER_ID = "session-digests";
const DEFAULT_TTL_SECONDS = 604800; // 7 days
const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_MAX_SUMMARY_CHARS = 300;

// ============================================================================
// Config Loader
// ============================================================================

let _cfg: DigestConfig | undefined;

/**
 * Load digest config from agentforeach.json and resolve all defaults.
 */
export function loadDigestConfig(): DigestConfig {
  if (_cfg) return _cfg;

  const section = loadConfigSection<DigestJsonConfig>("digests");
  const json = section ?? {};

  _cfg = {
    enabled: json.enabled !== false,
    containerId: json.containerId ?? DEFAULT_CONTAINER_ID,
    ttlSeconds: json.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    recallLimit: json.recallLimit ?? DEFAULT_RECALL_LIMIT,
    maxSummaryChars: json.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
  };

  return _cfg;
}

/** Check whether the digests subsystem is enabled. */
export function isDigestsEnabled(): boolean {
  return loadDigestConfig().enabled;
}

/** Reset the cached config (for testing). */
export function resetDigestConfig(): void {
  _cfg = undefined;
}
