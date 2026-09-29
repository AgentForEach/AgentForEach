/**
 * AgentForEach Auth Provider — Trusted Proxy
 *
 * Authenticates requests via identity headers set by a trusted reverse proxy
 * (e.g., Pomerium, Caddy with OAuth, nginx auth_request, Cloudflare Access).
 *
 * Inspired by OpenClaw's GatewayTrustedProxyConfig.
 *
 * The proxy handles the actual authentication flow and passes the
 * authenticated user identity via a configurable header, plus a shared
 * secret (`sharedSecret`) that proves the request came through it. Without
 * the secret configured, every request is refused.
 */

import { timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "@azure/functions";
import { resolveEnvValue } from "../../utils/index.js";
import type {
  AuthProvider,
  AuthContext,
  TrustedProxyProviderConfig,
} from "../types.js";

// ============================================================================
// Provider
// ============================================================================

export function createTrustedProxyProvider(
  config: TrustedProxyProviderConfig,
): AuthProvider {
  const userHeader = config.userHeader.toLowerCase();
  const requiredHeaders = (config.requiredHeaders ?? []).map((h) =>
    h.toLowerCase(),
  );
  const allowUsers =
    config.allowUsers?.map((u) => u.trim().toLowerCase()) ?? [];
  const defaultRoles = config.defaultRoles ?? [];
  const secret = config.sharedSecret ? resolveEnvValue(config.sharedSecret) ?? "" : "";
  const secretHeader = (config.sharedSecretHeader ?? "x-proxy-secret").toLowerCase();
  if (!secret) {
    console.warn("[auth] trusted-proxy has no sharedSecret; it will refuse every request");
  }

  return {
    id: "trusted-proxy",
    label: "Trusted Proxy",

    resolve(request: HttpRequest): AuthContext | null {
      if (!secret || !secretMatches(request.headers.get(secretHeader), secret)) return null;

      // Check all required headers are present
      for (const header of requiredHeaders) {
        if (!request.headers.get(header)) return null;
      }

      // Extract user identity from the configured header
      const userValue = request.headers.get(userHeader);
      if (!userValue?.trim()) return null;

      const userId = userValue.trim();

      // Check allowlist (if configured)
      if (allowUsers.length > 0) {
        if (!allowUsers.includes(userId.toLowerCase())) return null;
      }

      return {
        userId,
        roles: [...defaultRoles],
        source: "trusted-proxy",
        // Use the user header value as email if it looks like an email
        email: userId.includes("@") ? userId : undefined,
      };
    },
  };
}

function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
