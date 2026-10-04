/**
 * AgentForEach Database Layer — Public API
 *
 * The runtime's storage, through the shared storage SDK
 * (@agentforeach/storage). Every store takes a `StorageAdapter`; which
 * database backs it is configuration ("database.provider").
 *
 *   - `getSharedStorage()`  — the process-wide adapter (one client per process)
 *   - `createStorage(cfg)`  — an adapter for an explicit configuration
 *   - `loadDatabaseConfig()` — the agentforeach.json "database" section, with
 *                             env var overrides
 *
 * Collection definitions live with their stores; `catalog.ts` collects them
 * for account erasure and the IaC catalog.
 */

export { createStorage, getSharedStorage, resetSharedStorage } from "./storage.js";

export {
  loadDatabaseConfig,
  type DatabaseConfig,
  type DatabaseJsonConfig,
  type ResolvedDatabaseConfig,
} from "./config.js";
