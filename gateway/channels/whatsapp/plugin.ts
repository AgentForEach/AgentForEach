/**
 * AgentForEach Channels — WhatsApp Plugin Assembly
 *
 * Wires the focused submodules into a single ChannelPlugin. Each submodule
 * owns one concern; this file composes them.
 *
 * @see channels/types.ts — ChannelPlugin interface
 * @see channels/telegram/plugin.ts — same assembly, fewer concerns
 */

import type {
  ChannelPlugin,
  InboundMessage,
  OutboundContext,
  OutboundResult,
} from "../types.js";
import type { SendRequest } from "../../client/types.js";
import type { DeliveryAdapter } from "../../cron/delivery.js";
import { loadWhatsAppConfig } from "./config.js";
import { verifyWhatsAppWebhook, verifyWhatsAppChallenge } from "./verify.js";
import { parseWhatsAppWebhook, enrichWhatsAppInbound } from "./inbound.js";
import { handleWhatsAppEvent } from "./events.js";
import { sendWhatsAppMessage } from "./outbound.js";
import { markdownToWhatsApp } from "./format.js";
import { whatsappDeliveryAdapter } from "./delivery.js";

/**
 * Create the WhatsApp ChannelPlugin.
 *
 * Reads config once at creation time to set `enabled`. All methods delegate.
 */
export function createWhatsAppPlugin(): ChannelPlugin {
  const config = loadWhatsAppConfig();

  return {
    id: "whatsapp",
    authorizedSenders: config.authorizedSenders,
    displayName: "WhatsApp",
    enabled: config.enabled,

    /**
     * Meta redelivers a non-200 webhook for up to seven days, so a slow agent
     * turn must not hold the response open. Safe only because inbound ids are
     * claimed durably in dedupe.ts before the turn starts.
     */
    ackImmediately: true,

    verifyWebhook(headers: Record<string, string>, body: string): boolean {
      return verifyWhatsAppWebhook(headers, body);
    },

    verifyChallenge(query: Record<string, string>): string | undefined {
      return verifyWhatsAppChallenge(query);
    },

    async parseInbound(body: unknown): Promise<InboundMessage | undefined> {
      return parseWhatsAppWebhook(body);
    },

    async enrichInbound(message: InboundMessage): Promise<InboundMessage> {
      return enrichWhatsAppInbound(message);
    },

    async handleEvent(body: unknown): Promise<void> {
      return handleWhatsAppEvent(body);
    },

    async sendOutbound(context: OutboundContext): Promise<OutboundResult> {
      return sendWhatsAppMessage(context);
    },

    toSendRequest(message: InboundMessage): Partial<SendRequest> {
      return {
        userId: config.defaultUserId,
        channelName: "whatsapp",
        channelChatId: message.chatId,
        isGroupChat: message.isGroupChat,
        groupName: message.groupName,
        authorizedSenders:
          config.authorizedSenders.length > 0
            ? config.authorizedSenders
            : undefined,
        extraSystemPrompt: buildWhatsAppSystemPrompt(message),
      };
    },

    formatReply(text: string): string {
      return markdownToWhatsApp(text);
    },

    getDeliveryAdapter(): DeliveryAdapter {
      return whatsappDeliveryAdapter;
    },
  };
}

/**
 * Sender context injected into the agent's system prompt.
 *
 * The formatting note is here rather than only in `prompt.channel` because it
 * is the single instruction that most changes how a reply reads on this
 * surface, and a project that forgets to configure the channel prompt still
 * gets it. format.ts degrades whatever arrives regardless — but a table that
 * was never written beats a table converted into lines.
 */
function buildWhatsAppSystemPrompt(message: InboundMessage): string {
  const parts: string[] = [];

  parts.push(`WhatsApp sender: ${message.senderName ?? "Unknown"}`);
  parts.push(`Number: +${message.senderId}`);
  parts.push(
    "WhatsApp supports only *bold*, _italic_, ~strike~ and monospace — " +
      "no headings, tables, or markdown links. Write short paragraphs and " +
      "plain lines, and put URLs on their own.",
  );

  return parts.join(" | ");
}
