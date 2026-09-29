/**
 * AgentForEach Provider Layer — Registry
 *
 * Singleton registry for provider factories.
 * Allows runtime registration and lazy instantiation of providers.
 */

import type { Provider, ProviderConfig, ProviderFactory, ProviderId } from "./types.js";

// ============================================================================
// Registry
// ============================================================================

/** Internal store: providerId → factory function. */
const factories = new Map<string, ProviderFactory>();

/** Internal store: providerId → cached provider instance (keyed by apiKey hash). */
const instances = new Map<string, Provider>();

/**
 * Register a provider factory.
 *
 * @param id - Unique provider identifier (e.g., "openai", "anthropic").
 * @param factory - Factory function that creates a Provider from config.
 */
export function registerProvider(id: ProviderId, factory: ProviderFactory): void {
  factories.set(id, factory);
}

/**
 * Get or create a provider instance.
 *
 * On first call for a given (id, apiKey) pair the factory is invoked and
 * the result is cached.  Subsequent calls with the same key return the
 * cached instance — this avoids re-creating HTTP clients per request.
 *
 * @param id - Provider identifier.
 * @param config - Provider configuration.
 * @returns The provider instance.
 * @throws If no factory is registered for the given id.
 */
export function getProvider(id: ProviderId, config: ProviderConfig): Provider {
  const cacheKey = `${id}:${simpleHash(config.apiKey)}`;

  const cached = instances.get(cacheKey);
  if (cached) return cached;

  const factory = factories.get(id);
  if (!factory) {
    throw new Error(
      `No provider registered for "${id}". ` +
        `Available: ${[...factories.keys()].join(", ") || "(none)"}`,
    );
  }

  const provider = factory(config);
  instances.set(cacheKey, provider);
  return provider;
}

/**
 * Check whether a provider factory is registered.
 */
export function hasProvider(id: ProviderId): boolean {
  return factories.has(id);
}

/**
 * List all registered provider IDs.
 */
export function listProviders(): ProviderId[] {
  return [...factories.keys()];
}

/**
 * Clear all cached instances (useful for testing).
 * Does NOT remove factory registrations.
 */
export function clearProviderCache(): void {
  instances.clear();
}

// ============================================================================
// Helpers
// ============================================================================

/** Fast non-crypto hash — just for cache key differentiation. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}
