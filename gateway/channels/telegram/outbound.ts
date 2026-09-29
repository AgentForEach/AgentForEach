/**
 * AgentForEach Channels — Telegram Outbound
 *
 * Sends messages through the Telegram Bot API using native fetch.
 * No external dependencies needed (Node 18+ has global fetch).
 *
 * Handles:
 *   - Message splitting for texts exceeding maxMessageLength (4096),
 *     via the shared channels/util/split.ts
 *   - Reply-to-message for native reply threading
 *   - HTML parse mode for formatted output
 *
 * @see https://core.telegram.org/bots/api#sendmessage
 */

import { loadTelegramConfig } from "./config.js";
import type { TelegramSendMessageResponse } from "./types.js";
import type { OutboundContext, OutboundResult } from "../types.js";
import { splitMessage } from "../util/split.js";

// ============================================================================
// Constants
// ============================================================================

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_SEND_TIMEOUT_MS = 15_000;

// ============================================================================
// Send Message
// ============================================================================

/**
 * Send a message through the Telegram Bot API.
 *
 * Long messages are automatically split into chunks respecting Telegram's
 * message length limit. Only the first chunk includes reply_to_message_id.
 *
 * @param context - Outbound message context (chatId, text, etc.).
 * @returns Result with success/failure and the last sent messageId.
 */
export async function sendTelegramMessage(
  context: OutboundContext,
): Promise<OutboundResult> {
  const config = loadTelegramConfig();

  if (!config.botToken) {
    return { success: false, error: "Telegram bot token not configured" };
  }

  const url = `${TELEGRAM_API_BASE}/bot${config.botToken}/sendMessage`;

  // Split long messages into chunks
  const chunks = splitMessage(context.text, config.maxMessageLength);
  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const payload: Record<string, unknown> = {
      chat_id: context.chatId,
      text: chunks[i],
    };

    if (context.parseMode === "html") {
      payload.parse_mode = "HTML";
    }

    // Reply to the original message on the first chunk only
    if (i === 0 && context.replyToMessageId) {
      payload.reply_parameters = {
        message_id: Number(context.replyToMessageId),
        allow_sending_without_reply: true,
      };
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS),
      });

      const data = (await res.json()) as TelegramSendMessageResponse;

      if (!data.ok) {
        return {
          success: false,
          error: `Telegram API error (${data.error_code}): ${data.description ?? res.statusText}`,
        };
      }

      lastMessageId = data.result?.message_id
        ? String(data.result.message_id)
        : undefined;
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { success: true, messageId: lastMessageId };
}
