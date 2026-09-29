/**
 * AgentForEach Channels — WhatsApp Cron Delivery Adapter
 *
 * Delivers cron job results to WhatsApp chats. Same pattern as the Telegram
 * adapter, with one difference that matters: a cron job fires on a schedule,
 * not in response to a message, so its delivery is exactly the case the
 * 24-hour service window blocks.
 *
 * That is handled in sendWhatsAppMessage rather than here — a closed window
 * routes to the approved template, or returns an error saying which template
 * was missing. Either way the job's delivery result reports the truth instead
 * of a silent non-delivery.
 *
 * @see channels/telegram/delivery.ts — reference implementation
 * @see cron/delivery.ts — DeliveryAdapter interface
 */

import {
  registerDeliveryAdapter,
  type DeliveryAdapter,
  type DeliveryPayload,
  type DeliveryResult,
} from "../../cron/delivery.js";
import type { CronJob, DeliveryTarget } from "../../cron/types.js";
import { sendWhatsAppMessage } from "./outbound.js";
import { markdownToWhatsApp } from "./format.js";

const SESSION_PREFIX = "whatsapp-";

const whatsappDeliveryAdapter: DeliveryAdapter = {
  channelId: "whatsapp",
  displayName: "WhatsApp",

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const { target, text } = payload;

    try {
      const result = await sendWhatsAppMessage({
        chatId: target.recipientId,
        text: markdownToWhatsApp(text),
      });

      return {
        success: result.success,
        error: result.error,
        metadata: {
          channel: "whatsapp",
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
    // WhatsApp sessions use the framework's deterministic id, "whatsapp-{waId}",
    // and the wa_id IS the address — so the session id alone is enough.
    if (job.sessionId?.startsWith(SESSION_PREFIX)) {
      const chatId = job.sessionId.slice(SESSION_PREFIX.length);
      if (chatId) {
        return {
          channelId: "whatsapp",
          recipientId: chatId,
          resolution: "from-profile",
        };
      }
    }

    // Anything else falls through to the framework's session-metadata
    // resolver. Guessing a phone number from a user id would be worse than
    // not delivering.
    return undefined;
  },
};

/**
 * Register the WhatsApp delivery adapter with the cron system.
 *
 * Called from whatsapp/index.ts during auto-registration (when enabled).
 */
export function registerWhatsAppDeliveryAdapter(): void {
  registerDeliveryAdapter(whatsappDeliveryAdapter);
}

export { whatsappDeliveryAdapter };
