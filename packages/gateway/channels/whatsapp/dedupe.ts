/**
 * AgentForEach Channels — Inbound Message Deduplication
 *
 * Meta redelivers a webhook whose endpoint returned anything other than 200,
 * "with decreasing frequency until the request succeeds, for up to 7 days".
 * Retries also fan out to every app subscribed to the WABA.
 *
 * That retry window is why this store defaults to durable. A ten-minute
 * in-memory set — the obvious first implementation — loses its contents to a
 * redeploy or a cold start, and the agent then answers a days-old message as
 * if it had just arrived. The failure is invisible in testing, because nothing
 * in a normal test run waits seven days or restarts the process.
 *
 * The store is keyed by `wamid`, the id Meta assigns each inbound message.
 */

import { loadWhatsAppConfig } from "./config.js";
import { resolveTtlStore, type TtlStore } from "./kv-store.js";

/** Slightly longer than Meta's 7-day retry window. */
const DEDUPE_TTL_SECONDS = 8 * 24 * 60 * 60;

let _store: TtlStore | undefined;
let _storePromise: Promise<TtlStore> | undefined;

async function store(): Promise<TtlStore> {
  if (_store) return _store;
  if (!_storePromise) {
    const backend = loadWhatsAppConfig().dedupeStore;
    _storePromise = resolveTtlStore("whatsapp-dedupe", backend).then((s) => {
      _store = s;
      return s;
    });
  }
  return _storePromise;
}

/**
 * Claim a message id for processing.
 *
 * Returns true when this is the first time we have seen the id — the caller
 * should process the message. Returns false when it is a redelivery.
 *
 * The claim is written before the agent runs, not after. A message that is
 * claimed and then fails mid-turn is deliberately NOT reprocessed on
 * redelivery: answering once and failing is recoverable, while answering the
 * same person three times because each attempt timed out is not. (The durable
 * inbound orchestration is what makes a claimed-then-interrupted turn rare —
 * see handlers/channel-webhook.ts.)
 *
 * The claim is a single atomic add, not a get-then-set: Meta's retries fan
 * out to every subscribed app and the gateway scales out, so two deliveries
 * of one wamid can genuinely race.
 */
export async function claimMessage(messageId: string): Promise<boolean> {
  if (!messageId) return true;

  const s = await store();
  return s.add(messageId, "1", DEDUPE_TTL_SECONDS);
}

/** Test helper — forget the resolved store so config changes take effect. */
export function resetDedupeStore(): void {
  _store = undefined;
  _storePromise = undefined;
}

/** Test helper — inject a store directly. */
export function setDedupeStore(s: TtlStore): void {
  _store = s;
  _storePromise = Promise.resolve(s);
}
