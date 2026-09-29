/**
 * AgentForEach Channels — Telegram Webhook Verification
 *
 * Verifies the authenticity of incoming Telegram webhook requests
 * using the X-Telegram-Bot-Api-Secret-Token header.
 *
 * This is separate from the auth provider chain (which handles user-facing APIs).
 * Telegram webhook verification is a server-to-server concern.
 *
 * @see handlers/ws-security.ts — verifyUpstreamSecret() (same timing-safe pattern)
 * @see https://core.telegram.org/bots/api#setwebhook — secret_token parameter
 */

import { timingSafeEqual } from "node:crypto";
import { allowUnsignedWebhooks } from "../../utils/index.js";
import { loadTelegramConfig } from "./config.js";

/**
 * Verify a Telegram webhook request by checking the secret token header.
 *
 * Telegram sends the secret_token (configured during setWebhook) in the
 * `X-Telegram-Bot-Api-Secret-Token` header. We do a timing-safe comparison
 * to prevent timing attacks.
 *
 * If no webhookSecretToken is configured, verification is skipped
 * (returns true). This allows development without setting up webhook secrets,
 * but is not recommended for production.
 *
 * @param headers - Request headers (lowercase keys).
 * @param _body - Raw request body (unused for Telegram, part of the ChannelPlugin interface).
 * @returns true if the request is authentic.
 */
export function verifyTelegramWebhook(
  headers: Record<string, string>,
  _body: string,
): boolean {
  const config = loadTelegramConfig();

  // No secret: reject, unless unsigned webhooks were explicitly allowed for local development.
  if (!config.webhookSecretToken) return allowUnsignedWebhooks();

  const headerValue = headers["x-telegram-bot-api-secret-token"] ?? "";

  if (!headerValue) return false;

  try {
    const expected = Buffer.from(config.webhookSecretToken, "utf-8");
    const actual = Buffer.from(headerValue, "utf-8");

    if (expected.length !== actual.length) return false;

    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
