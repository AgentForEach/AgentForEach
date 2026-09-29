/**
 * AgentForEach Channels — WhatsApp Webhook Verification
 *
 * Two independent checks, both required in production:
 *
 *   1. GET handshake — Meta registers a webhook by calling GET with
 *      `hub.mode=subscribe`, `hub.verify_token` and `hub.challenge`, and
 *      expects the challenge echoed back as plain text.
 *   2. POST signature — every delivered payload carries a
 *      `X-Hub-Signature-256` HMAC of the RAW body, keyed by the app secret.
 *
 * The signature must be computed over the exact bytes Meta sent. The channel
 * webhook handler passes the raw string through for this reason; re-serialising
 * the parsed JSON produces a different digest and rejects every request.
 *
 * @see channels/telegram/verify.ts — same seam, shared-secret header instead
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { allowUnsignedWebhooks } from "../../utils/index.js";
import { loadWhatsAppConfig } from "./config.js";

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body.
 *
 * If no app secret is configured, verification is skipped (returns true). That
 * allows local development against a tunnel without a secret, and is called
 * out loudly here because an unsigned public webhook lets anyone inject
 * messages that look like they came from Meta.
 *
 * @param headers - Request headers (lowercase keys).
 * @param body - Raw request body string, exactly as received.
 */
export function verifyWhatsAppWebhook(
  headers: Record<string, string>,
  body: string,
): boolean {
  const config = loadWhatsAppConfig();

  // No secret: reject, unless unsigned webhooks were explicitly allowed for local development.
  if (!config.appSecret) return allowUnsignedWebhooks();

  const headerValue = headers["x-hub-signature-256"] ?? "";
  if (!headerValue.startsWith("sha256=")) return false;

  const provided = headerValue.slice("sha256=".length);

  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(provided, "hex");
  } catch {
    return false;
  }

  // A malformed hex string decodes to a short buffer rather than throwing,
  // so the length check below is what actually rejects it.
  const expected = createHmac("sha256", config.appSecret)
    .update(body, "utf8")
    .digest();

  if (providedBuf.length !== expected.length) return false;

  return timingSafeEqual(providedBuf, expected);
}

/**
 * Answer Meta's GET verification handshake.
 *
 * Returns the challenge to echo, or undefined to reject with 403.
 *
 * Unlike the signature check there is no dev-mode bypass: without a configured
 * verify token there is nothing to compare against, and echoing an arbitrary
 * challenge would let anyone point their own Meta app at this endpoint.
 */
export function verifyWhatsAppChallenge(
  query: Record<string, string>,
): string | undefined {
  const config = loadWhatsAppConfig();

  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  if (mode !== "subscribe") return undefined;
  if (!challenge) return undefined;
  if (!config.webhookVerifyToken) return undefined;
  if (!token) return undefined;

  const expected = Buffer.from(config.webhookVerifyToken, "utf8");
  const actual = Buffer.from(token, "utf8");

  if (expected.length !== actual.length) return undefined;
  if (!timingSafeEqual(expected, actual)) return undefined;

  return challenge;
}
