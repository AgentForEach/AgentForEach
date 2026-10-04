/**
 * AgentForEach Memory Layer — Store Provider Registry
 *
 * Resolves the active memory store provider from the `provider` field in
 * the agentforeach.json "memory" section.  Follows the same pattern as
 * `websocket/providers/index.ts`.
 *
 * Built-in providers:
 *   - "storage"   — the shared storage adapter, vector + hybrid search
 *                   (default; "cosmosdb" is accepted as an alias, its old name)
 *   - "noop"      — Silent no-op (used when memory is disabled)
 *
 * Third-party or test providers can be registered at runtime via
 * `registerStoreProvider()`.
 */

import type { MemoryStoreProvider } from "../types.js";
import type { MemoryConfig } from "../config.js";
import type { StorageAdapter } from "@agentforeach/storage";
import { StorageMemoryStore } from "./storage.js";
import { NoopMemoryStore } from "./noop.js";

// ============================================================================
// Factory type
// ============================================================================

/**
 * Factory function that creates a store provider from resolved config.
 *
 * @param config - Fully-resolved MemoryConfig.
 * @param storage - Optional shared storage adapter. Required for providers
 *                  that store in the database; ignored by others.
 */
export type StoreProviderFactory = (
  config: MemoryConfig,
  storage?: StorageAdapter,
) => MemoryStoreProvider;

// ============================================================================
// Registry
// ============================================================================

const _registry = new Map<string, StoreProviderFactory>();

// -- Built-in providers ------------------------------------------------------

const storageStore: StoreProviderFactory = (config, storage) => {
  if (!storage) {
    throw new Error('memory: the "storage" store provider requires a storage adapter');
  }
  return new StorageMemoryStore(config, storage);
};
_registry.set("storage", storageStore);
_registry.set("cosmosdb", storageStore);

_registry.set("noop", () => new NoopMemoryStore());

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a custom store provider factory.
 *
 * ```ts
 * registerStoreProvider("pinecone", (config) => new PineconeMemoryStore(config));
 * ```
 */
export function registerStoreProvider(
  name: string,
  factory: StoreProviderFactory,
): void {
  _registry.set(name, factory);
}

/**
 * Resolve the store provider for the given config.
 *
 * @param config - Resolved MemoryConfig (contains `storeProvider` field).
 * @param storage - Optional storage adapter (needed by "storage").
 * @returns A ready-to-use (but not yet initialized) MemoryStoreProvider.
 */
export function resolveStoreProvider(
  config: MemoryConfig,
  storage?: StorageAdapter,
): MemoryStoreProvider {
  const name = config.storeProvider;
  const factory = _registry.get(name);
  if (!factory) {
    const known = [..._registry.keys()].join(", ");
    throw new Error(
      `memory: unknown store provider "${name}". Available: ${known}`,
    );
  }
  return factory(config, storage);
}

/**
 * List all registered provider names (useful for diagnostics / help text).
 */
export function getRegisteredProviders(): string[] {
  return [..._registry.keys()];
}
