/**
 * AgentForEach Auth System — Configuration Loader
 *
 * Loads auth configuration from agentforeach.json and provides
 * the default fallback chain for backward compatibility.
 */

import { loadConfigSection } from "../utils/index.js";
import type { AuthConfig, AuthProviderConfig } from "./types.js";

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default provider chain — matches legacy behavior:
 *   1. Azure Easy Auth (production)
 *   2. Insecure header fallback (dev/local)
 */
const DEFAULT_PROVIDERS: AuthProviderConfig[] = [
  { type: "easy-auth", enabled: true },
  { type: "insecure-header", enabled: true, requireEnvOptIn: true },
];

// ============================================================================
// Config Loader
// ============================================================================

let _authConfig: AuthConfig | undefined;

/**
 * Load the auth config from agentforeach.json.
 *
 * Uses the same resolution strategy as the cron config loader:
 * tries the compiled output path first, then falls back to source.
 */
export function loadAuthConfig(): AuthConfig {
  if (_authConfig) return _authConfig;

  const authSection = loadConfigSection<AuthConfig>("auth");

  if (!authSection) {
    // No config file or empty auth section — use defaults
    _authConfig = { providers: DEFAULT_PROVIDERS };
  } else {
    _authConfig = {
      ...authSection,
      // Ensure providers array exists; fall back to defaults if missing
      providers: authSection.providers?.length
        ? authSection.providers
        : DEFAULT_PROVIDERS,
    };
  }

  return _authConfig;
}

/**
 * Reset the cached config (for testing).
 */
export function resetAuthConfig(): void {
  _authConfig = undefined;
}
