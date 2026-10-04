/**
 * AgentForEach Auth Provider — API Key
 *
 * Authenticates requests via a static API key sent in a configurable header.
 * Keys are mapped to user identities in agentforeach.json config.
 *
 * Supports env var references for keys (prefix with "$") to avoid
 * storing secrets in config files.
 */

import { timingSafeEqual } from "node:crypto";
import type { HttpRequestLike } from "@agentforeach/platform";
import { resolveEnvValue } from "../../utils/index.js";
import type {
  AuthProvider,
  AuthContext,
  ApiKeyProviderConfig,
  ApiKeyIdentity,
} from "../types.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a lookup map: resolved key → identity.
 * Env var references are resolved at construction time.
 */
function buildKeyMap(
  keys: Record<string, ApiKeyIdentity>,
): Map<string, ApiKeyIdentity> {
  const map = new Map<string, ApiKeyIdentity>();
  for (const [rawKey, identity] of Object.entries(keys)) {
    const resolved = resolveEnvValue(rawKey) ?? "";
    if (resolved) {
      map.set(resolved, identity);
    }
  }
  return map;
}

/**
 * Timing-safe comparison to prevent timing attacks on API keys.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

// ============================================================================
// Provider
// ============================================================================

export function createApiKeyProvider(
  config: ApiKeyProviderConfig,
): AuthProvider {
  const headerName = (config.headerName ?? "x-api-key").toLowerCase();
  const keyMap = buildKeyMap(config.keys);

  return {
    id: "api-key",
    label: "API Key",

    resolve(request: HttpRequestLike): AuthContext | null {
      const rawKey = request.headers.get(headerName);
      if (!rawKey?.trim()) return null;

      const key = rawKey.trim();

      // Timing-safe lookup: iterate all keys to prevent timing attacks.
      // Map.get() short-circuits on hash comparison and leaks key length/prefix.
      let matchedIdentity: ApiKeyIdentity | undefined;
      for (const [registeredKey, identity] of keyMap) {
        if (safeEqual(key, registeredKey)) {
          matchedIdentity = identity;
          break;
        }
      }
      if (!matchedIdentity) return null;

      return {
        userId: matchedIdentity.userId,
        roles: matchedIdentity.roles ?? [],
        email: matchedIdentity.email,
        metadata: matchedIdentity.metadata,
        source: "api-key",
        ...(config.cookieBacked ? { cookieBacked: true } : {}),
      };
    },
  };
}
