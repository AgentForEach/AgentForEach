/**
 * AgentForEach Database Layer — Types
 *
 * Provider-agnostic types for the database layer.
 * Shared across all consumers (memory, conversations, settings, etc.).
 *
 * Concrete implementations live in `./providers/` and are resolved via
 * the provider registry (`./providers/index.ts`).
 */

import type {
  ContainerDefinition,
  SqlQuerySpec,
  JSONValue,
  IndexingPolicy,
  VectorEmbeddingPolicy,
  PatchOperation,
} from "@azure/cosmos";

// ============================================================================
// Database Configuration
// ============================================================================

export type DatabaseConfig = {
  /** Database endpoint URL. */
  endpoint: string;
  /**
   * Database primary key or resource token. Empty: authenticate with Entra
   * ID instead (the managed identity in Azure, `az login` locally), which
   * needs the Cosmos DB Built-in Data Contributor role.
   */
  key: string;
  /** User-assigned identity client id for Entra auth (default: system-assigned). */
  identityClientId?: string;
  /** Database name. Default: "agentforeach". */
  databaseId?: string;
  /**
   * Create the database and containers on first use (local development).
   * When false the runtime only references them: they come from the IaC,
   * and cold starts make no control-plane calls. Default: true locally,
   * false on Azure (COSMOS_PROVISION_CONTAINERS overrides).
   */
  provisionContainers?: boolean;
};

// ============================================================================
// Container Definition Helpers
// ============================================================================

/**
 * Extended container options that include vector and full-text policies.
 * Combines the standard Cosmos ContainerDefinition with additional policies
 * that the SDK types expose on the definition object.
 */
export type ContainerOptions = ContainerDefinition & {
  vectorEmbeddingPolicy?: VectorEmbeddingPolicy;
  fullTextPolicy?: {
    defaultLanguage: string;
    fullTextPaths: Array<{ path: string; language: string }>;
  };
};

// ============================================================================
// Query Helpers
// ============================================================================

export type QueryParameter = {
  name: string;
  value: JSONValue;
};

export type QueryOptions = {
  /** Maximum number of results. Applied as TOP in query if not already present. */
  maxResults?: number;
  /** Partition key value for scoped queries. */
  partitionKey?: string;
};

// ============================================================================
// Generic Document
// ============================================================================

/**
 * Base document shape — every database document has at least these fields.
 * Consumers extend this for their domain-specific documents.
 */
export type BaseDocument = {
  /** Document id. */
  id: string;
  /** Partition key value (the actual field name depends on container config). */
  [key: string]: unknown;
};

// ============================================================================
// Container Handle — provider-agnostic CRUD + query interface
// ============================================================================

/**
 * Typed wrapper around a database container.
 * Provides clean CRUD and query methods without exposing raw SDK complexity.
 *
 * Concrete implementations (e.g. `CosmosContainerHandle`) may expose
 * additional provider-specific helpers via subclass methods.
 */
export interface ContainerHandle<T extends BaseDocument = BaseDocument> {
  /** Create a new document. */
  create(document: T): Promise<T>;

  /** Create or replace (upsert) a document. */
  upsert(document: T): Promise<T>;

  /** Read a single document by id + partition key. Returns null if not found. */
  read(id: string, partitionKey: string): Promise<T | null>;

  /** Replace an entire document. */
  replace(id: string, partitionKey: string, document: T): Promise<T>;

  /** Patch specific fields on a document. */
  patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
  ): Promise<T>;

  /** Delete a document by id + partition key. Returns true if deleted. */
  delete(id: string, partitionKey: string): Promise<boolean>;

  /** Execute a SQL query and return typed results. */
  query<R = T>(querySpec: SqlQuerySpec, options?: QueryOptions): Promise<R[]>;

  /**
   * Execute a parameterized query with a simpler API.
   *
   * @param sql - SQL query string (can include @param placeholders).
   * @param parameters - Array of { name, value } parameters.
   */
  queryWithParams<R = T>(
    sql: string,
    parameters?: QueryParameter[],
    options?: QueryOptions,
  ): Promise<R[]>;

  /**
   * Count documents matching a condition.
   *
   * @param whereClause - SQL WHERE clause (without the WHERE keyword).
   * @param parameters - Query parameters.
   */
  count(
    whereClause?: string,
    parameters?: QueryParameter[],
    options?: QueryOptions,
  ): Promise<number>;

  /**
   * Get the raw underlying container object for advanced/provider-specific
   * operations (bulk, change feed, stored procedures, etc.).
   *
   * Returns `unknown` at the interface level — cast to the concrete type
   * (e.g. `Container` from `@azure/cosmos`) when needed.
   */
  getRawContainer(): unknown;
}

// ============================================================================
// Database Provider — provider-agnostic database interface
// ============================================================================

/**
 * Provider-agnostic database interface.
 *
 * All AgentForEach subsystems depend on this interface rather than on a concrete
 * database class.  Concrete implementations (Cosmos DB, noop, etc.) live
 * in `./providers/` and are resolved via the provider registry.
 *
 * Usage:
 * ```ts
 * const db: DatabaseProvider = resolveDatabaseProvider();
 * await db.initialize();
 *
 * const container = await db.getOrCreateContainer<MyDoc>({
 *   id: "my-container",
 *   partitionKey: { paths: ["/userId"] },
 * });
 *
 * await container.create({ id: "1", userId: "u1", text: "hello" });
 * ```
 */
export interface DatabaseProvider {
  /** Human-readable provider name (e.g. "cosmosdb", "noop"). */
  readonly name: string;

  /**
   * Ensure the database exists.
   * Safe to call multiple times — idempotent.
   */
  initialize(): Promise<void>;

  /**
   * Get or create a container with the given definition.
   * Returns a typed ContainerHandle for CRUD operations.
   */
  getOrCreateContainer<T extends BaseDocument = BaseDocument>(
    options: ContainerOptions,
  ): Promise<ContainerHandle<T>>;

  /** Get the database id. */
  getDatabaseId(): string;
}

// ============================================================================
// Re-exports for consumer convenience
// ============================================================================

export type {
  SqlQuerySpec,
  JSONValue,
  IndexingPolicy,
  VectorEmbeddingPolicy,
  PatchOperation,
};
