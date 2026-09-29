/**
 * AgentForEach Channels — 24-Hour Customer Service Window
 *
 * WhatsApp only permits free-form messages within 24 hours of the user's last
 * inbound message. Outside it, sends are rejected with 131047 and the only
 * legal path is an approved template.
 *
 * This is the biggest behavioural difference from Telegram and it is invisible
 * to the channels framework: cron delivery and every proactive send simply
 * start failing once a conversation goes quiet. Tracking the window lets the
 * plugin choose the template path deliberately instead of discovering the
 * rejection.
 *
 * The window resets on each inbound message, so the stored timestamp is
 * overwritten rather than accumulated.
 */

import { loadWhatsAppConfig } from "./config.js";
import { resolveTtlStore, type TtlStore } from "./kv-store.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** A stored timestamp is useless once the window it describes has closed. */
const WINDOW_TTL_SECONDS = 25 * 60 * 60;

let _store: TtlStore | undefined;
let _storePromise: Promise<TtlStore> | undefined;

async function store(): Promise<TtlStore> {
  if (_store) return _store;
  if (!_storePromise) {
    const backend = loadWhatsAppConfig().windowStore;
    _storePromise = resolveTtlStore("whatsapp-window", backend).then((s) => {
      _store = s;
      return s;
    });
  }
  return _storePromise;
}

/** Record that the user sent us a message, opening (or resetting) the window. */
export async function recordInbound(
  chatId: string,
  atMs: number = Date.now(),
): Promise<void> {
  const s = await store();
  await s.set(chatId, String(atMs), WINDOW_TTL_SECONDS);
}

/**
 * Whether a free-form message may be sent to this chat right now.
 *
 * An unknown chat reports closed. That is the safe direction: treating an
 * unknown chat as open produces a 131047 at send time, while treating it as
 * closed routes through the template path, which is legal in both states.
 */
export async function isWindowOpen(
  chatId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const s = await store();
  const raw = await s.get(chatId);
  if (!raw) return false;

  const lastInboundMs = Number(raw);
  if (!Number.isFinite(lastInboundMs)) return false;

  return nowMs - lastInboundMs < WINDOW_MS;
}

/** Test helper — forget the resolved store. */
export function resetWindowStore(): void {
  _store = undefined;
  _storePromise = undefined;
}

/** Test helper — inject a store directly. */
export function setWindowStore(s: TtlStore): void {
  _store = s;
  _storePromise = Promise.resolve(s);
}
