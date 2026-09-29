/**
 * AgentForEach Channels — Telegram Cron Delivery Adapter
 *
 * Delivers cron job results to Telegram chats via the Bot API.
 * Follows the exact same pattern as websocket/push-adapter.ts.
 *
 * Registration:
 *   Called from telegram/index.ts during auto-registration.
 *   After registration, cron jobs with delivery.channelId = "telegram"
 *   will be dispatched to this adapter.
 *
 * @see websocket/push-adapter.ts — pushAdapter (reference implementation)
 * @see cron/delivery.ts — DeliveryAdapter interface
 */

import {
  registerDeliveryAdapter,
  type DeliveryAdapter,
  type DeliveryPayload,
  type DeliveryResult,
} from "../../cron/delivery.js";
import type { CronJob, DeliveryTarget } from "../../cron/types.js";
import { sendTelegramMessage } from "./outbound.js";
import { markdownToTelegramHtml } from "./format.js";
import { loadTelegramConfig } from "./config.js";

// ============================================================================
// Telegram Delivery Adapter
// ============================================================================

const telegramDeliveryAdapter: DeliveryAdapter = {
  channelId: "telegram",
  displayName: "Telegram",

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const { target, text } = payload;

    const formattedText = markdownToTelegramHtml(text);

    try {
      const result = await sendTelegramMessage({
        chatId: target.recipientId,
        text: formattedText,
        parseMode: "html",
      });

      return {
        success: result.success,
        error: result.error,
        metadata: {
          channel: "telegram",
          chatId: target.recipientId,
          messageId: result.messageId,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async resolveTarget(job: CronJob): Promise<DeliveryTarget | undefined> {
    // 1. Extract chatId from the creating session's deterministic ID.
    //    Telegram sessions use the format "telegram-{chatId}".
    if (job.sessionId?.startsWith("telegram-")) {
      const chatId = job.sessionId.slice("telegram-".length);
      if (chatId) {
        return {
          channelId: "telegram",
          recipientId: chatId,
          resolution: "from-profile",
        };
      }
    }

    // 2. For single-user bots (defaultUserId configured), the user's
    //    Telegram chatId IS the defaultUserId mapping. Look it up from
    //    the config's authorizedSenders or fall back to checking if
    //    this userId matches the defaultUserId.
    const config = loadTelegramConfig();
    if (config.defaultUserId && config.defaultUserId === job.userId) {
      // The job owner IS the default Telegram user — but we still need
      // the chatId, which we can't derive from config alone. Fall through
      // to the framework-level session metadata resolver.
    }

    return undefined;
  },
};

// ============================================================================
// Registration
// ============================================================================

/**
 * Register the Telegram delivery adapter with the cron system.
 *
 * Called from telegram/index.ts during auto-registration (when enabled).
 */
export function registerTelegramDeliveryAdapter(): void {
  registerDeliveryAdapter(telegramDeliveryAdapter);
}

export { telegramDeliveryAdapter };
