/**
 * AgentForEach Identity Module — Types
 *
 * Data model for the Channel Identity Registry.
 * Maps channel-specific sender IDs to canonical AgentForEach user IDs.
 *
 * Two containers:
 *   "identity-links"   — IdentityLink documents (partition key: /chittiUserId)
 *   "identity-pairing" — PairingCode documents (partition key: /code)
 *
 * All identity mappings live exclusively in Cosmos DB (no static config).
 * The gateway remains stateless — it does a per-request DB lookup.
 */

// ============================================================================
// Identity Link Document (Cosmos DB)
// ============================================================================

/**
 * An identity link mapping a channel-specific sender to a AgentForEach user.
 *
 * Container: "identity-links"
 * Partition key: /chittiUserId
 * Document ID: `{channel}:{channelUserId}` (e.g., "telegram:12345")
 *
 * A single AgentForEach user can have multiple identity links (one per channel account).
 * A channel+channelUserId pair maps to exactly one AgentForEach user.
 */
export interface IdentityLink {
  /** Document ID: `{channel}:{channelUserId}` (e.g., "telegram:12345"). */
  id: string;

  /** Canonical AgentForEach user ID. Partition key. */
  chittiUserId: string;

  /** Channel identifier (e.g., "telegram", "whatsapp", "discord"). */
  channel: string;

  /** Channel-specific user/sender ID (e.g., Telegram user_id "12345"). */
  channelUserId: string;

  /** Display name at time of linking (informational). */
  displayName?: string;

  /** Channel username at time of linking (e.g., "@aliceexample"). */
  channelUsername?: string;

  /** How the link was established. */
  linkedVia: "admin" | "pairing-code";

  /** ISO-8601 timestamp when the link was created. */
  linkedAt: string;

  /** Cosmos DB TTL (undefined = never expire). */
  ttl?: number;

  /** Index signature for Cosmos DB BaseDocument compatibility. */
  [key: string]: unknown;
}

// ============================================================================
// Pairing Code Document (Cosmos DB)
// ============================================================================

/**
 * A short-lived pairing code for self-service channel linking.
 *
 * Flow:
 *   1. Authenticated user (WebSocket/API) requests a pairing code
 *   2. System generates a 6-character alphanumeric code, stores with TTL
 *   3. User sends the code to AgentForEach on the target channel (e.g., Telegram)
 *   4. System matches the code, creates the IdentityLink, deletes the pairing doc
 *
 * Container: "identity-pairing"
 * Partition key: /code
 */
export interface PairingCode {
  /** Document ID: the pairing code itself (e.g., "A3X9K2"). */
  id: string;

  /** The pairing code (same as id, for query convenience). */
  code: string;

  /** The canonical AgentForEach user ID that requested the code. */
  chittiUserId: string;

  /** ISO-8601 expiration timestamp. */
  expiresAt: string;

  /** Legacy: codes are now deleted when consumed, so this is always false on new docs. */
  consumed: boolean;

  /** Cosmos DB TTL in seconds (auto-delete after expiry). */
  ttl: number;

  /** Index signature for Cosmos DB BaseDocument compatibility. */
  [key: string]: unknown;
}

// ============================================================================
// Identity Resolution Result
// ============================================================================

/**
 * Result of resolving a channel sender to a AgentForEach user.
 */
export type IdentityResolution =
  | { resolved: true; chittiUserId: string; source: "identity-link" | "config-default" }
  | { resolved: false; fallbackUserId: string; source: "sender-id-passthrough" }
  /** Legacy links disagree on the owner: the turn must be refused. */
  | { resolved: false; source: "conflict" };

// ============================================================================
// Config Types (agentforeach.json "identity" section — deployment-level only)
// ============================================================================

/**
 * Configuration shape in agentforeach.json "identity" section.
 *
 * Only deployment-level settings — no user-specific data.
 * All identity mappings live in Cosmos DB.
 */
export interface IdentityJsonConfig {
  /** Cosmos DB container name for identity links. Default: "identity-links". */
  containerId?: string;

  /** Cosmos DB container name for pairing codes. Default: "identity-pairing". */
  pairingContainerId?: string;

  /**
   * Cosmos DB container for the channel-account owner index (partition /id).
   * Default: "identity-channel-index".
   */
  channelIndexContainerId?: string;

  /**
   * Deployments with identity links created before the channel index: on an
   * index miss, look the link up across partitions once and backfill the
   * index. Turn off after every linked account has messaged once. Default: false.
   */
  legacyLinkLookup?: boolean;

  /** Whether identity resolution is enabled. Default: false. */
  enabled?: boolean;

  /** TTL for pairing codes in seconds. Default: 300 (5 minutes). */
  pairingCodeTtlSeconds?: number;

  /** Length of generated pairing codes. Default: 6. */
  pairingCodeLength?: number;

  /**
   * Failed pairing attempts allowed per channel sender within
   * pairingAttemptWindowSeconds. Any message shaped like a code counts, so
   * keep this generous. Default: 10.
   */
  pairingMaxFailedAttempts?: number;

  /** Window for failed pairing attempts in seconds. Default: 900. */
  pairingAttemptWindowSeconds?: number;

  /** Active pairing codes one user may hold. Default: 5. */
  maxActivePairingCodes?: number;

  /**
   * Fallback behavior when no identity link is found.
   * - "config-default": Use channel's defaultUserId from config (current behavior)
   * - "sender-passthrough": Use `{channel}:{senderId}` as userId (multi-user ready)
   * Default: "config-default" (backward compatible)
   */
  fallbackMode?: "config-default" | "sender-passthrough";
}
