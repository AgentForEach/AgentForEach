/**
 * AgentForEach Channels — Telegram Config Resolver
 *
 * Extracts and resolves Telegram-specific config from the
 * "channels.telegram" section of agentforeach.json.
 *
 * Bot token and webhook secret support $ENV_VAR references
 * (resolved via utils/env.ts resolveEnvValue).
 *
 * @see channels/config.ts — getChannelConfig()
 * @see utils/env.ts — resolveEnvValue()
 */

import { isCloudRuntime, resolveEnvValue } from "../../utils/index.js";
import { getChannelConfig, identityFallbackIsUnsafe } from "../config.js";
import type { TelegramChannelJsonConfig } from "../types.js";
import type { TelegramConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS = {
  maxMessageLength: 4096,
  defaultUserId: "telegram-user",
} as const;

// ============================================================================
// Lazy-Cached Config Loader
// ============================================================================

let _cfg: TelegramConfig | undefined;

/**
 * Load and resolve the Telegram channel configuration.
 *
 * Secrets (botToken, webhookSecretToken) support $ENV_VAR references.
 * The channel is considered enabled only if `enabled !== false` AND
 * a bot token is available.
 *
 * Cached after first load.
 */
export function loadTelegramConfig(): TelegramConfig {
  if (_cfg) return _cfg;

  const raw = getChannelConfig<TelegramChannelJsonConfig>("telegram");

  const botToken = resolveEnvValue(raw?.botToken) ?? "";
  const webhookSecretToken = resolveEnvValue(raw?.webhookSecretToken);

  _cfg = {
    enabled: raw?.enabled !== false && !!botToken,
    botToken,
    webhookSecretToken: webhookSecretToken || undefined,
    // JSON numbers are common here (Telegram ids are numeric); compare as strings.
    authorizedSenders: (raw?.authorizedSenders ?? []).map((x) => String(x).trim()).filter(Boolean),
    defaultUserId: raw?.defaultUserId ?? DEFAULTS.defaultUserId,
    maxMessageLength: raw?.maxMessageLength ?? DEFAULTS.maxMessageLength,
  };

  return _cfg;
}

/**
 * Reset cached config. For testing only.
 */
export function resetTelegramConfig(): void {
  _cfg = undefined;
}

/**
 * Why the Telegram channel must not register, or null when it may.
 *
 * - Without authorizedSenders and with identity falling back to
 *   "config-default", every stranger who messages the bot would act as
 *   defaultUserId and see that user's data.
 * - In the cloud, a missing webhook secret would let anyone who finds the
 *   endpoint post forged updates.
 */
export function telegramRegistrationBlocker(): string | null {
  const cfg = loadTelegramConfig();
  if (identityFallbackIsUnsafe(cfg.authorizedSenders)) {
    return (
      'identity.fallbackMode is "config-default" and channels.telegram.authorizedSenders ' +
      "is empty, so any stranger messaging the bot would resolve to the default user. " +
      "Set authorizedSenders (numeric Telegram user ids), or change the identity fallback mode."
    );
  }
  if (isCloudRuntime() && !cfg.webhookSecretToken) {
    return (
      "no webhook secret (channels.telegram.webhookSecretToken / TELEGRAM_WEBHOOK_SECRET), " +
      "so forged webhook calls can't be told apart. Set it and pass it as secret_token to setWebhook."
    );
  }
  return null;
}
