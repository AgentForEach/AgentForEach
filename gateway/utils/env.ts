/**
 * AgentForEach Utilities — Environment Variable Helpers
 *
 * Shared helpers for resolving environment variables from config values.
 * Used by auth, llms, and cron config loaders to support "$ENV_VAR" references.
 */

import { hostInfo } from "../runtime/host.js";

// ============================================================================
// Env Var Resolution
// ============================================================================

/**
 * Resolve a config value that may be an env var reference.
 *
 * If the value starts with "$", treats the rest as an environment variable
 * name and returns its value. Plain strings pass through unchanged.
 *
 * @example
 * resolveEnvValue("$OPENAI_API_KEY") // → process.env.OPENAI_API_KEY
 * resolveEnvValue("sk-literal-key")  // → "sk-literal-key"
 * resolveEnvValue(undefined)         // → undefined
 */
export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) {
    const envVar = value.slice(1);
    return process.env[envVar] || undefined;
  }
  return value;
}

// ============================================================================
// Runtime Detection
// ============================================================================

/**
 * True on a deployed production host: Azure App Service / Functions (which
 * set WEBSITE_SITE_NAME), or any platform whose entry point installs a
 * production `HostInfo`. Checks that must fail closed in production use
 * this; hosts that can't be detected (Docker, AKS) count as local, so
 * insecure behaviour there must be an explicit opt-in.
 */
export function isCloudRuntime(): boolean {
  return hostInfo().isProductionHost;
}

/**
 * Whether a channel may accept webhooks without verifying them when no
 * secret is configured. Only with ALLOW_UNSIGNED_WEBHOOKS=true, and never on
 * Azure: other hosts can't be told apart from a laptop, so it's opt-in.
 */
export function allowUnsignedWebhooks(): boolean {
  return !isCloudRuntime() && parseEnvBool("ALLOW_UNSIGNED_WEBHOOKS", false);
}

// ============================================================================
// Env Bool Parsing
// ============================================================================

const TRUTHY = new Set(["1", "true", "yes", "y", "on"]);
const FALSY = new Set(["0", "false", "no", "n", "off"]);

/**
 * Parse an environment variable as a boolean.
 *
 * Recognizes common truthy/falsy string patterns. Returns the
 * fallback value if the variable is unset or unrecognized.
 *
 * @param name - Environment variable name.
 * @param fallback - Default value when the variable is unset.
 */
export function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return fallback;
}

// ============================================================================
// Required Env
// ============================================================================

/**
 * Get a required environment variable or throw.
 *
 * @param name - Environment variable name.
 * @throws {Error} If the variable is not set.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
