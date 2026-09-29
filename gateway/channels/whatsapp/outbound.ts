/**
 * AgentForEach Channels — WhatsApp Outbound
 *
 * Sends through the Cloud API using native fetch. No SDK: Meta's official
 * Node SDK is archived and pins Cloud API v16.0, and the surface we need is
 * about fifteen endpoints of plain REST.
 *
 * Every send passes three gates before it reaches the wire:
 *
 *   1. Consent — an opted-out chat is never messaged, for any reason.
 *   2. The 24-hour service window — free-form outside it is rejected by Meta
 *      (131047), so a closed window routes to an approved template or fails
 *      loudly. It never silently drops.
 *   3. Error classification — throughput errors are retried with jittered
 *      backoff; terminal ones are surfaced, because retrying 131047 forever is
 *      the classic way to burn quota against a wall.
 *
 * @see channels/telegram/outbound.ts — same shape, none of the gates
 */

import type {
  OutboundContext,
  OutboundResult,
  OutboundPayload,
} from "../types.js";
import type {
  WhatsAppConfig,
  WhatsAppOutboundMessage,
  WhatsAppInteractive,
  WhatsAppReadReceipt,
} from "./types.js";
import { loadWhatsAppConfig, phoneNumberUrl } from "./config.js";
import { splitMessage } from "../util/split.js";
import { isOptedOut } from "./consent.js";
import { isWindowOpen } from "./window.js";
import {
  postMessage,
  authHeaders,
  describeFailure,
  SEND_TIMEOUT_MS,
} from "./transport.js";
import { isStaleMediaError } from "./errors.js";
import { fit, truncate } from "./format.js";
import { sendTemplateFallback } from "./templates.js";
import { resolveMediaId, invalidateMediaId } from "./media.js";
import { redactId } from "../../utils/redact.js";

/** WhatsApp's own caps on interactive components. */
const LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  listRowsTotal: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  listButton: 20,
  interactiveBody: 1024,
} as const;

// ============================================================================
// Public API
// ============================================================================

/**
 * Send a message through the Cloud API.
 */
export async function sendWhatsAppMessage(
  context: OutboundContext,
): Promise<OutboundResult> {
  const cfg = loadWhatsAppConfig();

  if (!cfg.accessToken || !cfg.phoneNumberId) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }

  if (await isOptedOut(context.chatId)) {
    return {
      success: false,
      error: `Recipient ${redactId(context.chatId)} has opted out of messages`,
    };
  }

  if (!(await isWindowOpen(context.chatId))) {
    // Free-form is not legal here. templates.ts either sends an approved
    // template or explains, in the error, exactly which one was missing.
    return sendTemplateFallback(cfg, context);
  }

  if (context.payload) {
    const result = await sendPayload(cfg, context, context.payload);
    // A payload that could not be rendered falls back to the text, which the
    // OutboundPayload contract guarantees is a complete message on its own.
    if (result) return result;
  }

  return sendText(cfg, context);
}

/**
 * Send plain text without the consent gate.
 *
 * Reserved for the confirmations that answer a consent keyword: refusing to
 * acknowledge STOP because the user just opted out would leave them with no
 * evidence it worked.
 */
export async function sendPlainText(
  chatId: string,
  text: string,
): Promise<OutboundResult> {
  const cfg = loadWhatsAppConfig();
  if (!cfg.accessToken || !cfg.phoneNumberId) {
    return { success: false, error: "WhatsApp credentials not configured" };
  }
  return sendText(cfg, { chatId, text });
}

/**
 * Mark an inbound message read, optionally showing a typing indicator.
 *
 * One call does both. Note the indicator dismisses itself after 25 seconds or
 * when the reply lands, whichever comes first — a tool-heavy turn will often
 * outlive it, and that is accepted rather than papered over with a refresh
 * loop that costs an API call every 25 seconds of thinking.
 */
export async function markReadAndTyping(
  messageId: string,
  typing: boolean,
): Promise<void> {
  const cfg = loadWhatsAppConfig();
  if (!cfg.accessToken || !cfg.phoneNumberId || !messageId) return;

  const body: WhatsAppReadReceipt = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    ...(typing ? { typing_indicator: { type: "text" as const } } : {}),
  };

  try {
    await fetch(`${phoneNumberUrl(cfg)}/messages`, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    // A read receipt is a courtesy. Losing one must never cost the turn.
  }
}

// ============================================================================
// Text
// ============================================================================

async function sendText(
  cfg: WhatsAppConfig,
  context: OutboundContext,
): Promise<OutboundResult> {
  const chunks = splitMessage(context.text, cfg.maxMessageLength);
  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const message: WhatsAppOutboundMessage = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: context.chatId,
      type: "text",
      text: { body: chunks[i], preview_url: true },
      // Only the first chunk quotes the message being replied to.
      ...(i === 0 && context.replyToMessageId
        ? { context: { message_id: context.replyToMessageId } }
        : {}),
    };

    const result = await postMessage(cfg, message);
    if (!result.ok) {
      return { success: false, error: describeFailure(result.failure) };
    }
    lastMessageId = result.value;
  }

  return { success: true, messageId: lastMessageId };
}

// ============================================================================
// Structured payloads
// ============================================================================

/**
 * Render an OutboundPayload.
 *
 * Returns undefined when the payload cannot be represented, so the caller
 * falls back to plain text rather than sending nothing.
 */
async function sendPayload(
  cfg: WhatsAppConfig,
  context: OutboundContext,
  payload: OutboundPayload,
): Promise<OutboundResult | undefined> {
  if (payload.kind === "media") {
    return sendMedia(cfg, context, payload);
  }

  const interactive = buildInteractive(payload);
  if (!interactive) return undefined;

  const message: WhatsAppOutboundMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: context.chatId,
    type: "interactive",
    interactive,
    ...(context.replyToMessageId
      ? { context: { message_id: context.replyToMessageId } }
      : {}),
  };

  const result = await postMessage(cfg, message);
  return result.ok
    ? { success: true, messageId: result.value }
    : { success: false, error: describeFailure(result.failure) };
}

function buildInteractive(
  payload: Exclude<OutboundPayload, { kind: "media" }>,
): WhatsAppInteractive | undefined {
  if (payload.kind === "buttons") {
    const buttons = payload.buttons.slice(0, LIMITS.buttons);
    if (buttons.length === 0) return undefined;

    return {
      type: "button",
      // Truncate only: the interactive body renders WhatsApp's formatting
      // vocabulary and keeps its newlines, so `fit`'s flattening would wreck
      // a multi-paragraph prompt. Stripping stays reserved for the tightly
      // capped labels below.
      body: { text: truncate(payload.body, LIMITS.interactiveBody) },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply" as const,
          reply: { id: b.id, title: fit(b.title, LIMITS.buttonTitle) },
        })),
      },
    };
  }

  // Lists cap at ten rows across ALL sections combined, not per section.
  let budget = LIMITS.listRowsTotal;
  const sections = [];

  for (const section of payload.sections) {
    if (budget <= 0) break;
    const rows = section.rows.slice(0, budget);
    if (rows.length === 0) continue;
    budget -= rows.length;

    sections.push({
      title: section.title ? fit(section.title, LIMITS.listRowTitle) : undefined,
      rows: rows.map((r) => ({
        id: r.id,
        title: fit(r.title, LIMITS.listRowTitle),
        ...(r.description
          ? { description: fit(r.description, LIMITS.listRowDescription) }
          : {}),
      })),
    });
  }

  if (sections.length === 0) return undefined;

  return {
    type: "list",
    body: { text: truncate(payload.body, LIMITS.interactiveBody) },
    action: {
      button: fit(payload.button, LIMITS.listButton),
      sections,
    },
  };
}

async function sendMedia(
  cfg: WhatsAppConfig,
  context: OutboundContext,
  payload: Extract<OutboundPayload, { kind: "media" }>,
): Promise<OutboundResult | undefined> {
  // Prefer an id over a link: link sends are fetched through Meta's shared
  // forward proxy and rate-limited by ASN (131053). See media.ts.
  //
  // The caller's declared MIME type wins — Meta validates uploads against
  // it, and guessing from the media kind mislabels every PNG as a JPEG.
  const mime = payload.mimeType ?? mimeFor(payload.mediaType, payload.filename);

  let mediaId = payload.mediaId;
  let fromCache = false;

  if (!mediaId && payload.base64) {
    const resolved = await resolveMediaId(
      payload.base64,
      mime,
      payload.filename ?? "upload",
    );
    mediaId = resolved?.id;
    fromCache = resolved?.cached ?? false;
  }

  if (!mediaId && !payload.url) return undefined;

  const first = await postMedia(cfg, context, payload, mediaId);
  if (first.ok) return { success: true, messageId: first.value };

  /*
   * A cached handle that has outlived Meta's 30-day retention fails with
   * 131052 and will fail identically forever — the one send failure that is
   * fixed by doing more work rather than by waiting.
   *
   * Only a CACHED id earns the retry. A handle we just uploaded and were
   * immediately told is invalid means something else is wrong, and uploading
   * the same bytes again would only produce the same answer.
   */
  if (fromCache && payload.base64 && isStaleMediaError(first.failure)) {
    await invalidateMediaId(payload.base64, mime);

    const fresh = await resolveMediaId(
      payload.base64,
      mime,
      payload.filename ?? "upload",
    );

    if (fresh) {
      const second = await postMedia(cfg, context, payload, fresh.id);
      if (second.ok) return { success: true, messageId: second.value };
      return { success: false, error: describeFailure(second.failure) };
    }
  }

  return { success: false, error: describeFailure(first.failure) };
}

/** Build and post one media message with a specific handle (or the link). */
async function postMedia(
  cfg: WhatsAppConfig,
  context: OutboundContext,
  payload: Extract<OutboundPayload, { kind: "media" }>,
  mediaId: string | undefined,
) {
  const media = {
    ...(mediaId ? { id: mediaId } : { link: payload.url }),
    ...(payload.caption ? { caption: payload.caption } : {}),
    ...(payload.filename && payload.mediaType === "document"
      ? { filename: payload.filename }
      : {}),
  };

  const message: WhatsAppOutboundMessage = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: context.chatId,
    type: payload.mediaType,
    [payload.mediaType]: media,
  } as WhatsAppOutboundMessage;

  return postMessage(cfg, message);
}

function mimeFor(
  kind: "image" | "document" | "audio" | "video",
  filename?: string,
): string {
  if (kind === "document" && filename?.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }
  switch (kind) {
    case "image":
      return "image/jpeg";
    case "audio":
      return "audio/ogg";
    case "video":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}
