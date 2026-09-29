/**
 * AgentForEach Identity Module — Resolver
 *
 * The core identity resolution function called by the channels router.
 * Looks up a channel sender in the identity store and returns the
 * canonical AgentForEach user ID.
 *
 * Resolution order:
 *   1. Identity link in database → chittiUserId
 *   2. Channel config defaultUserId (fallbackMode: "config-default")
 *   3. Passthrough "{channel}:{senderId}" (fallbackMode: "sender-passthrough")
 */

import type { IdentityResolution } from "./types.js";
import { IdentityConflictError, IdentityStore } from "./store.js";
import { loadIdentityConfig } from "./config.js";

// ============================================================================
// Identity Resolution
// ============================================================================

/**
 * Resolve a channel sender to a AgentForEach user ID.
 *
 * @param store - The identity store (null if identity system is disabled).
 * @param channel - Channel ID (e.g., "telegram").
 * @param channelUserId - Channel-specific sender ID (e.g., "12345").
 * @param configDefaultUserId - The defaultUserId from the channel's config.
 * @returns Resolution result with the AgentForEach user ID.
 */
export async function resolveChannelIdentity(
  store: IdentityStore | null,
  channel: string,
  channelUserId: string,
  configDefaultUserId?: string,
): Promise<IdentityResolution> {
  const config = loadIdentityConfig();

  // If identity store is available, try database lookup first
  if (store && config.enabled) {
    let link;
    try {
      link = await store.resolveByChannel(channel, channelUserId);
    } catch (err) {
      if (err instanceof IdentityConflictError) return { resolved: false, source: "conflict" };
      throw err;
    }
    if (link) {
      return {
        resolved: true,
        chittiUserId: link.chittiUserId,
        source: "identity-link",
      };
    }
  }

  // Fallback based on config
  if (config.fallbackMode === "config-default" && configDefaultUserId) {
    return {
      resolved: true,
      chittiUserId: configDefaultUserId,
      source: "config-default",
    };
  }

  // Sender passthrough (or no configDefaultUserId available)
  return {
    resolved: false,
    fallbackUserId: `${channel}:${channelUserId}`,
    source: "sender-id-passthrough",
  };
}

// ============================================================================
// Pairing Code Detection
// ============================================================================

/** Same alphabet as generated codes (no 0/O, 1/I). */
const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/;

/**
 * Try to handle a pairing code message.
 *
 * When a user sends a message that looks like a pairing code (short
 * alphanumeric string), this function attempts to consume it and create
 * an identity link.
 *
 * @param store - The identity store.
 * @param channel - Channel ID (e.g., "telegram").
 * @param channelUserId - Channel-specific sender ID.
 * @param messageText - The message text to check.
 * @param senderName - Optional sender display name.
 * @param senderUsername - Optional sender username.
 * @returns The resolved chittiUserId if pairing succeeded, null otherwise.
 */
export async function tryPairChannel(
  store: IdentityStore,
  channel: string,
  channelUserId: string,
  messageText: string,
  senderName?: string,
  senderUsername?: string,
): Promise<string | null> {
  const config = loadIdentityConfig();
  const trimmed = messageText.trim().toUpperCase();

  // Only try pairing if the message looks like a code: right length, and
  // only the code alphabet (so words like "HELLO1" or "COOL10" are skipped).
  if (trimmed.length !== config.pairingCodeLength) return null;
  if (!PAIRING_CODE_PATTERN.test(trimmed)) return null;

  // Codes are short, so cap guesses per sender (durable across instances).
  if (await store.isPairingLocked(channel, channelUserId)) {
    console.warn(`[identity] pairing locked for a ${channel} sender after too many failed attempts`);
    return null;
  }

  const chittiUserId = await store.consumePairingCode(trimmed);
  if (!chittiUserId) {
    // Every miss counts, linked senders included: a correct guess would
    // relink the sender to someone else's account. The lockout only blocks
    // pairing, and it expires.
    await store.recordPairingFailure(channel, channelUserId);
    return null;
  }

  // Create the identity link
  const link = {
    id: IdentityStore.buildLinkId(channel, channelUserId),
    chittiUserId,
    channel: channel.toLowerCase(),
    channelUserId,
    displayName: senderName,
    channelUsername: senderUsername,
    linkedVia: "pairing-code" as const,
    linkedAt: new Date().toISOString(),
  };

  await store.upsertLink(link);
  return chittiUserId;
}
