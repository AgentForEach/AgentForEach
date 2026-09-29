/**
 * AgentForEach Channels — WhatsApp Config Resolver
 *
 * Extracts and resolves WhatsApp-specific config from the "channels.whatsapp"
 * section of agentforeach.json.
 *
 * All secrets support $ENV_VAR references (resolved via utils/env.ts).
 *
 * @see channels/config.ts — getChannelConfig()
 * @see channels/telegram/config.ts — same shape, same caching
 */

import { resolveEnvValue } from "../../utils/index.js";
import { getChannelConfig, identityFallbackIsUnsafe } from "../config.js";
import { isCloudRuntime } from "../../utils/index.js";
import type {
  WhatsAppChannelJsonConfig,
  WhatsAppTemplateRef,
} from "../types.js";
import type { WhatsAppConfig, ResolvedTemplateRef } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS = {
  apiBase: "https://graph.facebook.com",
  /**
   * Graph API versions are supported for roughly two years from release and
   * are then removed. This default is a config knob precisely so the upgrade
   * is never a code change — but it does need reviewing about annually.
   *
   * v26.0 shipped 2026-07-29; the oldest still-supported version is v24.0.
   * Next review: mid-2027.
   */
  apiVersion: "v26.0",
  /** WhatsApp text bodies cap at 4096 characters. */
  maxMessageLength: 4096,
  defaultUserId: "whatsapp-user",
  optOutKeywords: ["stop"],
  optInKeywords: ["start"],
  /**
   * Images only by default, matching Telegram's behaviour of passing
   * vision-capable media and skipping the rest. The gateway is serverless and
   * a 100 MB document becomes ~133 MB of base64 in a function heap.
   */
  acceptInboundMedia: ["image"] as Array<
    "image" | "document" | "audio" | "video"
  >,
  /** Meta's own image ceiling. Below the document/video ceilings on purpose. */
  maxInboundMediaBytes: 5 * 1024 * 1024,
} as const;

// ============================================================================
// Lazy-Cached Config Loader
// ============================================================================

let _cfg: WhatsAppConfig | undefined;

/**
 * Load and resolve the WhatsApp channel configuration.
 *
 * The channel is enabled only when `enabled !== false` AND both an access
 * token and a phone number id are available — a half-configured channel that
 * registers and then fails every send is worse than one that stays quiet.
 *
 * Cached after first load.
 */
export function loadWhatsAppConfig(): WhatsAppConfig {
  if (_cfg) return _cfg;

  const raw = getChannelConfig<WhatsAppChannelJsonConfig>("whatsapp");

  const accessToken = resolveEnvValue(raw?.accessToken) ?? "";
  const phoneNumberId = resolveEnvValue(raw?.phoneNumberId) ?? "";
  const businessAccountId = resolveEnvValue(raw?.businessAccountId);
  const appSecret = resolveEnvValue(raw?.appSecret);
  const webhookVerifyToken = resolveEnvValue(raw?.webhookVerifyToken);

  const authorizedSenders = (raw?.authorizedSenders ?? []).map(normalisePhone);

  _cfg = {
    enabled: raw?.enabled !== false && !!accessToken && !!phoneNumberId,

    accessToken,
    phoneNumberId,
    businessAccountId: businessAccountId || undefined,
    appSecret: appSecret || undefined,
    webhookVerifyToken: webhookVerifyToken || undefined,

    apiBase: raw?.apiBase ?? DEFAULTS.apiBase,
    apiVersion: raw?.apiVersion ?? DEFAULTS.apiVersion,

    authorizedSenders,
    defaultUserId: raw?.defaultUserId ?? DEFAULTS.defaultUserId,
    maxMessageLength: raw?.maxMessageLength ?? DEFAULTS.maxMessageLength,
    markReadOnReceipt: raw?.markReadOnReceipt !== false,
    typingIndicator: raw?.typingIndicator !== false,
    optOutKeywords: (raw?.optOutKeywords ?? [...DEFAULTS.optOutKeywords]).map(
      (k) => k.toLowerCase(),
    ),
    optInKeywords: (raw?.optInKeywords ?? [...DEFAULTS.optInKeywords]).map(
      (k) => k.toLowerCase(),
    ),

    windowStore: raw?.windowStore ?? "memory",
    /**
     * Durable by default, unlike the window store. Meta redelivers a failed
     * webhook with decreasing frequency for up to SEVEN DAYS, so an in-memory
     * dedupe set loses its contents to a redeploy or a cold start and the
     * agent answers a days-old message as if it were new.
     */
    dedupeStore: raw?.dedupeStore ?? "cosmos",

    /**
     * Shared by default with the same reasoning as dedupe: an id is good for
     * 30 days, so a cache that empties on every cold start re-uploads the same
     * bytes over and over.
     */
    mediaCacheStore: raw?.mediaCacheStore ?? "cosmos",

    acceptInboundMedia: raw?.acceptInboundMedia ?? [
      ...DEFAULTS.acceptInboundMedia,
    ],
    maxInboundMediaBytes:
      raw?.maxInboundMediaBytes ?? DEFAULTS.maxInboundMediaBytes,

    templates: resolveTemplates(raw?.templates),
  };

  return _cfg;
}

/**
 * Why the WhatsApp channel must not register, or null when it may.
 *
 * - Without authorizedSenders and with identity falling back to
 *   "config-default", every stranger messaging the number would resolve to
 *   the default user's workspace.
 * - In the cloud, a missing appSecret means webhook signatures can't be
 *   verified, so anyone who finds the endpoint could inject messages.
 */
export function whatsappRegistrationBlocker(): string | null {
  const cfg = loadWhatsAppConfig();
  if (identityFallbackIsUnsafe(cfg.authorizedSenders)) {
    return (
      'identity.fallbackMode is "config-default" and channels.whatsapp.authorizedSenders ' +
      "is empty, so any stranger messaging this number would resolve to the default " +
      "user's workspace. Set authorizedSenders, or change the identity fallback mode."
    );
  }
  if (isCloudRuntime() && !cfg.appSecret) {
    return (
      "appSecret is not configured, so webhook signatures can't be verified and " +
      "anyone who finds the endpoint could inject forged messages. Set channels.whatsapp.appSecret."
    );
  }
  return null;
}

/**
 * Normalise a phone number for comparison against a `wa_id`.
 *
 * Meta reports senders as E.164 without the leading `+`; humans write config
 * with `+`, spaces and dashes. Compare the digits.
 */
export function normalisePhone(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function resolveTemplates(
  raw: Record<string, WhatsAppTemplateRef> | undefined,
): Record<string, ResolvedTemplateRef> {
  const out: Record<string, ResolvedTemplateRef> = {};
  for (const [key, tpl] of Object.entries(raw ?? {})) {
    if (!tpl?.name || !tpl?.language) continue;
    out[key] = {
      name: tpl.name,
      language: tpl.language,
      bodyParams: tpl.bodyParams ?? [],
    };
  }
  return out;
}

/**
 * The base URL for Cloud API calls against our own phone number.
 * e.g. https://graph.facebook.com/v21.0/123456789
 */
export function phoneNumberUrl(cfg: WhatsAppConfig): string {
  return `${cfg.apiBase}/${cfg.apiVersion}/${cfg.phoneNumberId}`;
}

/** The base URL for version-scoped calls that are not phone-number-scoped. */
export function graphUrl(cfg: WhatsAppConfig): string {
  return `${cfg.apiBase}/${cfg.apiVersion}`;
}

/**
 * Reset cached config. For testing only.
 */
export function resetWhatsAppConfig(): void {
  _cfg = undefined;
}
