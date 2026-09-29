/**
 * AgentForEach Channels Module — Inbound/Outbound Router
 *
 * Orchestrates the full inbound message pipeline:
 *   1. Look up channel plugin from registry
 *   2. Try pairing code detection (identity module)
 *   3. Resolve channel sender → AgentForEach user ID (identity module)
 *   4. Build a SendRequest from the InboundMessage via plugin.toSendRequest()
 *   5. Call AgentClient.send() (same pipeline as ws-message handler)
 *   6. Format the reply for the channel via plugin.formatReply()
 *   7. Send the reply back through the channel via plugin.sendOutbound()
 *
 * Also provides a direct outbound helper for cron delivery and
 * other non-chat outbound scenarios.
 *
 * @see handlers/ws-message.ts — similar pipeline for WebSocket messages
 * @see shared.ts — getAgentClient() singleton
 * @see identity/ — channel identity resolution module
 */

import type {
  InboundMessage,
  InboundResult,
  OutboundContext,
  OutboundPayload,
  OutboundResult,
} from "./types.js";
import type { NativeChoices, SendRequest } from "../client/types.js";
import { getChannel } from "./registry.js";
import { getAgentClient } from "../shared.js";
import type { IdentityStore } from "../identity/index.js";
import {
  loadIdentityConfig,
  resolveChannelIdentity,
  tryPairChannel,
} from "../identity/index.js";
import { identityFallbackIsUnsafe } from "./config.js";
import { stripControlTokens } from "../utils/control-tokens.js";

/** SendResponse error codes whose `text` is meant for the user. */
const USER_FACING_REFUSALS = new Set([
  "RATE_LIMITED",
  "SESSION_BUSY",
  "INSUFFICIENT_CREDITS",
  "CREDITS_UNAVAILABLE",
]);

// ============================================================================
// Identity Store Reference
// ============================================================================

/**
 * Module-level identity store reference.
 * Set during bootstrap (channels/index.ts or client/client.ts).
 * null when identity system is disabled or not yet initialized.
 */
let _identityStore: IdentityStore | null = null;

/**
 * Set the identity store for channel identity resolution.
 * Called by the bootstrap code after the store is initialized.
 */
export function setIdentityStore(store: IdentityStore): void {
  _identityStore = store;
}

/**
 * Get the current identity store (for testing or external access).
 */
export function getIdentityStore(): IdentityStore | null {
  return _identityStore;
}

/**
 * Reset the identity store reference (for testing).
 */
export function resetIdentityStore(): void {
  _identityStore = null;
}

// ============================================================================
// Inbound Pipeline
// ============================================================================

/**
 * Process an inbound message through the full pipeline.
 *
 * Flow:
 *   plugin lookup → try pairing → resolve identity → toSendRequest()
 *   → AgentClient.send() → formatReply() → sendOutbound()
 *
 * This is the core orchestration function that the webhook handler calls.
 *
 * @param channelId - Channel identifier (e.g., "telegram").
 * @param message - Normalized inbound message from the channel plugin.
 * @returns InboundResult with success/failure, reply text, and outbound result.
 */
export async function processInbound(
  channelId: string,
  message: InboundMessage,
  options?: { onCronMutation?: () => Promise<void> },
): Promise<InboundResult> {
  const plugin = getChannel(channelId);
  if (!plugin || !plugin.enabled) {
    return { success: false, error: `Channel "${channelId}" not registered or disabled` };
  }

  // Identity enabled but its store unavailable (e.g. Cosmos down): refuse the
  // turn. Falling back would resolve every sender to the default user.
  if (loadIdentityConfig().enabled && !_identityStore) {
    console.error(`[channels] ${channelId}: identity store unavailable, turn refused`);
    return { success: false, error: "Identity store unavailable", retryable: true };
  }

  // --- Try pairing code detection ---
  if (_identityStore && message.text.trim().length <= 8) {
    const pairedUserId = await tryPairChannel(
      _identityStore,
      channelId,
      message.senderId,
      message.text,
      message.senderName,
      message.senderUsername,
    );
    if (pairedUserId) {
      const confirmText =
        `Paired! Your ${plugin.displayName} account is now linked to your account here.`;
      const formatted = plugin.formatReply
        ? plugin.formatReply(confirmText)
        : confirmText;
      await plugin.sendOutbound({
        chatId: message.chatId,
        text: formatted,
        replyToMessageId: message.messageId,
        parseMode: plugin.parseMode,
      });
      return { success: true, replyText: confirmText };
    }
  }

  // --- Enrich (media downloads etc.) ---
  // Runs after the pairing check (a pairing code has nothing to enrich) and
  // after an ack-immediately channel has already returned its 200 — this is
  // where the expensive fetches that must not sit on the webhook path go.
  // Enrichment failures degrade inside the hook; a throw here should not
  // cost the turn either.
  if (plugin.enrichInbound) {
    try {
      message = await plugin.enrichInbound(message);
    } catch (err) {
      console.error(
        `[channels] enrichInbound failed for ${channelId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // --- Resolve channel identity ---
  const partial = plugin.toSendRequest(message);
  const configDefaultUserId = partial.userId;

  const identity = await resolveChannelIdentity(
    _identityStore,
    channelId,
    message.senderId,
    configDefaultUserId,
  );

  if (identity.source === "conflict") {
    return { success: false, error: "Identity conflict for this sender" };
  }
  // Defence in depth for channels that don't guard at registration: a
  // stranger must never act as the configured default user.
  if (
    identity.source === "config-default" &&
    identityFallbackIsUnsafe(plugin.authorizedSenders ?? [])
  ) {
    console.error(
      `[channels] ${channelId}: refused a turn that would run as the default user without an authorizedSenders allowlist`,
    );
    return { success: false, error: "Sender not authorized" };
  }

  const resolvedUserId = identity.resolved
    ? identity.userId
    : identity.fallbackUserId;

  // Build SendRequest using the plugin's channel-specific mapping
  const sendRequest: SendRequest = {
    channelName: channelId,
    // Message-thread channels cannot render app widgets; the runner swaps
    // widget-based collection for plain conversation when this is false.
    hitlWidgets: plugin.hitlWidgets ?? false,
    isGroupChat: message.isGroupChat,
    groupName: message.groupName,
    ...partial,
    // Framework-level deterministic session ID: ensures conversation continuity
    // per chat without requiring each channel plugin to implement it.
    // Plugins can still override by returning sessionId in toSendRequest().
    sessionId: partial.sessionId ?? `${channelId}-${message.chatId}`,
    // Override userId with identity-resolved value (takes precedence over partial)
    userId: resolvedUserId,
    // Ensure message text is always from the InboundMessage (not overridden by partial)
    message: message.text,
    // Pass media attachments through to the runner (transient — not persisted)
    attachments: message.attachments?.map((a) => ({
      mimeType: a.mimeType,
      base64: a.base64,
    })),
    // Signal the Durable Functions scheduler when cron tools mutate jobs.
    onCronMutation: options?.onCronMutation,
  };

  try {
    const client = await getAgentClient();

    // Hook: notify that a message was received from a channel
    client.hooks.emit("message_received", {
      userId: sendRequest.userId,
      message: message.text,
      channelName: channelId,
    });

    const response = await client.send(sendRequest);

    // Refusals the user should read (rate limit, busy, out of credits) carry
    // their explanation in `text`; other failures send nothing.
    const userFacingRefusal =
      response.status === "failed" && !!response.text && USER_FACING_REFUSALS.has(response.error ?? "");
    if (response.status === "failed" && !userFacingRefusal) {
      return {
        success: false,
        error: response.error ?? "AgentClient.send() failed",
      };
    }

    // NO_REPLY / HEARTBEAT_OK are instructions to us, never text for the user.
    const visibleText = stripControlTokens(response.text);
    if (!visibleText) {
      return { success: true, replyText: "" };
    }

    // Format reply for the channel
    let replyText = plugin.formatReply
      ? plugin.formatReply(visibleText)
      : visibleText;

    // Hook: allow modifying or cancelling the outbound message
    if (client.hooks.hasHandlers("message_sending")) {
      const mods = await client.hooks.emitWaterfall("message_sending", {
        text: replyText,
        channelName: channelId,
        chatId: message.chatId,
      });
      if (mods?.cancel) {
        return { success: true, replyText: visibleText };
      }
      if (mods?.text !== undefined) {
        replyText = mods.text;
      }
    }

    // Send reply back through the channel. The parse mode is the plugin's
    // own declaration — inferring "html" from the presence of formatReply
    // was a Telegram assumption that mislabelled every other dialect.
    const outbound = await plugin.sendOutbound({
      chatId: message.chatId,
      text: replyText,
      replyToMessageId: message.messageId,
      parseMode: plugin.parseMode,
      payload: choicesToPayload(response.nativeChoices, replyText),
    });

    return {
      success: outbound.success,
      replyText: visibleText,
      outbound,
      error: outbound.error,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Shape a runner-captured bounded choice into the channel payload.
 *
 * Small sets read best as tappable buttons; anything past the button cap
 * becomes a single-section list. The reply text doubles as the interactive
 * body (the OutboundPayload invariant keeps it a complete message for
 * channels that ignore payloads), and the channel's own renderer enforces
 * length caps.
 */
export function choicesToPayload(
  choices: NativeChoices | undefined,
  body: string,
): OutboundPayload | undefined {
  if (!choices || choices.options.length === 0) return undefined;

  if (choices.options.length <= 3) {
    return {
      kind: "buttons",
      body,
      buttons: choices.options.map((o) => ({ id: o.id, title: o.title })),
    };
  }
  return {
    kind: "list",
    body,
    button: choices.listButton ?? "Choose one",
    sections: [
      {
        title: "",
        rows: choices.options.map((o) => ({
          id: o.id,
          title: o.title,
          ...(o.description ? { description: o.description } : {}),
        })),
      },
    ],
  };
}

// ============================================================================
// Direct Outbound
// ============================================================================

/**
 * Send an outbound message through a channel directly.
 *
 * Used by cron delivery and other outbound scenarios where there's
 * no inbound message to reply to.
 *
 * @param channelId - Channel identifier.
 * @param context - Outbound message context.
 * @returns OutboundResult with success/failure.
 */
export async function sendOutbound(
  channelId: string,
  context: OutboundContext,
): Promise<OutboundResult> {
  const plugin = getChannel(channelId);
  if (!plugin || !plugin.enabled) {
    return { success: false, error: `Channel "${channelId}" not registered or disabled` };
  }

  return plugin.sendOutbound(context);
}
