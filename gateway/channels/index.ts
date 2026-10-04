/**
 * AgentForEach Channels Module — Barrel Exports
 *
 * Re-exports all public types and functions from the channels system.
 * Side-effect imports at the bottom auto-register enabled channel plugins.
 *
 * Pattern matches llms/index.ts (types → config → registry → core → side-effects).
 *
 * @see llms/index.ts — same barrel + self-registration pattern
 */

// — Types —
export type {
  MediaAttachment,
  InboundMessage,
  OutboundContext,
  OutboundPayload,
  OutboundListRow,
  OutboundListSection,
  OutboundResult,
  InboundResult,
  ChannelPlugin,
  ChannelsJsonConfig,
  TelegramChannelJsonConfig,
  WhatsAppChannelJsonConfig,
  WhatsAppTemplateRef,
} from "./types.js";

// — Config —
export {
  loadChannelsConfig,
  isChannelEnabled,
  getChannelConfig,
  resetChannelsConfig,
} from "./config.js";
export type { ChannelsConfig } from "./config.js";

// — Registry —
export {
  registerChannel,
  getChannel,
  listChannels,
  getEnabledChannelIds,
  hasChannels,
} from "./registry.js";

// — Router —
export {
  processInbound,
  sendOutbound,
  setIdentityStore,
  getIdentityStore,
  resetIdentityStore,
} from "./router.js";

// ============================================================================
// Auto-register built-in channel plugins (side-effect imports)
// ============================================================================

// Telegram — registers plugin + delivery adapter if enabled in agentforeach.json
import "./telegram/index.js";

// WhatsApp — registers plugin + delivery adapter if enabled in agentforeach.json
import "./whatsapp/index.js";

// ============================================================================
// LastChannelResolver — resolves "last" channel for cron delivery
// ============================================================================

import { setLastChannelResolver } from "../cron/delivery.js";
import type { DeliveryTarget } from "../cron/types.js";
import { IdentityStore, loadIdentityConfig } from "../identity/index.js";
import { setIdentityStore as _setIdentityStore, getIdentityStore as _getIdentityStore } from "./router.js";

/**
 * Resolve the user's last-active channel by scanning recent session metadata.
 *
 * Called when a cron job has delivery.channelId = "last". Reads session
 * metadata (populated by the runner) to find the most recently used channel.
 *
 * Channel-agnostic: works for any channel that stores lastChannelName +
 * lastChatId in session metadata.
 */
// ============================================================================
// Identity Store Bootstrap (lazy, on first inbound)
// ============================================================================

let _initPromise: Promise<void> | null = null;

/**
 * Ensure the identity store is initialized.
 * Called lazily on first inbound channel message to avoid startup cost
 * when channels are not in use.
 *
 * Uses a promise guard so concurrent callers all await the same
 * initialization rather than racing past a boolean flag.
 *
 * A failed bootstrap is not cached: the next caller retries. While identity
 * is enabled but the store is unavailable, channel turns are refused (see
 * processInbound) rather than falling back to the default user.
 */
export function ensureIdentityStore(): Promise<void> {
  // Back off after a failure so an outage doesn't cost a full database init
  // on every inbound message.
  if (!_initPromise && Date.now() - _lastBootstrapFailureMs >= BOOTSTRAP_RETRY_MS) {
    _initPromise = _doIdentityBootstrap();
  }
  return _initPromise ?? Promise.resolve();
}

const BOOTSTRAP_RETRY_MS = 30_000;
let _lastBootstrapFailureMs = 0;

async function _doIdentityBootstrap(): Promise<void> {
  // If the client already initialized the store (via client.ts), skip
  if (_getIdentityStore()) return;

  const identityConfig = loadIdentityConfig();
  if (!identityConfig.enabled) return;

  try {
    // Dynamic import avoids circular dependency
    const { getSharedStorage } = await import("../database/index.js");
    const db = getSharedStorage();
    await db.initialize();

    const store = new IdentityStore(db, identityConfig);
    await store.initialize();

    // Only set if the client hasn't beaten us to it
    if (!_getIdentityStore()) {
      _setIdentityStore(store);
    }
  } catch (err) {
    console.error("[identity] Failed to initialize identity store:", err);
    _initPromise = null; // retry after BOOTSTRAP_RETRY_MS
    _lastBootstrapFailureMs = Date.now();
  }
}

/**
 * Reset the identity bootstrap state (for testing).
 */
export function resetIdentityBootstrap(): void {
  _initPromise = null;
}

setLastChannelResolver(
  async (userId: string): Promise<DeliveryTarget | undefined> => {
    try {
      // Dynamic import avoids circular dependency (channels → shared → client → channels)
      const { getAgentClient } = await import("../shared.js");
      const client = await getAgentClient();

      // The newest session with a channel and chat, across all sessions.
      const last = await client.findLastChannel(userId);
      return last
        ? { channelId: last.channelName, recipientId: last.chatId, resolution: "last-session" }
        : undefined;
    } catch {
      return undefined;
    }
  },
);
