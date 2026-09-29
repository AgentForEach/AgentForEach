/**
 * AgentForEach Identity Module — Public API
 *
 * Barrel exports for the channel identity registry.
 * Maps channel-specific sender IDs to canonical AgentForEach user IDs.
 *
 * All identity mappings live exclusively in Cosmos DB (database-only).
 * agentforeach.json only contains deployment-level settings (enabled, fallbackMode, TTLs).
 */

// — Types —
export type {
  IdentityLink,
  PairingCode,
  IdentityResolution,
  IdentityJsonConfig,
} from "./types.js";

// — Config —
export {
  loadIdentityConfig,
  resetIdentityConfigCache,
  DEFAULT_CONTAINER_ID,
  DEFAULT_PAIRING_CONTAINER_ID,
  DEFAULT_PAIRING_CODE_TTL_SECONDS,
  DEFAULT_PAIRING_CODE_LENGTH,
  DEFAULT_FALLBACK_MODE,
} from "./config.js";
export type { IdentityConfig } from "./config.js";

// — Store —
export { IdentityStore, IdentityConflictError, TooManyPairingCodesError } from "./store.js";
export { authorizeLinkCreate } from "./policy.js";
export type { LinkCreateBody, LinkCreateDecision } from "./policy.js";

// — Resolution —
export { resolveChannelIdentity, tryPairChannel } from "./resolver.js";
