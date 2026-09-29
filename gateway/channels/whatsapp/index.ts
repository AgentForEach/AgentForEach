/**
 * AgentForEach Channels — WhatsApp Barrel + Self-Registration
 *
 * Re-exports the WhatsApp channel's public API, and auto-registers the plugin
 * and delivery adapter when the channel is configured and safe to enable.
 *
 * Registration is gated on config: an unconfigured channel registers nothing
 * and throws nothing, matching the graceful degradation used throughout AgentForEach.
 *
 * @see channels/telegram/index.js — same self-registration pattern
 */

// — Types —
export type {
  WhatsAppConfig,
  ResolvedTemplateRef,
  WhatsAppInboundType,
  WhatsAppInboundMessage,
  WhatsAppWebhookPayload,
  WhatsAppOutboundMessage,
  WhatsAppStatus,
} from "./types.js";

// — Config —
export {
  loadWhatsAppConfig,
  resetWhatsAppConfig,
  whatsappRegistrationBlocker,
  normalisePhone,
  phoneNumberUrl,
  graphUrl,
} from "./config.js";

// — Verification —
export { verifyWhatsAppWebhook, verifyWhatsAppChallenge } from "./verify.js";

// — Inbound / Outbound —
export { parseWhatsAppWebhook, enrichWhatsAppInbound } from "./inbound.js";
export { handleWhatsAppEvent } from "./events.js";
export {
  sendWhatsAppMessage,
  sendPlainText,
  markReadAndTyping,
} from "./outbound.js";
export { sendTemplateFallback, REENGAGE_TEMPLATE_KEY } from "./templates.js";

// — Formatting —
export { markdownToWhatsApp, stripFormatting, fit, truncate } from "./format.js";

// — Media —
export {
  downloadWhatsAppMedia,
  uploadWhatsAppMedia,
  resolveMediaId,
  invalidateMediaId,
  mediaCacheKey,
  setMediaIdCache,
  resetMediaIdCache,
  acceptsMediaKind,
  isSupportedImageType,
  PLATFORM_MEDIA_LIMITS,
  type ResolvedMediaId,
} from "./media.js";

// — State —
export { claimMessage, resetDedupeStore, setDedupeStore } from "./dedupe.js";
export {
  recordInbound,
  isWindowOpen,
  resetWindowStore,
  setWindowStore,
} from "./window.js";
export {
  classifyConsentText,
  isOptedOut,
  setOptedOut,
  setOptedIn,
  resetConsentStore,
  setConsentStore,
} from "./consent.js";
export {
  MemoryTtlStore,
  CosmosTtlStore,
  resolveTtlStore,
  type TtlStore,
} from "./kv-store.js";

// — Errors —
export {
  WhatsAppErrorCode,
  classifyError,
  isStaleMediaError,
  backoffDelayMs,
  withRetry,
  type WhatsAppFailure,
} from "./errors.js";

// — Plugin —
export { createWhatsAppPlugin } from "./plugin.js";

// — Delivery —
export { whatsappDeliveryAdapter } from "./delivery.js";

// ============================================================================
// Auto-registration (side-effect on import)
// ============================================================================

import { registerChannel } from "../registry.js";
import { createWhatsAppPlugin } from "./plugin.js";
import { registerWhatsAppDeliveryAdapter } from "./delivery.js";
import { loadWhatsAppConfig, whatsappRegistrationBlocker } from "./config.js";

const _whatsappConfig = loadWhatsAppConfig();

if (_whatsappConfig.enabled) {
  /*
   * A WhatsApp number is public: anyone can message it. The channel refuses
   * to start when a stranger would resolve into the default user's workspace,
   * or (in the cloud) when webhook signatures can't be verified.
   */
  const blocker = whatsappRegistrationBlocker();
  if (blocker) {
    console.error(`[whatsapp] channel NOT registered: ${blocker}`);
  } else {
    if (!_whatsappConfig.appSecret) {
      console.warn(
        "[whatsapp] appSecret not configured: webhooks are rejected unless " +
          "ALLOW_UNSIGNED_WEBHOOKS=true (local development only).",
      );
    }
    registerChannel(createWhatsAppPlugin());
    registerWhatsAppDeliveryAdapter();
  }
}
