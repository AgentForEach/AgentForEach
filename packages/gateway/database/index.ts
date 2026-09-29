/**
 * AgentForEach Database Layer — Public API
 *
 * Barrel export for the modular, provider-based database layer.
 * All AgentForEach subsystems should import from here.
 *
 * Provider-agnostic types:
 *   - `DatabaseProvider`  — interface for database backends
 *   - `ContainerHandle`   — interface for container CRUD + query
 *
 * Concrete Cosmos DB implementation:
 *   - `CosmosDatabase`          — Cosmos DB `DatabaseProvider`
 *   - `CosmosContainerHandle`   — Cosmos DB `ContainerHandle`
 *
 * Provider registry:
 *   - `resolveDatabaseProvider(config)` — resolve the active provider
 *   - `registerDatabaseProvider(name, factory)` — register custom providers
 *
 * Config:
 *   - `loadDatabaseConfig()` — load from agentforeach.json "database" section
 */

// -- Concrete implementations ------------------------------------------------
export { CosmosDatabase, CosmosContainerHandle } from "./client.js";

// -- Provider registry -------------------------------------------------------
export {
  resolveDatabaseProvider,
  resetSharedDatabase,
  registerDatabaseProvider,
  getRegisteredDatabaseProviders,
  type DatabaseProviderFactory,
} from "./providers/index.js";

// -- Config ------------------------------------------------------------------
export {
  loadDatabaseConfig,
  type DatabaseJsonConfig,
  type ResolvedDatabaseConfig,
} from "./config.js";

// -- Types (provider-agnostic interfaces + helpers) --------------------------
export type {
  DatabaseProvider,
  ContainerHandle,
  DatabaseConfig,
  ContainerOptions,
  QueryParameter,
  QueryOptions,
  BaseDocument,
} from "./types.js";

// -- Re-export commonly needed Cosmos SDK types so consumers
//    don't need a direct @azure/cosmos dependency for type-only usage. --------
export type {
  SqlQuerySpec,
  JSONValue,
  IndexingPolicy,
  VectorEmbeddingPolicy,
  PatchOperation,
} from "@azure/cosmos";

import { getSharedDatabase as getShared } from "./providers/index.js";
import { loadDatabaseConfig as loadConfig } from "./config.js";

/** The process-wide database provider (one Cosmos client per process). */
export function getSharedDatabase() {
  return getShared(loadConfig);
}
