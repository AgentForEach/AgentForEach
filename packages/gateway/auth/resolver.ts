/**
 * AgentForEach Auth System — Resolver
 *
 * Chain-of-responsibility auth resolver inspired by OpenClaw's
 * `applyAuthChoice` pattern.
 *
 * Tries each configured auth provider in order. The first provider
 * that returns a non-null AuthContext wins.
 *
 * This is the primary entry point for all request authentication.
 */

import type { HttpRequest } from "@azure/functions";
import type { AuthConfig, AuthContext, AuthProvider } from "./types.js";
import { loadAuthConfig } from "./config.js";
import { createProvider } from "./factory.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// Singleton Provider Chain
// ============================================================================

let _providers: AuthProvider[] | undefined;

/**
 * Build the provider chain from config.
 * Lazy-initialized on first call and cached.
 */
function getProviderChain(): AuthProvider[] {
  if (_providers) return _providers;

  const config = loadAuthConfig();
  const providerConfigs = config.providers ?? [];

  _providers = [];
  for (const providerConfig of providerConfigs) {
    // Skip disabled providers
    if (providerConfig.enabled === false) continue;

    try {
      const provider = createProvider(providerConfig);
      _providers.push(provider);
    } catch (err) {
      console.error(
        `[auth] Failed to create provider "${providerConfig.type}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (_providers.length === 0) {
    console.warn(
      "[auth] No auth providers configured or all disabled. " +
        "All requests will be unauthenticated (401).",
    );
  }

  console.log(
    `[auth] Initialized ${_providers.length} provider(s): ${_providers.map((p) => p.id).join(", ")}`,
  );

  return _providers;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve the authenticated user from the request by trying each
 * configured auth provider in order.
 *
 * This is a drop-in replacement for the legacy `resolveAuthContext()`
 * from easy-auth.ts.
 *
 * @returns AuthContext if authenticated, null if not.
 */
export async function resolveAuthContext(
  request: HttpRequest,
): Promise<AuthContext | null> {
  const providers = getProviderChain();
  const config = loadAuthConfig();

  for (const provider of providers) {
    try {
      const result = await provider.resolve(request);
      if (result && isCrossSiteFormPost(request, result)) {
        console.warn("[auth] refused a cookie-authenticated POST without a JSON content type (possible CSRF)");
        return null;
      }
      if (result) {
        if (config.settings?.logSuccesses) {
          console.log(
            `[auth] Resolved by "${provider.id}": userId=${redactId(result.userId)}`,
          );
        }
        return result;
      }
    } catch (err) {
      console.error(
        `[auth] Provider "${provider.id}" threw an error:`,
        err instanceof Error ? err.message : err,
      );
      // If failFast, stop trying other providers
      if (config.settings?.failFast) return null;
    }
  }

  return null;
}

/**
 * App Service authentication can ride on a session cookie, and a browser
 * sends a cross-site POST with a form or text/plain body without a CORS
 * preflight. Requiring JSON forces the preflight, which CORS then governs.
 */
export function isCrossSiteFormPost(request: HttpRequest, auth: AuthContext): boolean {
  if (auth.source !== "easy-auth" || request.method.toUpperCase() !== "POST") return false;
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return type !== "application/json";
}

/**
 * Reset the provider chain (for testing or hot-reload).
 */
export function resetProviderChain(): void {
  _providers = undefined;
}

/**
 * Get the current provider chain (for diagnostics / health checks).
 */
export function getActiveProviders(): ReadonlyArray<{
  id: string;
  label: string;
}> {
  return getProviderChain().map((p) => ({ id: p.id, label: p.label }));
}
