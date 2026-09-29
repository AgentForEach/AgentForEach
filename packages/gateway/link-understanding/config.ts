/**
 * AgentForEach Link Understanding — Configuration
 *
 * Loads link understanding config from agentforeach.json ("linkUnderstanding" section).
 */

import { loadConfigSection } from "../utils/index.js";
import type { LinkUnderstandingConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONFIG: LinkUnderstandingConfig = {
  enabled: false,
  maxUrls: 3,
  fetchTimeoutMs: 8_000,
  maxContentChars: 6_000,
  userAgent: "AgentForEachBot/1.0 (Link Preview)",
  maxBodyBytes: 1_048_576,
  allowedContentTypes: [
    "text/html",
    "text/plain",
    "application/json",
    "application/xml",
    "text/xml",
  ],
};

// ============================================================================
// Loader
// ============================================================================

let _config: LinkUnderstandingConfig | undefined;

/**
 * Load the link understanding config from agentforeach.json.
 * Merges with defaults for any missing fields.
 */
export function loadLinkConfig(): LinkUnderstandingConfig {
  if (_config) return _config;

  const section = loadConfigSection<Partial<LinkUnderstandingConfig>>(
    "linkUnderstanding",
  );

  _config = {
    enabled: section?.enabled ?? DEFAULT_CONFIG.enabled,
    maxUrls: section?.maxUrls ?? DEFAULT_CONFIG.maxUrls,
    fetchTimeoutMs: section?.fetchTimeoutMs ?? DEFAULT_CONFIG.fetchTimeoutMs,
    maxContentChars:
      section?.maxContentChars ?? DEFAULT_CONFIG.maxContentChars,
    userAgent: section?.userAgent ?? DEFAULT_CONFIG.userAgent,
    maxBodyBytes: section?.maxBodyBytes ?? DEFAULT_CONFIG.maxBodyBytes,
    allowedContentTypes:
      section?.allowedContentTypes ?? DEFAULT_CONFIG.allowedContentTypes,
  };

  return _config;
}

/**
 * Reset the cached config (for testing).
 */
export function resetLinkConfig(): void {
  _config = undefined;
}
