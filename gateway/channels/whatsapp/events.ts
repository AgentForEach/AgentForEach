/**
 * AgentForEach Channels — WhatsApp Non-Message Events
 *
 * The Cloud API delivers more than twenty subscribable fields to the same
 * webhook. Only `messages` carries conversations; everything else describes
 * the state of the number, the account, the templates, or the user's own
 * preferences.
 *
 * Two of them change behaviour and are acted on here:
 *
 *   - `user_preferences` — WhatsApp's in-client marketing opt-out. It arrives
 *     as an event, never as a message, so a plugin that only watches for the
 *     word STOP will keep messaging people who opted out through the WhatsApp
 *     interface. That is the policy violation this file exists to prevent.
 *   - `messages` / `statuses[]` — delivery receipts, including the errors that
 *     explain a silent non-delivery.
 *
 * The rest are logged rather than ignored. `phone_number_quality_update` and
 * `account_alerts` in particular are the only warning you get before messaging
 * limits tighten, and they are worthless if they land in a dropped payload.
 *
 * By contract this runs fire-and-forget and never starts an agent turn.
 */

import type {
  WhatsAppWebhookPayload,
  WhatsAppStatus,
  WhatsAppChange,
} from "./types.js";
import { setOptedOut, setOptedIn } from "./consent.js";
import { WhatsAppErrorCode } from "./errors.js";
import { redactId } from "../../utils/redact.js";

/** Fields worth a visible log line when they arrive. */
const NOTABLE_FIELDS = new Set([
  "account_alerts",
  "account_review_update",
  "account_update",
  "business_capability_update",
  "message_template_status_update",
  "message_template_quality_update",
  "phone_number_quality_update",
  "phone_number_name_update",
  "security",
]);

/**
 * Handle a webhook payload that carried no inbound message.
 */
export async function handleWhatsAppEvent(body: unknown): Promise<void> {
  const payload = body as WhatsAppWebhookPayload;

  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      await handleChange(change);
    }
  }
}

async function handleChange(change: WhatsAppChange): Promise<void> {
  const field = change?.field;
  if (!field) return;

  if (field === "messages") {
    for (const status of change.value?.statuses ?? []) {
      await recordStatus(status);
    }
    return;
  }

  if (field === "user_preferences") {
    await handleUserPreferences(change);
    return;
  }

  if (NOTABLE_FIELDS.has(field)) {
    console.warn(
      `[whatsapp] ${field}: ${safeSummary(change.value)}`,
    );
    return;
  }

  console.log(`[whatsapp] event ${field} received`);
}

/**
 * Apply WhatsApp's own marketing opt-out.
 *
 * The payload is a list of per-user preferences; Meta documents the values
 * "stop" and "resume" (category "marketing_messages"). Synonymous values are
 * tolerated on both sides, but an UNRECOGNISED value changes nothing: an
 * ambiguous signal must neither start messaging someone who opted out nor
 * silence someone who didn't, so only an explicit resume re-enables.
 */
async function handleUserPreferences(change: WhatsAppChange): Promise<void> {
  const prefs = (change.value?.["user_preferences"] ?? []) as Array<{
    wa_id?: string;
    detail?: string;
    category?: string;
    value?: string;
    timestamp?: string;
  }>;

  if (!Array.isArray(prefs)) return;

  for (const pref of prefs) {
    const waId = pref?.wa_id;
    if (!waId) continue;

    const value = String(pref.value ?? "").toLowerCase();
    const optedOut = value === "stop" || value === "blocked" || value === "off";

    if (optedOut) {
      await setOptedOut(waId);
      console.warn(
        `[whatsapp] user_preferences opt-out for ${redactId(waId)}` +
          (pref.category ? ` (${pref.category})` : ""),
      );
    } else if (value === "resume" || value === "on") {
      await setOptedIn(waId);
      console.log(`[whatsapp] user_preferences opt-in for ${redactId(waId)}`);
    }
  }
}

/**
 * Record an outbound delivery status.
 *
 * `failed` carries the reason, and it is the only place some failures are ever
 * explained — a send can return 200 and then fail asynchronously. One failure
 * code changes state rather than just logging: 131050 means the user opted
 * out of marketing messages, so it is written to the consent store — the next
 * send is then refused locally instead of bounced remotely.
 */
async function recordStatus(status: WhatsAppStatus): Promise<void> {
  if (status.status === "failed") {
    const errors = status.errors ?? [];
    const detail = errors
      .map((e) => `${e.code}${e.title ? ` ${e.title}` : ""}`)
      .join(", ");
    console.error(
      `[whatsapp] message ${status.id} to ${redactId(status.recipient_id)} failed` +
        (detail ? `: ${detail}` : ""),
    );

    if (
      status.recipient_id &&
      errors.some((e) => e.code === WhatsAppErrorCode.MARKETING_OPT_OUT)
    ) {
      await setOptedOut(status.recipient_id);
      console.warn(
        `[whatsapp] recorded opt-out for ${redactId(status.recipient_id)} from a ` +
          `131050 delivery failure`,
      );
    }
    return;
  }

  console.log(
    `[whatsapp] message ${status.id} to ${redactId(status.recipient_id)} ${status.status}`,
  );
}

function safeSummary(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json.length > 400 ? `${json.slice(0, 399)}…` : json;
  } catch {
    return "(unserialisable)";
  }
}
