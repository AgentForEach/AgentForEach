/**
 * AgentForEach Channels — Telegram Plugin Assembly
 *
 * Wires together all Telegram-specific modules into a single ChannelPlugin.
 * This is the integration point — each submodule is focused on one concern,
 * and this file composes them into the unified plugin contract.
 *
 * @see channels/types.ts — ChannelPlugin interface
 */

import type { ChannelPlugin, InboundMessage, OutboundContext, OutboundResult } from "../types.js";
import type { SendRequest } from "../../client/types.js";
import type { DeliveryAdapter } from "../../cron/delivery.js";
import { loadTelegramConfig } from "./config.js";
import { verifyTelegramWebhook } from "./verify.js";
import { parseTelegramUpdate } from "./inbound.js";
import { sendTelegramMessage } from "./outbound.js";
import { markdownToTelegramHtml } from "./format.js";
import { telegramDeliveryAdapter } from "./delivery.js";

// ============================================================================
// Plugin Factory
// ============================================================================

/**
 * Create the Telegram ChannelPlugin.
 *
 * Reads config once at creation time to set `enabled`.
 * All methods delegate to the focused submodules.
 */
export function createTelegramPlugin(): ChannelPlugin {
  const config = loadTelegramConfig();

  return {
    id: "telegram",
    authorizedSenders: config.authorizedSenders,
    displayName: "Telegram",
    enabled: config.enabled,

    // formatReply emits Telegram HTML; the router passes this to sendOutbound.
    parseMode: "html",

    verifyWebhook(headers: Record<string, string>, body: string): boolean {
      return verifyTelegramWebhook(headers, body);
    },

    async parseInbound(body: unknown): Promise<InboundMessage | undefined> {
      return parseTelegramUpdate(body);
    },

    async sendOutbound(context: OutboundContext): Promise<OutboundResult> {
      return sendTelegramMessage(context);
    },

    toSendRequest(message: InboundMessage): Partial<SendRequest> {
      return {
        userId: config.defaultUserId,
        channelName: "telegram",
        channelChatId: message.chatId,
        isGroupChat: message.isGroupChat,
        groupName: message.groupName,
        authorizedSenders: config.authorizedSenders.length > 0
          ? config.authorizedSenders
          : undefined,
        extraSystemPrompt: buildTelegramSystemPrompt(message),
      };
    },

    formatReply(text: string): string {
      return markdownToTelegramHtml(text);
    },

    getDeliveryAdapter(): DeliveryAdapter {
      return telegramDeliveryAdapter;
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a Telegram-specific extra system prompt with sender context.
 *
 * This is injected via SendRequest.extraSystemPrompt and appears
 * in the agent's system prompt as additional context about the
 * current conversation participant.
 */
function buildTelegramSystemPrompt(message: InboundMessage): string {
  const parts: string[] = [];

  parts.push(`Telegram sender: ${message.senderName ?? "Unknown"}`);

  if (message.senderUsername) {
    parts.push(`Username: @${message.senderUsername}`);
  }

  if (message.isGroupChat && message.groupName) {
    parts.push(`Group: ${message.groupName}`);
  }

  return parts.join(" | ");
}
