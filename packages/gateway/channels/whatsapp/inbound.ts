/**
 * AgentForEach Channels — WhatsApp Inbound Parser
 *
 * Converts a Cloud API webhook payload into a normalized InboundMessage.
 *
 * All thirteen inbound types are handled. Silently dropping one is not a
 * neutral choice: to the person who sent a location, or a view-once photo,
 * an ignored message is indistinguishable from a broken bot.
 *
 * Returns undefined for anything that should not start an agent turn —
 * statuses, reactions, unauthorized senders, redeliveries, and opt-outs. Those
 * are handled here or in events.ts rather than dropped.
 *
 * `parseInbound` decides whether a turn happens and stays cheap doing it:
 * claiming the message id, opening the service window, marking read, and
 * answering consent keywords all happen before the router ever sees the
 * message, and all of them are single fast writes. Media download — the one
 * genuinely slow step — lives in `enrichWhatsAppInbound`, which the router
 * calls AFTER the webhook has been acked, so a 5 MB image never holds
 * Meta's delivery open.
 *
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
 */

import type { InboundMessage, MediaAttachment } from "../types.js";
import type {
  WhatsAppWebhookPayload,
  WhatsAppInboundMessage,
  WhatsAppChangeValue,
  WhatsAppInboundMedia,
} from "./types.js";
import { loadWhatsAppConfig, normalisePhone } from "./config.js";
import { claimMessage } from "./dedupe.js";
import { recordInbound } from "./window.js";
import {
  classifyConsentText,
  isOptedOut,
  setOptedOut,
  setOptedIn,
} from "./consent.js";
import { downloadWhatsAppMedia, acceptsMediaKind } from "./media.js";
import { markReadAndTyping, sendPlainText } from "./outbound.js";

/**
 * Parse a webhook payload into a normalized InboundMessage.
 */
export async function parseWhatsAppWebhook(
  body: unknown,
): Promise<InboundMessage | undefined> {
  const payload = body as WhatsAppWebhookPayload;

  const value = firstMessageValue(payload);
  if (!value) return undefined;

  const msg = value.messages?.[0];
  if (!msg) return undefined;

  const cfg = loadWhatsAppConfig();
  const from = msg.from;
  if (!from) return undefined;

  // --- Authorized senders ---------------------------------------------
  if (cfg.authorizedSenders.length > 0) {
    const sender = normalisePhone(from);
    if (!cfg.authorizedSenders.includes(sender)) return undefined;
  }

  // --- Redelivery -------------------------------------------------------
  // Claimed before anything else so a retry cannot re-open the window, mark
  // read a second time, or re-answer a consent keyword.
  if (!(await claimMessage(msg.id))) return undefined;

  // --- Service window ---------------------------------------------------
  // Any inbound message resets the 24-hour window, including ones that never
  // reach the agent.
  await recordInbound(from, toMillis(msg.timestamp));

  // --- Consent ----------------------------------------------------------
  const rawText = plainText(msg);
  const intent = classifyConsentText(rawText);

  if (intent === "opt-out") {
    await setOptedOut(from);
    await sendPlainText(from, "You're unsubscribed. Send START to resume.");
    return undefined;
  }
  if (intent === "opt-in") {
    await setOptedIn(from);
    await sendPlainText(from, "You're subscribed again. Send STOP to stop.");
    return undefined;
  }
  if (await isOptedOut(from)) {
    // Opted out and not saying START: stay silent. Replying would be the
    // thing they asked us not to do.
    return undefined;
  }

  // --- Non-turn message types -------------------------------------------
  // A reaction is a gesture, not a question, and answering one is noise.
  if (msg.type === "reaction" || msg.type === "system") return undefined;

  // --- Read receipt + typing --------------------------------------------
  if (cfg.markReadOnReceipt) {
    // Fire-and-forget: a failed receipt must not cost us the turn.
    void markReadAndTyping(msg.id, cfg.typingIndicator);
  }

  // --- Body -------------------------------------------------------------
  // Every media type renders at least a placeholder, so an empty rendering
  // means a genuinely empty message. Attachments are downloaded later, in
  // enrichWhatsAppInbound — after the webhook is acked.
  const rendered = renderMessage(msg);
  if (!rendered) return undefined;

  const contact = value.contacts?.[0];

  return {
    messageId: msg.id,
    senderId: from,
    senderName: contact?.profile?.name,
    // WhatsApp has no handle concept; senderUsername stays undefined.
    chatId: from,
    text: rendered,
    // The Cloud API has no group messaging for business numbers. Kept as a
    // distinct field from chatId so the mapping survives if that changes.
    isGroupChat: false,
    replyToMessageId: msg.context?.id,
    timestampMs: toMillis(msg.timestamp),
    raw: body,
  };
}

/**
 * Download the message's media, if any, and attach it.
 *
 * This is the post-ack half of inbound parsing: the router calls it at the
 * start of the (detached) turn, so the download's 10s + 30s timeouts are
 * spent after Meta already has its 200 rather than in front of it.
 *
 * Degrades on failure: a message whose attachment could not be fetched still
 * reaches the agent as text, which is better than dropping the turn.
 */
export async function enrichWhatsAppInbound(
  message: InboundMessage,
): Promise<InboundMessage> {
  const value = firstMessageValue(message.raw as WhatsAppWebhookPayload);
  const msg = value?.messages?.[0];
  if (!msg) return message;

  const attachments = await collectAttachments(msg);
  if (attachments.length === 0) return message;

  return { ...message, attachments };
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * The text a message contributes to the conversation.
 *
 * Media messages contribute their caption; where there is none, a short
 * stated placeholder keeps the turn coherent, because the model receives the
 * attachment separately and an empty message reads as an error.
 */
function renderMessage(msg: WhatsAppInboundMessage): string {
  switch (msg.type) {
    case "text":
      return msg.text?.body ?? "";

    case "image":
      return msg.image?.caption ?? "[sent an image]";
    case "video":
      return msg.video?.caption ?? "[sent a video]";
    case "audio":
      return msg.audio?.voice ? "[sent a voice note]" : "[sent an audio file]";
    case "document":
      return (
        msg.document?.caption ??
        (msg.document?.filename
          ? `[sent a document: ${msg.document.filename}]`
          : "[sent a document]")
      );
    case "sticker":
      return "[sent a sticker]";

    case "location": {
      const loc = msg.location;
      if (!loc) return "[shared a location]";
      const label = [loc.name, loc.address].filter(Boolean).join(", ");
      const coords = `${loc.latitude}, ${loc.longitude}`;
      return label
        ? `[shared a location: ${label} (${coords})]`
        : `[shared a location: ${coords}]`;
    }

    case "contacts": {
      const people = (msg.contacts ?? [])
        .map((c) => {
          const name = c.name?.formatted_name ?? c.name?.first_name ?? "";
          const phone = c.phones?.[0]?.phone ?? "";
          return [name, phone].filter(Boolean).join(" ");
        })
        .filter(Boolean);
      return people.length > 0
        ? `[shared a contact: ${people.join("; ")}]`
        : "[shared a contact]";
    }

    case "interactive": {
      // A completed Flow is a turn: the agent resumes the conversation with
      // the form's outcome in hand ("the user finished the declaration —
      // documentId X"). The params are inlined because they ARE the message;
      // the full payload stays in `raw`.
      if (msg.interactive?.nfm_reply?.response_json) {
        return `[Completed the form] ${msg.interactive.nfm_reply.response_json}`;
      }
      // The title is what the user believes they said; the id is precise but
      // meaningless to a model. Title wins, id stays available in `raw`.
      const reply =
        msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      return reply?.title ?? "";
    }

    case "button":
      // Quick-reply button on a template message.
      return msg.button?.text ?? "";

    case "order":
      return msg.order?.text ?? "[sent an order]";

    case "unsupported":
      // View-once photos, disappearing messages, and anything the Cloud API
      // will not deliver. Rendered as a turn on purpose so the agent can say
      // something rather than leaving the user staring at silence.
      return "[sent something this channel can't open]";

    default:
      return msg.text?.body ?? "";
  }
}

async function collectAttachments(
  msg: WhatsAppInboundMessage,
): Promise<MediaAttachment[]> {
  const kind = mediaKind(msg.type);
  if (!kind) return [];
  if (!acceptsMediaKind(kind)) return [];

  const media = mediaObject(msg);
  if (!media?.id) return [];

  const downloaded = await downloadWhatsAppMedia(media.id);
  if (!downloaded) return [];

  return [
    {
      mimeType: media.mime_type ?? downloaded.mimeType,
      base64: downloaded.base64,
      filename: media.filename,
      sizeBytes: downloaded.sizeBytes,
    },
  ];
}

function mediaKind(
  type: string,
): "image" | "document" | "audio" | "video" | undefined {
  switch (type) {
    case "image":
      return "image";
    case "document":
      return "document";
    case "audio":
      return "audio";
    case "video":
      return "video";
    default:
      // Stickers are deliberately excluded: they are never worth a download.
      return undefined;
  }
}

function mediaObject(
  msg: WhatsAppInboundMessage,
): WhatsAppInboundMedia | undefined {
  return msg.image ?? msg.document ?? msg.audio ?? msg.video ?? undefined;
}

/** Text used for consent classification — never a placeholder. */
function plainText(msg: WhatsAppInboundMessage): string {
  if (msg.type === "text") return msg.text?.body ?? "";
  if (msg.type === "interactive") {
    return (
      msg.interactive?.button_reply?.title ??
      msg.interactive?.list_reply?.title ??
      ""
    );
  }
  if (msg.type === "button") return msg.button?.text ?? "";
  return "";
}

// ============================================================================
// Envelope
// ============================================================================

/** The first `messages`-field change value carrying an actual message. */
function firstMessageValue(
  payload: WhatsAppWebhookPayload,
): WhatsAppChangeValue | undefined {
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      if (change.value?.messages?.length) return change.value;
    }
  }
  return undefined;
}

function toMillis(timestamp: string | undefined): number {
  const n = Number(timestamp);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
}
