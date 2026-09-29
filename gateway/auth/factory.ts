/**
 * AgentForEach Auth System — Provider Factory
 *
 * Creates AuthProvider instances from configuration objects.
 * Maps each provider type to its corresponding factory function.
 *
 */

import type { AuthProvider, AuthProviderConfig } from "./types.js";
import {
  createEasyAuthProvider,
  createApiKeyProvider,
  createJwtProvider,
  createTrustedProxyProvider,
  createInsecureHeaderProvider,
} from "./providers/index.js";

/**
 * Provider factory registry: type → factory function.
 * New provider types can be added by extending this map.
 */
const providerFactories: Record<
  string,
  (config: AuthProviderConfig) => AuthProvider
> = {
  "easy-auth": (c) =>
    createEasyAuthProvider(c as Parameters<typeof createEasyAuthProvider>[0]),
  "api-key": (c) =>
    createApiKeyProvider(c as Parameters<typeof createApiKeyProvider>[0]),
  jwt: (c) => createJwtProvider(c as Parameters<typeof createJwtProvider>[0]),
  "trusted-proxy": (c) =>
    createTrustedProxyProvider(
      c as Parameters<typeof createTrustedProxyProvider>[0],
    ),
  "insecure-header": (c) =>
    createInsecureHeaderProvider(
      c as Parameters<typeof createInsecureHeaderProvider>[0],
    ),
};

/**
 * Create an AuthProvider from a config object.
 *
 * @throws If the provider type is unknown.
 */
export function createProvider(config: AuthProviderConfig): AuthProvider {
  const factory = providerFactories[config.type];
  if (!factory) {
    throw new Error(
      `Unknown auth provider type "${config.type}". ` +
        `Available: ${Object.keys(providerFactories).join(", ")}`,
    );
  }
  return factory(config);
}

/**
 * Register a custom auth provider factory.
 *
 * This allows extensions or plugins to register additional auth providers
 * beyond the built-in types.
 *
 * @param type - Provider type string (used in agentforeach.json config).
 * @param factory - Factory function that creates the provider from config.
 */
export function registerProviderFactory(
  type: string,
  factory: (config: AuthProviderConfig) => AuthProvider,
): void {
  providerFactories[type] = factory;
}

/**
 * List all registered provider type names.
 */
export function listProviderTypes(): string[] {
  return Object.keys(providerFactories);
}
