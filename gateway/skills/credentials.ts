/**
 * AgentForEach Skills Layer — credential host binding
 *
 * A skill can declare which hosts each credential may be sent to. These
 * helpers enforce that for http_fetch and build the egress-proxy rules that
 * inject credentials into sandbox traffic.
 */

import type { CredentialBinding } from "./types.js";

/** Exact host match, or "*.example.com" for any subdomain of example.com. */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((raw) => {
    const p = raw.toLowerCase().trim();
    if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

/** Apply a binding's format ("Bearer {value}") to a secret. */
export function formatCredential(binding: CredentialBinding, value: string): string {
  return (binding.format ?? "{value}").split("{value}").join(value);
}

/** Placeholder put in the env var when the egress proxy injects the real value. */
export const EGRESS_INJECTED_PLACEHOLDER = "injected-by-egress-proxy";

/** Values shorter than this are too likely to occur by chance to redact. */
const MIN_REDACTED_LENGTH = 6;

/**
 * Replace every credential value in a tool result with `[redacted $KEY]`, so
 * a service that echoes a request (or an error that quotes a URL) doesn't
 * hand the secret to the model. Matches the raw value and its JSON-escaped
 * form, since results are JSON.
 */
export function redactCredentialValues(text: string, credentials: Record<string, string>): string {
  const entries = Object.entries(credentials)
    .filter(([, v]) => typeof v === "string" && v.length >= MIN_REDACTED_LENGTH)
    .sort(([, a], [, b]) => b.length - a.length);
  let out = text;
  for (const [key, value] of entries) {
    const escaped = JSON.stringify(value).slice(1, -1);
    for (const form of new Set([value, escaped])) {
      if (out.includes(form)) out = out.split(form).join(`[redacted $${key}]`);
    }
  }
  return out;
}
