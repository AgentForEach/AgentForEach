/**
 * AgentForEach Channels — Consent / Opt-Out
 *
 * Honouring opt-out is a Meta policy requirement, and there are TWO
 * independent signals. A plugin that only watches for the keyword keeps
 * messaging people who opted out through WhatsApp's own interface:
 *
 *   1. Keyword — the user sends "STOP" (or a configured synonym) as a message.
 *      Recognised before the agent runs, so an opt-out is never interpreted.
 *   2. `user_preferences` webhook — WhatsApp's in-client marketing opt-out,
 *      which arrives as an event, not a message. See events.ts.
 *
 * Consent outranks everything: an opted-out chat gets no replies and no cron
 * deliveries.
 */

import { loadWhatsAppConfig } from "./config.js";
import { resolveTtlStore, type TtlStore } from "./kv-store.js";

/**
 * Opt-out does not expire on its own.
 *
 * Ten years is the store's way of saying "never" — the TTL exists because the
 * container has one, not because consent should lapse.
 */
const CONSENT_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

const OPTED_OUT = "out";
const OPTED_IN = "in";

let _store: TtlStore | undefined;
let _storePromise: Promise<TtlStore> | undefined;

async function store(): Promise<TtlStore> {
  if (_store) return _store;
  if (!_storePromise) {
    // Consent is never kept in memory by choice: forgetting an opt-out on
    // restart and resuming messaging is a policy violation, not a glitch.
    _storePromise = resolveTtlStore("whatsapp-consent", "cosmos").then((s) => {
      _store = s;
      return s;
    });
  }
  return _storePromise;
}

/** What a piece of inbound text means for consent, if anything. */
export type ConsentIntent = "opt-out" | "opt-in" | undefined;

/**
 * Classify message text against the configured keywords.
 *
 * Matching is on the whole trimmed message, case-insensitive, ignoring
 * trailing punctuation. Substring matching would silence anyone who wrote
 * "stop by tomorrow".
 */
export function classifyConsentText(text: string): ConsentIntent {
  const cfg = loadWhatsAppConfig();
  const normalised = text.trim().toLowerCase().replace(/[.!]+$/, "");
  if (!normalised) return undefined;

  if (cfg.optOutKeywords.includes(normalised)) return "opt-out";
  if (cfg.optInKeywords.includes(normalised)) return "opt-in";
  return undefined;
}

/** Whether this chat has opted out of messaging. */
export async function isOptedOut(chatId: string): Promise<boolean> {
  const s = await store();
  return (await s.get(chatId)) === OPTED_OUT;
}

/** Record an opt-out (from a keyword or a user_preferences event). */
export async function setOptedOut(chatId: string): Promise<void> {
  const s = await store();
  await s.set(chatId, OPTED_OUT, CONSENT_TTL_SECONDS);
}

/** Record an opt-in, re-enabling messaging. */
export async function setOptedIn(chatId: string): Promise<void> {
  const s = await store();
  await s.set(chatId, OPTED_IN, CONSENT_TTL_SECONDS);
}

/** Test helper — forget the resolved store. */
export function resetConsentStore(): void {
  _store = undefined;
  _storePromise = undefined;
}

/** Test helper — inject a store directly. */
export function setConsentStore(s: TtlStore): void {
  _store = s;
  _storePromise = Promise.resolve(s);
}
