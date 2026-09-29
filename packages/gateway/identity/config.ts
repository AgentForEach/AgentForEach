/**
 * AgentForEach Identity Module — Configuration
 *
 * Loads identity configuration from agentforeach.json ("identity" section).
 * Follows the same modular config pattern as sessions/config.ts.
 *
 * Only deployment-level settings — no user-specific data.
 * All identity mappings live exclusively in Cosmos DB.
 */

import { loadConfigSection } from "../utils/index.js";
import type { IdentityJsonConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

/** Default Cosmos DB container name for identity links. */
export const DEFAULT_CONTAINER_ID = "identity-links";

/** Default Cosmos DB container name for pairing codes. */
export const DEFAULT_PAIRING_CONTAINER_ID = "identity-pairing";

/** Default container for the channel-account owner index. */
export const DEFAULT_CHANNEL_INDEX_CONTAINER_ID = "identity-channel-index";

/** Default pairing code TTL: 5 minutes. */
export const DEFAULT_PAIRING_CODE_TTL_SECONDS = 300;

/** Default pairing code length. */
export const DEFAULT_PAIRING_CODE_LENGTH = 6;

/** Failed pairing attempts allowed per channel sender within the window. */
export const DEFAULT_PAIRING_MAX_FAILED_ATTEMPTS = 10;

/** Window for failed pairing attempts, in seconds (15 minutes). */
export const DEFAULT_PAIRING_ATTEMPT_WINDOW_SECONDS = 900;

/** Active (unexpired) pairing codes one user may hold. */
export const DEFAULT_MAX_ACTIVE_PAIRING_CODES = 5;

/** Default fallback mode: use channel's defaultUserId (backward compatible). */
export const DEFAULT_FALLBACK_MODE = "config-default" as const;

// ============================================================================
// Resolved Config
// ============================================================================

/** Fully resolved identity configuration with defaults applied. */
export interface IdentityConfig {
  enabled: boolean;
  containerId: string;
  pairingContainerId: string;
  channelIndexContainerId: string;
  /** Fall back to a cross-partition link query when the index has no entry. */
  legacyLinkLookup: boolean;
  pairingCodeTtlSeconds: number;
  pairingCodeLength: number;
  /** Failed pairing attempts allowed per channel sender within the window. */
  pairingMaxFailedAttempts: number;
  pairingAttemptWindowSeconds: number;
  maxActivePairingCodes: number;
  fallbackMode: "config-default" | "sender-passthrough";
}

// ============================================================================
// Config Loader
// ============================================================================

let _cfg: IdentityConfig | undefined;

/**
 * Load identity config from agentforeach.json "identity" section and resolve
 * all defaults.
 *
 * Follows the same pattern as `loadSessionConfig()`.
 */
export function loadIdentityConfig(): IdentityConfig {
  if (_cfg) return _cfg;

  const section = loadConfigSection<IdentityJsonConfig>("identity");
  const json = section ?? {};

  _cfg = {
    enabled: json.enabled === true,
    containerId: json.containerId ?? DEFAULT_CONTAINER_ID,
    pairingContainerId: json.pairingContainerId ?? DEFAULT_PAIRING_CONTAINER_ID,
    channelIndexContainerId: json.channelIndexContainerId ?? DEFAULT_CHANNEL_INDEX_CONTAINER_ID,
    legacyLinkLookup: json.legacyLinkLookup ?? false,
    pairingCodeTtlSeconds: json.pairingCodeTtlSeconds ?? DEFAULT_PAIRING_CODE_TTL_SECONDS,
    pairingCodeLength: json.pairingCodeLength ?? DEFAULT_PAIRING_CODE_LENGTH,
    pairingMaxFailedAttempts:
      json.pairingMaxFailedAttempts ?? DEFAULT_PAIRING_MAX_FAILED_ATTEMPTS,
    pairingAttemptWindowSeconds:
      json.pairingAttemptWindowSeconds ?? DEFAULT_PAIRING_ATTEMPT_WINDOW_SECONDS,
    maxActivePairingCodes: json.maxActivePairingCodes ?? DEFAULT_MAX_ACTIVE_PAIRING_CODES,
    fallbackMode: json.fallbackMode ?? DEFAULT_FALLBACK_MODE,
  };

  return _cfg;
}

/**
 * Reset cached identity config (for testing).
 */
export function resetIdentityConfigCache(): void {
  _cfg = undefined;
}
