/**
 * AgentForEach Database Layer — Provider Registry
 *
 * Resolves the active database provider from the `provider` field in
 * the agentforeach.json "database" section.  Follows the same pattern as
 * `memory/providers/index.ts` and `websocket/providers/index.ts`.
 *
 * Built-in providers:
 *   - "cosmosdb"  — Azure Cosmos DB (default)
 *   - "noop"      — Silent no-op (for tests or disabled scenarios)
 *
 * Third-party or test providers can be registered at runtime via
 * `registerDatabaseProvider()`.
 */

import type { DatabaseProvider } from "../types.js";
import type { ResolvedDatabaseConfig } from "../config.js";
import { CosmosDatabase } from "../client.js";
import { NoopDatabase } from "./noop.js";

// ============================================================================
// Factory type
// ============================================================================

/**
 * Factory function that creates a database provider from resolved config.
 *
 * @param config - Resolved database config (endpoint, key, databaseId, provider).
 */
export type DatabaseProviderFactory = (
  config: ResolvedDatabaseConfig,
) => DatabaseProvider;

// ============================================================================
// Registry
// ============================================================================

const _registry = new Map<string, DatabaseProviderFactory>();

// -- Built-in providers ------------------------------------------------------

_registry.set("cosmosdb", (config) => {
  if (!config.endpoint) {
    throw new Error(
      'database: "cosmosdb" provider requires an endpoint. ' +
        "Set COSMOS_ENDPOINT env var or configure in agentforeach.json.",
    );
  }
  // An empty key means Entra ID (managed identity) auth.
  return new CosmosDatabase({
    endpoint: config.endpoint,
    key: config.key,
    identityClientId: config.identityClientId,
    databaseId: config.databaseId,
    provisionContainers: config.provisionContainers,
  });
});

_registry.set("noop", () => new NoopDatabase());

// ============================================================================
// Public API
// ============================================================================

/**
 * Register a custom database provider factory.
 *
 * ```ts
 * registerDatabaseProvider("mongodb", (config) => new MongoDatabase(config));
 * ```
 */
export function registerDatabaseProvider(
  name: string,
  factory: DatabaseProviderFactory,
): void {
  _registry.set(name, factory);
}

/**
 * Resolve the database provider for the given config.
 *
 * @param config - Resolved database config (contains `provider` field).
 * @returns A ready-to-use (but not yet initialized) DatabaseProvider.
 */
export function resolveDatabaseProvider(
  config: ResolvedDatabaseConfig,
): DatabaseProvider {
  const name = config.provider;
  const factory = _registry.get(name);
  if (!factory) {
    const known = [..._registry.keys()].join(", ");
    throw new Error(
      `database: unknown provider "${name}". Available: ${known}`,
    );
  }
  return factory(config);
}

/**
 * List all registered provider names (useful for diagnostics / help text).
 */
export function getRegisteredDatabaseProviders(): string[] {
  return [..._registry.keys()];
}

// ============================================================================
// Shared instance
// ============================================================================

let shared: DatabaseProvider | undefined;

/**
 * The process-wide database provider, from `loadDatabaseConfig()`. Every
 * module uses this one, so a process holds one Cosmos client (one connection
 * pool, one metadata cache) instead of one per subsystem.
 */
export function getSharedDatabase(loadConfig: () => ResolvedDatabaseConfig): DatabaseProvider {
  return (shared ??= resolveDatabaseProvider(loadConfig()));
}

/** Test helper: forget the shared instance. */
export function resetSharedDatabase(): void {
  shared = undefined;
}
