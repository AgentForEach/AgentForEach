/**
 * AgentForEach Channels — Telegram Barrel + Self-Registration
 *
 * Re-exports all Telegram channel public API, and auto-registers
 * the Telegram plugin + delivery adapter when the channel is enabled.
 *
 * Registration is gated on config: if Telegram is not configured
 * (no botToken or enabled: false), nothing is registered and no
 * errors are thrown. This matches the graceful degradation pattern
 * used throughout AgentForEach (e.g., websocket provider fallback to "noop").
 *
 * @see llms/index.ts — same self-registration pattern for providers
 * @see websocket/push-adapter.ts — same self-registration for delivery adapter
 */

// — Types —
export type {
  TelegramUser,
  TelegramChat,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramUpdate,
  TelegramSendMessageResponse,
  TelegramConfig,
} from "./types.js";

// — Config —
export { loadTelegramConfig, resetTelegramConfig } from "./config.js";

// — Verification —
export { verifyTelegramWebhook } from "./verify.js";

// — Inbound / Outbound —
export { parseTelegramUpdate } from "./inbound.js";
export { sendTelegramMessage } from "./outbound.js";

// — Formatting —
export { markdownToTelegramHtml, stripFormatting } from "./format.js";

// — Plugin —
export { createTelegramPlugin } from "./plugin.js";

// — Delivery —
export { telegramDeliveryAdapter } from "./delivery.js";

// ============================================================================
// Auto-registration (side-effect on import)
// ============================================================================

import { registerChannel } from "../registry.js";
import { createTelegramPlugin } from "./plugin.js";
import { registerTelegramDeliveryAdapter } from "./delivery.js";
import { loadTelegramConfig, telegramRegistrationBlocker } from "./config.js";

const _telegramConfig = loadTelegramConfig();

if (_telegramConfig.enabled) {
  const blocker = telegramRegistrationBlocker();
  if (blocker) {
    console.error(`[telegram] channel NOT registered: ${blocker}`);
  } else {
    registerChannel(createTelegramPlugin());
    registerTelegramDeliveryAdapter();
  }
}
