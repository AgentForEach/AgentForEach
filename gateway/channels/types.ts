/**
 * AgentForEach Channels Module — Core Types
 *
 * Defines the plugin contract that all channel implementations must satisfy,
 * plus the normalized message types that flow through the inbound/outbound pipeline.
 *
 * Architecture:
 *   - Each channel (Telegram, Discord, Slack, ...) implements ChannelPlugin
 *   - The router orchestrates: webhook → parseInbound → AgentClient.send() → sendOutbound
 *   - Channels self-register via the registry on import (gated by config)
 *
 */

import type { SendRequest } from "../client/types.js";
import type { DeliveryAdapter } from "../cron/delivery.js";

// ============================================================================
// Media Attachment
// ============================================================================

/**
 * A media attachment (image, document) from an inbound message.
 *
 * Images are carried as base64 in memory during request processing.
 * They are NOT persisted to session storage (too large for Cosmos DB).
 */
export interface MediaAttachment {
  /** MIME type (e.g., "image/jpeg", "image/png"). */
  mimeType: string;
  /** Base64-encoded file data. */
  base64: string;
  /** Original filename (if available, e.g., from document messages). */
  filename?: string;
  /** File size in bytes (if known). */
  sizeBytes?: number;
}

// ============================================================================
// Normalized Message Types
// ============================================================================

/**
 * Normalized inbound message from any channel.
 *
 * Every channel plugin converts its raw incoming payload to this
 * common shape, which is then used to build a SendRequest for AgentClient.
 */
export type InboundMessage = {
  /** Channel-specific unique message identifier. */
  messageId: string;
  /** Normalized sender user ID (channel-specific format). */
  senderId: string;
  /** Sender display name. */
  senderName?: string;
  /** Sender username (e.g., Telegram @handle, Discord username). */
  senderUsername?: string;
  /** Chat/conversation ID within the channel. */
  chatId: string;
  /** Message text content. */
  text: string;
  /** Media attachments (images, documents). Not persisted to storage. */
  attachments?: MediaAttachment[];
  /** Whether this is a group chat. */
  isGroupChat: boolean;
  /** Group/chat title (if group). */
  groupName?: string;
  /** Message being replied to (for threading context). */
  replyToMessageId?: string;
  /** Timestamp of the message (epoch ms). */
  timestampMs: number;
  /** Raw channel-specific payload (for debugging / channel-specific logic). */
  raw?: unknown;
};

/**
 * A row inside a list-message section.
 */
export type OutboundListRow = {
  id: string;
  title: string;
  description?: string;
};

/**
 * A titled group of rows inside a list message.
 */
export type OutboundListSection = {
  title: string;
  rows: OutboundListRow[];
};

/**
 * An optional richer rendering of an outbound message.
 *
 * Channels that understand the `kind` render it natively; every other channel
 * ignores it and sends `OutboundContext.text` instead. That fallback is only
 * safe because of the invariant below, which callers MUST honour:
 *
 *   `text` is always populated and is always a complete message on its own.
 *
 * A payload is an enhancement, never the sole carrier of meaning. Do not put
 * the question in the buttons and leave `text` empty.
 */
export type OutboundPayload =
  | {
      kind: "buttons";
      /** Body copy shown above the buttons. */
      body: string;
      /** Reply buttons. Channels cap this (WhatsApp: 3). */
      buttons: Array<{ id: string; title: string }>;
    }
  | {
      kind: "list";
      /** Body copy shown above the list trigger. */
      body: string;
      /** Label on the button that opens the list. */
      button: string;
      sections: OutboundListSection[];
    }
  | {
      kind: "media";
      mediaType: "image" | "document" | "audio" | "video";
      /** Provider-side media handle, when the file was uploaded ahead of time. */
      mediaId?: string;
      /** Publicly fetchable URL. Prefer `mediaId` where the provider supports it. */
      url?: string;
      /** Inline bytes, uploaded by the channel before sending. */
      base64?: string;
      /**
       * MIME type of the bytes. Callers who know it should say so — providers
       * validate uploads against the declared type, and a channel left to
       * guess from `mediaType` alone will guess wrong for e.g. a PNG.
       */
      mimeType?: string;
      filename?: string;
      caption?: string;
    };

/**
 * Context for sending an outbound message through a channel.
 */
export type OutboundContext = {
  /** Target chat/conversation ID. */
  chatId: string;
  /**
   * Text content to send.
   *
   * Always a complete message on its own, even when `payload` is set — see
   * the invariant on OutboundPayload.
   */
  text: string;
  /** Optional: message to reply to (native reply/threading). */
  replyToMessageId?: string;
  /** Optional: parse mode for formatted output. */
  parseMode?: "html" | "markdown";
  /** Optional: richer rendering for channels that support it. */
  payload?: OutboundPayload;
};

/**
 * Result of sending an outbound message.
 */
export type OutboundResult = {
  /** Whether send succeeded. */
  success: boolean;
  /** Channel-specific message ID of the sent message. */
  messageId?: string;
  /** Error message if failed. */
  error?: string;
};

/**
 * Result of processing an inbound message through the full pipeline.
 *
 * Returned by `processInbound()` in the router.
 */
export type InboundResult = {
  /** Whether the pipeline completed successfully. */
  success: boolean;
  /** The assistant's reply text (from AgentClient). */
  replyText?: string;
  /** The outbound result (from sending the reply back through the channel). */
  outbound?: OutboundResult;
  /** Error message if failed. */
  error?: string;
  /**
   * The failure is temporary (e.g. the identity store is unavailable): the
   * webhook answers 503 so the provider redelivers instead of dropping it.
   */
  retryable?: boolean;
};

// ============================================================================
// Channel Plugin Interface
// ============================================================================

/**
 * Channel plugin interface.
 *
 * Each channel (Telegram, Discord, Slack, etc.) implements this contract.
 * The channels router orchestrates the inbound → agent → outbound pipeline.
 *
 * Plugins self-register via `registerChannel()` on import, gated by config.
 *
 * @example
 * ```ts
 * const plugin: ChannelPlugin = {
 *   id: "telegram",
 *   displayName: "Telegram",
 *   enabled: true,
 *   verifyWebhook(headers, body) { ... },
 *   parseInbound(body) { ... },
 *   sendOutbound(ctx) { ... },
 *   toSendRequest(msg) { return { channelName: "telegram", ... }; },
 *   formatReply(text) { return markdownToHtml(text); },
 * };
 * registerChannel(plugin);
 * ```
 */
export interface ChannelPlugin {
  /** Unique channel identifier (matches ChannelId from cron/types). */
  readonly id: string;

  /**
   * Senders this channel accepts (empty: everyone). The router refuses a
   * turn that would resolve to the configured default user when this is
   * empty, whatever the plugin forgot to check at registration.
   */
  authorizedSenders?: readonly string[];
  /** Human-readable display name. */
  readonly displayName: string;
  /** Whether the channel is currently enabled and configured. */
  readonly enabled: boolean;

  /**
   * Parse mode the router passes to `sendOutbound` when replying with
   * `formatReply`-formatted text. Omit for channels whose dialect has no
   * parse mode (WhatsApp converts in `formatReply` and sends plain).
   */
  readonly parseMode?: "html" | "markdown";

  /**
   * Acknowledge the webhook with 200 BEFORE running the agent turn.
   *
   * Providers that retry aggressively (Meta retries with decreasing frequency
   * for up to 7 days on any non-200) will redeliver while a slow turn is still
   * running, producing duplicate agent runs. Channels facing such a provider
   * set this and process detached.
   *
   * A channel that sets this MUST deduplicate inbound message ids durably —
   * see channels/whatsapp/dedupe.ts. Default false.
   */
  readonly ackImmediately?: boolean;

  /**
   * Whether this channel can render the HITL widget tools
   * (`request_user_input` pickers/forms). Those render in the app over the
   * realtime socket; a message thread cannot show
   * them, and a model offered widget tools it cannot use ends its turn
   * waiting on input that will never arrive. Default false — a channel that
   * embeds the real client UI opts in explicitly.
   */
  readonly hitlWidgets?: boolean;

  /**
   * Verify the authenticity of an incoming webhook request.
   *
   * @param headers - Request headers (lowercase keys).
   * @param body - Raw request body string.
   * @returns true if the request is authentic.
   */
  verifyWebhook(headers: Record<string, string>, body: string): boolean;

  /**
   * Answer a provider's webhook verification handshake (an HTTP GET on the
   * same path as the webhook).
   *
   * Meta-family providers register a webhook by calling GET with
   * `hub.mode`, `hub.verify_token` and `hub.challenge`, and expect the
   * challenge echoed back as plain text. Return the body to echo, or
   * undefined to reject with 403.
   *
   * Channels without a GET handshake omit this and the route 404s.
   *
   * @param query - Query-string parameters.
   */
  verifyChallenge?(query: Record<string, string>): string | undefined;

  /**
   * Handle a webhook payload that is NOT an inbound message.
   *
   * Called when `parseInbound` returns undefined, so a channel can act on
   * delivery receipts, account alerts, quality updates and other provider
   * notifications instead of dropping them.
   *
   * Fire-and-forget by contract: it must never block the webhook's 200, and
   * it must not start an agent turn. Errors are logged, not propagated.
   *
   * @param body - Parsed JSON body from the webhook request.
   */
  handleEvent?(body: unknown): Promise<void> | void;

  /**
   * Parse a raw webhook payload into a normalized InboundMessage.
   *
   * Returns undefined if the payload is not a message we should process
   * (e.g., edited_message, callback_query, service messages, unauthorized sender).
   *
   * @param body - Parsed JSON body from the webhook request.
   * @returns Normalized message, or undefined to skip.
   */
  parseInbound(body: unknown): Promise<InboundMessage | undefined> | InboundMessage | undefined;

  /**
   * Enrich a parsed message with anything expensive to fetch — media
   * downloads above all. Called by the router at the start of processing,
   * AFTER an ack-immediately channel has already returned its 200.
   *
   * `parseInbound` must therefore stay cheap: it decides whether a turn
   * happens; this hook gathers what the turn needs. A channel whose payloads
   * arrive complete omits it.
   *
   * Failures should degrade, not throw: return the message without the
   * enrichment rather than costing the turn.
   */
  enrichInbound?(message: InboundMessage): Promise<InboundMessage>;

  /**
   * Send an outbound message through this channel.
   *
   * @param context - Outbound message context (chatId, text, etc.).
   * @returns Result with success/failure and optional messageId.
   */
  sendOutbound(context: OutboundContext): Promise<OutboundResult>;

  /**
   * Map a normalized InboundMessage to a partial SendRequest.
   *
   * The router fills in remaining fields (message text comes from InboundMessage).
   * Use this to set channel-specific fields like channelName, userId,
   * isGroupChat, groupName, extraSystemPrompt.
   *
   * @param message - The normalized inbound message.
   * @returns Partial SendRequest with channel-specific overrides.
   */
  toSendRequest(message: InboundMessage): Partial<SendRequest>;

  /**
   * Format assistant reply text for this channel's conventions.
   *
   * E.g., convert Markdown to Telegram HTML, or Slack Blocks.
   * If not provided, raw text is sent.
   *
   * @param text - Raw assistant reply text.
   * @returns Formatted text for the channel.
   */
  formatReply?(text: string): string;

  /**
   * Get the DeliveryAdapter for cron outbound delivery.
   *
   * Channels that support cron delivery implement this to provide
   * an adapter compatible with the cron/delivery.ts registry.
   *
   * @returns DeliveryAdapter, or undefined if cron delivery not supported.
   */
  getDeliveryAdapter?(): DeliveryAdapter;
}

// ============================================================================
// Channel Config Types (agentforeach.json shapes)
// ============================================================================

/**
 * Top-level "channels" section in agentforeach.json.
 *
 * Each key is a channel ID with its channel-specific config.
 * New channels add their config shape here.
 */
export type ChannelsJsonConfig = {
  telegram?: TelegramChannelJsonConfig;
  whatsapp?: WhatsAppChannelJsonConfig;
  // Future channels:
  // discord?: DiscordChannelJsonConfig;
  // slack?: SlackChannelJsonConfig;
};

/**
 * Telegram-specific JSON config shape (in agentforeach.json).
 */
export type TelegramChannelJsonConfig = {
  enabled?: boolean;
  botToken?: string;
  webhookSecretToken?: string;
  authorizedSenders?: string[];
  defaultUserId?: string;
  maxMessageLength?: number;
};

/**
 * A registered WhatsApp message template, referenced by purpose.
 *
 * Authoring and approval happen in Meta Business Manager; this is only the
 * send side, used when the 24-hour service window has closed.
 */
export type WhatsAppTemplateRef = {
  /** Exact template name as approved in Business Manager. */
  name: string;
  /** Language code, e.g. "en" or "en_US". */
  language: string;
  /**
   * Positional body parameters. The literal "{{text}}" is substituted with
   * the message text at send time; anything else is passed through verbatim.
   */
  bodyParams?: string[];
};

/**
 * WhatsApp-specific JSON config shape (in agentforeach.json).
 *
 * Every secret accepts a `$ENV_VAR` reference resolved by utils/env.ts.
 */
export type WhatsAppChannelJsonConfig = {
  enabled?: boolean;

  // -- credentials --
  /** System User access token with expiry "Never". Dashboard tokens last 24h. */
  accessToken?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  /** App secret, for the X-Hub-Signature-256 payload signature. */
  appSecret?: string;
  /** Shared token echoed during the GET hub.challenge handshake. */
  webhookVerifyToken?: string;

  // -- API --
  apiBase?: string;
  /** Graph API version. Each is supported ~2 years; review annually. */
  apiVersion?: string;

  // -- behaviour --
  /** E.164 numbers permitted to talk to the agent. Empty means open. */
  authorizedSenders?: string[];
  defaultUserId?: string;
  maxMessageLength?: number;
  markReadOnReceipt?: boolean;
  typingIndicator?: boolean;
  optOutKeywords?: string[];
  optInKeywords?: string[];

  // -- stores --
  windowStore?: "memory" | "cosmos";
  dedupeStore?: "memory" | "cosmos";
  /** Where uploaded media ids are remembered between sends. */
  mediaCacheStore?: "memory" | "cosmos";

  // -- media --
  acceptInboundMedia?: Array<"image" | "document" | "audio" | "video">;
  maxInboundMediaBytes?: number;

  /** Approved templates, keyed by purpose. */
  templates?: Record<string, WhatsAppTemplateRef>;
};
