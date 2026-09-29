/**
 * AgentForEach Channels Module — Config Loader
 *
 * Loads the "channels" section from agentforeach.json with lazy caching.
 * Follows the same pattern as cron/config.ts and sessions/config.ts.
 *
 * @see utils/config.ts — loadConfigSection()
 */

import { loadConfigSection } from "../utils/index.js";
import { loadIdentityConfig } from "../identity/config.js";
import type { ChannelsJsonConfig } from "./types.js";

// ============================================================================
// Config Types
// ============================================================================

/**
 * Resolved runtime config for the channels system.
 */
export type ChannelsConfig = {
  /** Raw JSON config, keyed by channel ID. */
  raw: ChannelsJsonConfig;
};

// ============================================================================
// Lazy-Cached Config Loader
// ============================================================================

let _cfg: ChannelsConfig | undefined;

/**
 * Load the channels config from agentforeach.json "channels" section.
 *
 * Returns an empty config if the section is missing.
 * Cached after first load.
 */
export function loadChannelsConfig(): ChannelsConfig {
  if (_cfg) return _cfg;

  const section = loadConfigSection<ChannelsJsonConfig>("channels");

  _cfg = {
    raw: section ?? {},
  };

  return _cfg;
}

/**
 * Check whether a specific channel is enabled in config.
 *
 * A channel is considered enabled if its config block exists and
 * `enabled` is not explicitly set to `false`.
 */
export function isChannelEnabled(channelId: string): boolean {
  const config = loadChannelsConfig();
  const channelCfg = (config.raw as Record<string, { enabled?: boolean } | undefined>)[channelId];
  return channelCfg != null && channelCfg.enabled !== false;
}

/**
 * Get raw config for a specific channel from agentforeach.json.
 *
 * @returns The channel's config block, or undefined if not configured.
 */
export function getChannelConfig<T>(channelId: string): T | undefined {
  const config = loadChannelsConfig();
  return (config.raw as Record<string, unknown>)[channelId] as T | undefined;
}

/**
 * Reset cached config. For testing only.
 */
export function resetChannelsConfig(): void {
  _cfg = undefined;
}

// ============================================================================
// Identity fallback guard (shared by all channels)
// ============================================================================

/**
 * True when a stranger messaging the channel would act as the configured
 * default user: no authorizedSenders allowlist, and identity falls back to
 * "config-default" for unpaired senders.
 *
 * Reads the RESOLVED identity config: "config-default" is the identity
 * module's own default and applies whether or not identity is enabled, so a
 * config with no identity block at all is in the unsafe state.
 */
export function identityFallbackIsUnsafe(authorizedSenders: readonly string[]): boolean {
  if (authorizedSenders.length > 0) return false;
  return loadIdentityConfig().fallbackMode === "config-default";
}
