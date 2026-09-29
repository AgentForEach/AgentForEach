/**
 * AgentForEach Memory Layer — Store Provider Registry
 *
 * Resolves the active memory store provider from the `provider` field in
 * the agentforeach.json "memory" section.  Follows the same pattern as
 * `websocket/providers/index.ts`.
 *
 * Built-in providers:
 *   - "cosmosdb"  — Cosmos DB with vector + full-text search (default)
 *   - "noop"      — Silent no-op (used when memory is disabled)
 *
 * Third-party or test providers can be registered at runtime via
 * `registerStoreProvider()`.
 */

import type { MemoryStoreProvider } from "../types.js";
import type { MemoryConfig } from "../config.js";
import type { DatabaseProvider } from "../../database/index.js";
import { CosmosMemoryStore } from "./cosmosdb.js";
import { NoopMemoryStore } from "./noop.js";

// ============================================================================
// Factory type
// ============================================================================

/**
 * Factory function that creates a store provider from resolved config.
 *
 * @param config - Fully-resolved MemoryConfig.
 * @param db    - Optional shared DatabaseProvider instance.  Required for
 *                providers that use a database backend; ignored by others.
 */
export type StoreProviderFactory = (
  config: MemoryConfig,
  db?: DatabaseProvider,
) => MemoryStoreProvider;

// ============================================================================
// Registry
// ============================================================================

const _registry = new Map<string, StoreProviderFactory>();

// -- Built-in providers ------------------------------------------------------

_registry.set("cosmosdb", (config, db) => {
  if (!db) {
    throw new Error(
      'memory: "cosmosdb" store provider requires a DatabaseProvider instance',
    );
  }
  return new CosmosMemoryStore(config, db);
});

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
 * @param db    - Optional DatabaseProvider instance (needed by "cosmosdb").
 * @returns A ready-to-use (but not yet initialized) MemoryStoreProvider.
 */
export function resolveStoreProvider(
  config: MemoryConfig,
  db?: DatabaseProvider,
): MemoryStoreProvider {
  const name = config.storeProvider;
  const factory = _registry.get(name);
  if (!factory) {
    const known = [..._registry.keys()].join(", ");
    throw new Error(
      `memory: unknown store provider "${name}". Available: ${known}`,
    );
  }
  return factory(config, db);
}

/**
 * List all registered provider names (useful for diagnostics / help text).
 */
export function getRegisteredProviders(): string[] {
  return [..._registry.keys()];
}
