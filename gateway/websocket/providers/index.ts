/**
 * AgentForEach WebSocket Provider — Registry
 *
 * Singleton registry for WebSocket provider factories.
 * Follows the same pattern as llms/registry.ts.
 *
 * Providers are registered at module load time (auto-registration).
 * The active provider is resolved lazily from agentforeach.json config
 * on first use and cached for the lifetime of the process.
 */

import type {
  WebSocketProvider,
  WebSocketProviderConfig,
  WebSocketProviderFactory,
  WebSocketProviderId,
} from "../types.js";
import {
  resolveConnectionString,
  resolveHub,
  resolveProviderId,
} from "../config.js";

// ============================================================================
// Registry
// ============================================================================

/** Internal store: providerId → factory function. */
const factories = new Map<string, WebSocketProviderFactory>();

/** Cached provider instance (one active at a time). */
let _activeProvider: WebSocketProvider | null = null;
let _activeProviderId: string | null = null;

/**
 * Register a WebSocket provider factory.
 *
 * @param id - Unique provider identifier (e.g., "azure-webpubsub", "noop").
 * @param factory - Factory function that creates a WebSocketProvider.
 */
export function registerWebSocketProvider(
  id: WebSocketProviderId,
  factory: WebSocketProviderFactory,
): void {
  factories.set(id, factory);
}

/**
 * Get the active WebSocket provider.
 *
 * Resolves which provider to use from agentforeach.json ("websocket.provider")
 * and instantiates it on first call. Subsequent calls return the cached
 * instance.
 *
 * @returns The active WebSocketProvider instance.
 * @throws If the configured provider has no registered factory.
 */
export function getActiveProvider(): WebSocketProvider {
  const desiredId = resolveProviderId();

  // Return cached if same provider
  if (_activeProvider && _activeProviderId === desiredId) {
    return _activeProvider;
  }

  const factory = factories.get(desiredId);
  if (!factory) {
    throw new Error(
      `No WebSocket provider registered for "${desiredId}". ` +
        `Available: ${[...factories.keys()].join(", ") || "(none)"}`,
    );
  }

  const config: WebSocketProviderConfig = {
    connectionString: resolveConnectionString(),
    hub: resolveHub(),
  };

  _activeProvider = factory(config);
  _activeProviderId = desiredId;
  return _activeProvider;
}

/**
 * Check whether a provider factory is registered.
 */
export function hasWebSocketProvider(id: WebSocketProviderId): boolean {
  return factories.has(id);
}

/**
 * List all registered WebSocket provider IDs.
 */
export function listWebSocketProviders(): WebSocketProviderId[] {
  return [...factories.keys()];
}

/**
 * Clear the cached active provider (useful for testing).
 * Does NOT remove factory registrations.
 */
export function clearWebSocketProviderCache(): void {
  _activeProvider = null;
  _activeProviderId = null;
}

// ============================================================================
// Auto-Registration — built-in providers
// ============================================================================

import { createAzureWebPubSubProvider } from "./azure-webpubsub.js";
import { createNoopProvider } from "./noop.js";

registerWebSocketProvider("azure-webpubsub", createAzureWebPubSubProvider);
registerWebSocketProvider("noop", createNoopProvider);
