/**
 * AgentForEach Knowledge Layer — Configuration
 *
 * Loads knowledge base config from agentforeach.json ("knowledge" section).
 * Follows the same cached-singleton pattern as web/config.ts and
 * episodes/config.ts.
 */

import { loadConfigSection, resolveEnvValue } from "../utils/index.js";
import type { KnowledgeJsonConfig, KnowledgeConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_INDEX_NAME = "knowledge-base";
const DEFAULT_AUTO_RECALL = true;
const DEFAULT_RECALL_LIMIT = 3;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.02;
const DEFAULT_SEMANTIC_CONFIG = "default";
const DEFAULT_QUERY_TYPE = "semantic" as const;
const DEFAULT_API_VERSION = "2024-07-01";

// ============================================================================
// Config Loader
// ============================================================================

let _knowledgeConfig: KnowledgeConfig | undefined;

/**
 * Load the knowledge config from agentforeach.json and resolve all defaults.
 *
 * Resolution order (highest priority wins):
 *   1. Env vars: SEARCH_ENDPOINT, SEARCH_API_KEY
 *   2. agentforeach.json "knowledge" section (with $ENV interpolation)
 *   3. Defaults
 */
export function loadKnowledgeConfig(): KnowledgeConfig {
  if (_knowledgeConfig) return _knowledgeConfig;

  const section = loadConfigSection<KnowledgeJsonConfig>("knowledge");
  const json = section ?? {};

  const endpoint =
    resolveEnvValue(json.endpoint) ??
    process.env.SEARCH_ENDPOINT ??
    "";

  const apiKey =
    resolveEnvValue(json.apiKey) ??
    process.env.SEARCH_API_KEY ??
    "";

  _knowledgeConfig = {
    enabled: json.enabled ?? false,
    endpoint,
    apiKey,
    indexName: json.indexName ?? DEFAULT_INDEX_NAME,
    autoRecall: json.autoRecall ?? DEFAULT_AUTO_RECALL,
    recallLimit: json.recallLimit ?? DEFAULT_RECALL_LIMIT,
    searchLimit: json.searchLimit ?? DEFAULT_SEARCH_LIMIT,
    minScore: json.minScore ?? DEFAULT_MIN_SCORE,
    semanticConfig: json.semanticConfig ?? DEFAULT_SEMANTIC_CONFIG,
    queryType: json.queryType ?? DEFAULT_QUERY_TYPE,
    apiVersion: json.apiVersion ?? DEFAULT_API_VERSION,
  };

  return _knowledgeConfig;
}

/**
 * Check whether the knowledge module is enabled and properly configured.
 */
export function isKnowledgeEnabled(): boolean {
  const cfg = loadKnowledgeConfig();
  return cfg.enabled && !!cfg.endpoint && !!cfg.apiKey;
}

/**
 * Reset the cached config (for testing).
 */
export function resetKnowledgeConfig(): void {
  _knowledgeConfig = undefined;
}
