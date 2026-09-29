/**
 * AgentForEach Credits Module — Config Loader
 *
 * Loads the "credits" section from agentforeach.json via the shared
 * `loadConfigSection()` utility, with env-var resolution.
 */

import { loadConfigSection } from "../utils/index.js";
import type { CreditsConfig } from "./types.js";

interface CreditsJsonConfig {
  enabled?: boolean;
  balanceUrl?: string;
  consumeUrl?: string;
  reserveUrl?: string;
  settleUrl?: string;
  currencyCode?: string;
  costMultiplier?: number;
  minimumCharge?: number;
  serviceKey?: string;
  preFlightCheck?: boolean;
}

let _cached: CreditsConfig | undefined;

/**
 * Load credits config from agentforeach.json "credits" section.
 * Returns a disabled config if the section is missing.
 */
export function loadCreditsConfig(): CreditsConfig {
  if (_cached) return _cached;

  const section = loadConfigSection<CreditsJsonConfig>("credits");

  if (!section || section.enabled !== true) {
    _cached = disabledConfig();
    return _cached;
  }

  const balanceUrl = resolveEnv(section.balanceUrl ?? "");
  const consumeUrl = resolveEnv(section.consumeUrl ?? "");
  const reserveUrl = resolveEnv(section.reserveUrl ?? "");
  const settleUrl = resolveEnv(section.settleUrl ?? "");
  const serviceKey = resolveEnv(section.serviceKey ?? "");

  if (
    !isHttpUrl(balanceUrl) ||
    !isHttpUrl(consumeUrl) ||
    !isHttpUrl(reserveUrl) ||
    !isHttpUrl(settleUrl) ||
    !serviceKey
  ) {
    console.warn(
      "[credits] Disabled: credit balance/reserve/settle URLs or CREDITS_SERVICE_KEY are missing or invalid.",
    );
    _cached = disabledConfig();
    return _cached;
  }

  _cached = {
    enabled: true,
    balanceUrl,
    consumeUrl,
    reserveUrl,
    settleUrl,
    currencyCode: section.currencyCode ?? "CRD",
    costMultiplier: section.costMultiplier ?? 100,
    minimumCharge: section.minimumCharge ?? 1,
    serviceKey,
    preFlightCheck: section.preFlightCheck !== false,
  };

  return _cached;
}

function disabledConfig(): CreditsConfig {
  return {
    enabled: false,
    balanceUrl: "",
    consumeUrl: "",
    reserveUrl: "",
    settleUrl: "",
    currencyCode: "CRD",
    costMultiplier: 100,
    minimumCharge: 1,
    serviceKey: "",
    preFlightCheck: true,
  };
}

/**
 * Reset cached credits config (for testing).
 */
export function resetCreditsConfig(): void {
  _cached = undefined;
}

/** Resolve `$ENV_VAR` references in config strings. */
function resolveEnv(value: string): string {
  if (!value) return "";
  if (value.startsWith("$")) {
    const envName = value.slice(1);
    return process.env[envName] ?? "";
  }
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
