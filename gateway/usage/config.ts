/**
 * AgentForEach Usage Module — Configuration
 *
 * Loads usage configuration from agentforeach.json ("usage" section).
 * Follows the same modular config pattern as sessions/, memory/, cron/.
 *
 * Key integration points:
 *   - Uses shared `loadConfigSection()` from utils/config
 *   - Merges built-in model pricing defaults with user overrides
 *   - agentforeach.json is the single source of truth for usage configuration
 */

import { loadConfigSection } from "../utils/index.js";
import type { ModelPricing, UsageJsonConfig } from "./types.js";
import { DEFAULT_MODEL_PRICING, DEFAULT_FALLBACK_PRICING } from "./pricing.js";

// ============================================================================
// Defaults
// ============================================================================

/** Default Cosmos DB container name for usage records. */
export const DEFAULT_USAGE_CONTAINER_ID = "usage-records";

/** Default TTL for usage records: 90 days. */
export const DEFAULT_USAGE_TTL_SECONDS = 7_776_000;

/** Usage tracking is enabled by default. */
export const DEFAULT_USAGE_ENABLED = true;

// ============================================================================
// Resolved Config
// ============================================================================

/** Fully resolved usage configuration with defaults applied. */
export interface UsageConfig {
  enabled: boolean;
  containerId: string;
  ttlSeconds: number;
  pricing: Record<string, ModelPricing>;
  fallbackPricing: ModelPricing;
}

// ============================================================================
// Config Loader
// ============================================================================

let _cfg: UsageConfig | undefined;

/**
 * Load usage config from agentforeach.json "usage" section and resolve
 * all defaults.
 *
 * Follows the same pattern as `loadSessionConfig()`:
 *   1. Load the raw JSON section via `loadConfigSection()`
 *   2. Apply defaults for any missing fields
 *   3. Merge user pricing overrides on top of built-in defaults
 *   4. Cache the resolved config for subsequent calls
 */
export function loadUsageConfig(): UsageConfig {
  if (_cfg) return _cfg;

  const section = loadConfigSection<UsageJsonConfig>("usage");
  const json = section ?? {};

  _cfg = {
    enabled: json.enabled ?? DEFAULT_USAGE_ENABLED,
    containerId: json.containerId ?? DEFAULT_USAGE_CONTAINER_ID,
    ttlSeconds: json.ttlSeconds ?? DEFAULT_USAGE_TTL_SECONDS,
    pricing: { ...DEFAULT_MODEL_PRICING, ...json.pricing },
    fallbackPricing: json.fallbackPricing ?? DEFAULT_FALLBACK_PRICING,
  };

  return _cfg;
}

// ============================================================================
// Resolved Accessors
// ============================================================================

/** Check if usage tracking is enabled. */
export function isUsageEnabled(): boolean {
  return loadUsageConfig().enabled;
}

/** Get the resolved usage container ID. */
export function resolveUsageContainerId(): string {
  return loadUsageConfig().containerId;
}

/** Get the resolved usage TTL in seconds. */
export function resolveUsageTtlSeconds(): number {
  return loadUsageConfig().ttlSeconds;
}

/**
 * Reset cached usage config (for testing).
 */
export function resetUsageConfigCache(): void {
  _cfg = undefined;
}
