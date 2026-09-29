/**
 * AgentForEach Channels — WhatsApp Cloud API Types
 *
 * Modelled directly on Meta's documented schemas:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
 *
 * Deliberately narrow: only the fields we send or read. A full typing of the
 * Cloud API is thousands of lines describing messages this channel will never
 * send, and it rots on Meta's quarterly release cadence. Adding a capability
 * means extending these unions explicitly.
 *
 * Meta's official Node SDK (WhatsApp/WhatsApp-Nodejs-SDK) is ARCHIVED and pins
 * Cloud API v16.0, so there is no first-party client to lean on. This channel
 * speaks REST over native fetch, exactly as the Telegram plugin does.
 */

// ============================================================================
// Resolved Config
// ============================================================================

/** Resolved runtime config for the WhatsApp channel. */
export interface WhatsAppConfig {
  enabled: boolean;

  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  appSecret?: string;
  webhookVerifyToken?: string;

  apiBase: string;
  apiVersion: string;

  authorizedSenders: string[];
  defaultUserId: string;
  maxMessageLength: number;
  markReadOnReceipt: boolean;
  typingIndicator: boolean;
  optOutKeywords: string[];
  optInKeywords: string[];

  windowStore: "memory" | "cosmos";
  dedupeStore: "memory" | "cosmos";
  mediaCacheStore: "memory" | "cosmos";

  acceptInboundMedia: Array<"image" | "document" | "audio" | "video">;
  maxInboundMediaBytes: number;

  templates: Record<string, ResolvedTemplateRef>;
}

/** A registered template, resolved from config. */
export interface ResolvedTemplateRef {
  name: string;
  language: string;
  bodyParams: string[];
}

// ============================================================================
// Inbound — webhook envelope
// ============================================================================

/**
 * The thirteen inbound message types the Cloud API can deliver.
 *
 * `unsupported` is what a user's view-once photo or disappearing message
 * arrives as; it is a real type, not an error, and silence in response reads
 * as a broken bot.
 */
export type WhatsAppInboundType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "reaction"
  | "order"
  | "system"
  | "unsupported";

/** Common shape of a media object on an inbound message. */
export interface WhatsAppInboundMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

/** A single inbound message. */
export interface WhatsAppInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: WhatsAppInboundType | string;

  text?: { body: string };
  image?: WhatsAppInboundMedia;
  audio?: WhatsAppInboundMedia;
  video?: WhatsAppInboundMedia;
  document?: WhatsAppInboundMedia;
  sticker?: WhatsAppInboundMedia;

  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };

  contacts?: Array<{
    name?: { formatted_name?: string; first_name?: string; last_name?: string };
    phones?: Array<{ phone?: string; type?: string; wa_id?: string }>;
  }>;

  interactive?: {
    type: "button_reply" | "list_reply" | "nfm_reply" | string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    /**
     * A completed WhatsApp Flow. `response_json` carries whatever the
     * Flow's SUCCESS screen put in extension_message_response.params.
     */
    nfm_reply?: { name?: string; body?: string; response_json?: string };
  };

  /** Quick-reply button on a template message. */
  button?: { text: string; payload?: string };

  reaction?: { message_id: string; emoji?: string };

  order?: {
    catalog_id?: string;
    text?: string;
    product_items?: Array<Record<string, unknown>>;
  };

  system?: {
    body?: string;
    type?: string;
    wa_id?: string;
    customer?: string;
  };

  errors?: Array<{ code: number; title?: string; message?: string }>;

  /** Present when the user replied to one of our messages. */
  context?: { id?: string; from?: string; forwarded?: boolean };
}

/** Contact profile block that accompanies inbound messages. */
export interface WhatsAppContact {
  wa_id: string;
  profile?: { name?: string };
}

/** Outbound delivery status callback. */
export interface WhatsAppStatus {
  id: string;
  recipient_id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp: string;
  conversation?: { id?: string; origin?: { type?: string } };
  pricing?: { billable?: boolean; category?: string };
  errors?: Array<{ code: number; title?: string; message?: string }>;
}

/**
 * The `value` object of a webhook change.
 *
 * Which properties are populated depends on `WhatsAppChange.field`. Only the
 * `messages` field carries `messages` / `statuses`; the other twenty-odd
 * fields carry their own shapes, which we read opaquely in events.ts.
 */
export interface WhatsAppChangeValue {
  messaging_product?: "whatsapp";
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppInboundMessage[];
  statuses?: WhatsAppStatus[];
  errors?: Array<{ code: number; title?: string; message?: string }>;
  [key: string]: unknown;
}

export interface WhatsAppChange {
  field: string;
  value: WhatsAppChangeValue;
}

export interface WhatsAppEntry {
  id: string;
  changes?: WhatsAppChange[];
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: WhatsAppEntry[];
}

// ============================================================================
// Outbound
// ============================================================================

/** Envelope common to every outbound message. */
interface OutboundBase {
  messaging_product: "whatsapp";
  recipient_type?: "individual";
  to: string;
  context?: { message_id: string };
}

export type WhatsAppOutboundMessage =
  | (OutboundBase & {
      type: "text";
      text: { body: string; preview_url?: boolean };
    })
  | (OutboundBase & {
      type: "interactive";
      interactive: WhatsAppInteractive;
    })
  | (OutboundBase & {
      type: "image" | "document" | "audio" | "video";
      image?: WhatsAppOutboundMedia;
      document?: WhatsAppOutboundMedia;
      audio?: WhatsAppOutboundMedia;
      video?: WhatsAppOutboundMedia;
    })
  | (OutboundBase & {
      type: "template";
      template: {
        name: string;
        language: { code: string };
        components?: Array<{
          type: "body" | "header";
          parameters: Array<{ type: "text"; text: string }>;
        }>;
      };
    });

export interface WhatsAppOutboundMedia {
  /** Uploaded media handle. Preferred — see media.ts on fwdproxy limits. */
  id?: string;
  /** Publicly fetchable URL. Fetched by Meta through a shared forward proxy. */
  link?: string;
  caption?: string;
  filename?: string;
}

export type WhatsAppInteractive =
  | {
      type: "button";
      body: { text: string };
      action: {
        buttons: Array<{
          type: "reply";
          reply: { id: string; title: string };
        }>;
      };
    }
  | {
      type: "list";
      body: { text: string };
      action: {
        button: string;
        sections: Array<{
          title?: string;
          rows: Array<{ id: string; title: string; description?: string }>;
        }>;
      };
    };

/** Mark-as-read, optionally with a typing indicator. */
export interface WhatsAppReadReceipt {
  messaging_product: "whatsapp";
  status: "read";
  message_id: string;
  typing_indicator?: { type: "text" };
}

// ============================================================================
// API responses
// ============================================================================

export interface WhatsAppSendResponse {
  messaging_product?: "whatsapp";
  contacts?: Array<{ input: string; wa_id: string }>;
  messages?: Array<{ id: string; message_status?: string }>;
}

export interface WhatsAppErrorResponse {
  error: {
    message: string;
    type?: string;
    code: number;
    error_subcode?: number;
    error_data?: { messaging_product?: string; details?: string };
    fbtrace_id?: string;
  };
}

/** Response of GET /{media_id}. */
export interface WhatsAppMediaMetadata {
  id?: string;
  url?: string;
  mime_type?: string;
  file_size?: number;
  sha256?: string;
  messaging_product?: "whatsapp";
}

/** Response of POST /{phone_number_id}/media. */
export interface WhatsAppMediaUploadResponse {
  id?: string;
}
