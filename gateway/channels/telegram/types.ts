/**
 * AgentForEach Channels — Telegram Bot API Types
 *
 * Type definitions for the Telegram Bot API subset used by AgentForEach.
 * Only the types needed for webhook message handling and outbound sends
 * are defined here — not the full 100+ type Telegram API.
 *
 * @see https://core.telegram.org/bots/api
 */

// ============================================================================
// Telegram API Types
// ============================================================================

/** Telegram User object. */
export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

/** Telegram Chat object. */
export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

/** Telegram MessageEntity (for commands, mentions, URLs, etc.). */
export type TelegramMessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
};

/** Telegram PhotoSize object (one size variant of a photo). */
export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

/** Telegram Document object. */
export type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

/** Telegram getFile API response. */
export type TelegramGetFileResponse = {
  ok: boolean;
  result?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
  };
  description?: string;
};

/** Telegram Message object. */
export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  /**
   * Set when the message was sent on behalf of a chat: an anonymous group
   * admin, a channel post, or a linked channel's automatic forward. `from`
   * is then one of Telegram's shared placeholder accounts, not a person.
   */
  sender_chat?: TelegramChat;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  /** Photo message: array of sizes, largest last. */
  photo?: TelegramPhotoSize[];
  /** Document/file message. */
  document?: TelegramDocument;
  reply_to_message?: TelegramMessage;
  entities?: TelegramMessageEntity[];
};

/**
 * Telegram Update (incoming webhook payload).
 *
 * Only the fields relevant to message handling are typed.
 * Telegram sends many update types (callback_query, inline_query, etc.)
 * but AgentForEach only processes text messages, photos, and image documents.
 */
export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
};

/** Telegram sendMessage API response. */
export type TelegramSendMessageResponse = {
  ok: boolean;
  result?: TelegramMessage;
  description?: string;
  error_code?: number;
};

// ============================================================================
// Resolved Runtime Config
// ============================================================================

/** Resolved Telegram channel config (runtime, after env var resolution). */
export type TelegramConfig = {
  enabled: boolean;
  botToken: string;
  webhookSecretToken?: string;
  authorizedSenders: string[];
  defaultUserId: string;
  maxMessageLength: number;
};
