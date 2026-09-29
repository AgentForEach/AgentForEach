/**
 * AgentForEach Link Understanding — SSRF guard
 *
 * Synchronous URL check, for rejecting a link before fetching it. The fetch
 * itself goes through utils/safe-fetch.ts, which also checks every resolved
 * address at connect time and every redirect hop.
 */

import { checkUrl } from "../utils/safe-fetch.js";

export interface SsrfValidation {
  valid: boolean;
  reason?: string;
}

/** Check a URL's scheme, credentials and host (IP literals included). */
export function validateUrl(url: string): SsrfValidation {
  const result = checkUrl(url);
  return result.ok ? { valid: true } : { valid: false, reason: `Blocked: ${result.reason}` };
}
