/**
 * AgentForEach Channels — Telegram Inbound Parser
 *
 * Converts a raw Telegram Update webhook payload into a normalized
 * InboundMessage for the channels router pipeline.
 *
 * Handles:
 *   - Text messages
 *   - Photo messages (downloads best size, returns as base64 attachment)
 *   - Image document messages (same download flow)
 *   - Authorized sender filtering
 *   - Group chat detection (group / supergroup → isGroupChat: true)
 *   - Reply-to-message threading context
 *
 * @see https://core.telegram.org/bots/api#update
 */

import type { TelegramUpdate } from "./types.js";
import type { InboundMessage, MediaAttachment } from "../types.js";
import { loadTelegramConfig } from "./config.js";
import {
  downloadTelegramFile,
  selectBestPhoto,
  isSupportedImageType,
} from "./media.js";

/**
 * Parse a Telegram Update into a normalized InboundMessage.
 *
 * Returns undefined for:
 *   - Non-message updates (edited_message, channel_post, callback_query)
 *   - Messages without text or processable media (stickers, etc.)
 *   - Messages from unauthorized senders (when authorizedSenders is non-empty)
 *   - Messages without a `from` field (service messages)
 *
 * @param body - Parsed JSON body from the Telegram webhook.
 * @returns Normalized InboundMessage, or undefined to skip.
 */
export async function parseTelegramUpdate(
  body: unknown,
): Promise<InboundMessage | undefined> {
  const update = body as TelegramUpdate;

  const msg = update?.message;
  if (!msg) return undefined;

  // Must have either text or a processable media type
  const hasText = !!msg.text;
  const hasPhoto = !!msg.photo?.length;
  const hasImageDocument =
    !!msg.document?.mime_type &&
    isSupportedImageType(msg.document.mime_type);

  if (!hasText && !hasPhoto && !hasImageDocument) return undefined;

  const chat = msg.chat;
  const from = msg.from;

  // Service messages or messages without a sender
  if (!from) return undefined;

  // Check authorized senders (if configured)
  const config = loadTelegramConfig();
  if (config.authorizedSenders.length > 0) {
    const senderId = String(from.id);
    const senderUsername = from.username?.toLowerCase();

    const isAuthorized = config.authorizedSenders.some((allowed) => {
      const normalized = allowed.toLowerCase().replace(/^@/, "");
      return normalized === senderId || normalized === senderUsername;
    });

    if (!isAuthorized) return undefined;
  }

  const isGroupChat = chat.type === "group" || chat.type === "supergroup";

  // Download image attachments (if any)
  const attachments: MediaAttachment[] = [];

  if (hasPhoto) {
    const bestPhoto = selectBestPhoto(msg.photo!);
    if (bestPhoto) {
      const downloaded = await downloadTelegramFile(bestPhoto.file_id);
      if (downloaded) {
        attachments.push({
          mimeType: downloaded.mimeType,
          base64: downloaded.base64,
          sizeBytes: downloaded.sizeBytes,
        });
      }
    }
  } else if (hasImageDocument) {
    const downloaded = await downloadTelegramFile(msg.document!.file_id);
    if (downloaded) {
      attachments.push({
        mimeType: msg.document!.mime_type!,
        base64: downloaded.base64,
        filename: msg.document!.file_name,
        sizeBytes: downloaded.sizeBytes,
      });
    }
  }

  // Use caption for photo/document messages, text for text messages
  const text = msg.text ?? msg.caption ?? "";

  return {
    messageId: String(msg.message_id),
    senderId: String(from.id),
    senderName: [from.first_name, from.last_name].filter(Boolean).join(" "),
    senderUsername: from.username,
    chatId: String(chat.id),
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    isGroupChat,
    groupName: isGroupChat ? chat.title : undefined,
    replyToMessageId: msg.reply_to_message
      ? String(msg.reply_to_message.message_id)
      : undefined,
    timestampMs: msg.date * 1000,
    raw: update,
  };
}
