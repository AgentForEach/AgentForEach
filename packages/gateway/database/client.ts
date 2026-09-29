/**
 * AgentForEach Database Layer — Cosmos DB Client
 *
 * Concrete Cosmos DB implementation of the `DatabaseProvider` and
 * `ContainerHandle` interfaces.
 *
 * Consumers should depend on the interfaces from `./types.js` rather than
 * importing this file directly.  Use the provider registry
 * (`./providers/index.js`) to resolve the active provider.
 *
 * Usage:
 * ```ts
 * const db = new CosmosDatabase({ endpoint, key });
 * await db.initialize();
 *
 * const container = await db.getOrCreateContainer({
 *   id: "memories",
 *   partitionKey: { paths: ["/userId"] },
 *   // ... indexing policies
 * });
 *
 * await container.create({ id: "1", userId: "u1", text: "hello" });
 * const doc = await container.read("1", "u1");
 * ```
 */

import {
  CosmosClient,
  Database,
  Container,
  type SqlQuerySpec,
  type JSONValue,
  type PatchOperation,
} from "@azure/cosmos";
import type { TokenCredential } from "@azure/core-auth";
import { createAzureTokenCredential } from "../utils/azure-token.js";
import type {
  DatabaseConfig,
  DatabaseProvider,
  ContainerHandle,
  ContainerOptions,
  QueryParameter,
  QueryOptions,
  BaseDocument,
} from "./types.js";

// ============================================================================
// Database Client
// ============================================================================

/** Entra ID resource for the Cosmos DB data plane. */
const COSMOS_TOKEN_RESOURCE = "https://cosmos.azure.com";

export class CosmosDatabase implements DatabaseProvider {
  readonly name = "cosmosdb";

  private client: CosmosClient;
  private databaseId: string;
  private database!: Database;
  private containers = new Map<string, CosmosContainerHandle>();
  private initialized = false;
  private provision: boolean;

  constructor(config: DatabaseConfig) {
    if (!config.endpoint) throw new Error("database: endpoint is required");

    // No key: Entra ID (managed identity), so the master key need not be
    // handed to the app at all and key auth can be disabled on the account.
    this.client = config.key
      ? new CosmosClient({ endpoint: config.endpoint, key: config.key })
      : new CosmosClient({
          endpoint: config.endpoint,
          aadCredentials: createAzureTokenCredential(
            COSMOS_TOKEN_RESOURCE,
            config.identityClientId,
          ) as unknown as TokenCredential,
        });
    this.databaseId = config.databaseId ?? "agentforeach";
    this.provision = config.provisionContainers ?? true;
  }

  /**
   * Ensure the database exists.
   * Safe to call multiple times — idempotent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.provision) {
      const { database } = await this.client.databases.createIfNotExists({
        id: this.databaseId,
      });
      this.database = database;
    } else {
      this.database = this.client.database(this.databaseId);
    }
    this.initialized = true;
  }

  /**
   * Get or create a container with the given definition.
   * Returns a typed ContainerHandle for CRUD operations.
   *
   * Container definitions (including vector/full-text policies and indexes)
   * are applied on creation. Cosmos DB does not allow modifying vector
   * policies after creation — to change them, drop and recreate the container.
   */
  async getOrCreateContainer<T extends BaseDocument = BaseDocument>(
    options: ContainerOptions,
  ): Promise<CosmosContainerHandle<T>> {
    await this.ensureInitialized();

    const containerId = options.id!;
    const cached = this.containers.get(containerId);
    if (cached) return cached as CosmosContainerHandle<T>;

    // Provisioned mode creates the container as defined; otherwise it must
    // already exist (IaC: packages/infra/cosmos-containers.json).
    const container = this.provision
      ? (await this.database.containers.createIfNotExists(options)).container
      : this.database.container(containerId);
    const handle = new CosmosContainerHandle<T>(container);
    this.containers.set(containerId, handle as CosmosContainerHandle);
    return handle;
  }

  /**
   * Get the underlying Cosmos Database object for advanced usage.
   */
  getDatabase(): Database {
    if (!this.initialized) {
      throw new Error("database: not initialized. Call initialize() first.");
    }
    return this.database;
  }

  /** Get the database id. */
  getDatabaseId(): string {
    return this.databaseId;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}

// ============================================================================
// Container Handle — Cosmos DB implementation
// ============================================================================

/**
 * Cosmos DB implementation of the `ContainerHandle` interface.
 * Provides typed CRUD and query methods wrapping a Cosmos DB Container.
 *
 * Use `getRawContainer()` for advanced Cosmos-specific operations
 * (optimistic concurrency, bulk ops, change feed, stored procedures).
 */
export class CosmosContainerHandle<
  T extends BaseDocument = BaseDocument,
> implements ContainerHandle<T> {
  private container: Container;

  constructor(container: Container) {
    this.container = container;
  }

  // --------------------------------------------------------------------------
  // Create
  // --------------------------------------------------------------------------

  /**
   * Create a new document.
   * @returns The created document.
   */
  async create(document: T): Promise<T> {
    const { resource } = await this.container.items.create<T>(document);
    return resource as T;
  }

  /**
   * Create or replace (upsert) a document.
   */
  async upsert(document: T): Promise<T> {
    const { resource } = await this.container.items.upsert<T>(document);
    return resource as T;
  }

  // --------------------------------------------------------------------------
  // Read
  // --------------------------------------------------------------------------

  /**
   * Read a single document by id + partition key.
   * @returns The document, or null if not found.
   */
  async read(id: string, partitionKey: string): Promise<T | null> {
    try {
      const { resource } = await this.container
        .item(id, partitionKey)
        .read<T>();
      return resource ?? null;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Update
  // --------------------------------------------------------------------------

  /**
   * Replace an entire document.
   */
  async replace(id: string, partitionKey: string, document: T): Promise<T> {
    const { resource } = await this.container
      .item(id, partitionKey)
      .replace<T>(document);
    return resource as T;
  }

  /**
   * Patch specific fields on a document.
   */
  async patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
  ): Promise<T> {
    const { resource } = await this.container
      .item(id, partitionKey)
      .patch<T>(operations);
    return resource as T;
  }

  // --------------------------------------------------------------------------
  // Delete
  // --------------------------------------------------------------------------

  /**
   * Delete a document by id + partition key.
   * @returns true if deleted, false if not found.
   */
  async delete(id: string, partitionKey: string): Promise<boolean> {
    try {
      await this.container.item(id, partitionKey).delete();
      return true;
    } catch (err: unknown) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  /**
   * Execute a SQL query and return typed results.
   */
  async query<R = T>(
    querySpec: SqlQuerySpec,
    options: QueryOptions = {},
  ): Promise<R[]> {
    const iterator =
      options.partitionKey !== undefined
        ? this.container.items.query<R>(querySpec, {
            partitionKey: options.partitionKey,
          })
        : this.container.items.query<R>(querySpec);
    const { resources } = await iterator.fetchAll();
    return resources;
  }

  /**
   * Execute a parameterized query with a simpler API.
   *
   * @param sql - SQL query string (can include @param placeholders).
   * @param parameters - Array of { name, value } parameters.
   * @returns Typed result array.
   */
  async queryWithParams<R = T>(
    sql: string,
    parameters: QueryParameter[] = [],
    options: QueryOptions = {},
  ): Promise<R[]> {
    return this.query<R>({ query: sql, parameters }, options);
  }

  /**
   * Count documents matching a condition.
   *
   * @param whereClause - SQL WHERE clause (without the WHERE keyword).
   * @param parameters - Query parameters.
   */
  async count(
    whereClause?: string,
    parameters?: QueryParameter[],
    options: QueryOptions = {},
  ): Promise<number> {
    const sql = whereClause
      ? `SELECT VALUE COUNT(1) FROM c WHERE ${whereClause}`
      : "SELECT VALUE COUNT(1) FROM c";
    const results = await this.queryWithParams<number>(
      sql,
      parameters,
      options,
    );
    return results[0] ?? 0;
  }

  /**
   * Get the raw Cosmos Container for advanced operations
   * (bulk, change feed, stored procedures, optimistic concurrency, etc.).
   *
   * Narrows the return type from the generic `unknown` on the interface
   * to the concrete Cosmos `Container`.
   */
  getRawContainer(): Container {
    return this.container;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a Cosmos DB error is a 404 Not Found.
 */
function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  // @azure/cosmos v4 may set code as number 404 or string "NotFound",
  // and/or statusCode as number 404.
  return e.code === 404 || e.code === "NotFound" || e.statusCode === 404;
}
