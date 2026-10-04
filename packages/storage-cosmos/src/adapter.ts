/**
 * AgentForEach Storage — Cosmos DB adapter
 *
 * The storage contract on Azure Cosmos DB for NoSQL, behaving exactly as the
 * runtime's original Cosmos code did:
 *
 *   - documents, `_etag` and TTL are Cosmos' own (a write restarts TTL, an
 *     expired item is invisible at once);
 *   - `ifMatch` is an IfMatch access condition; `patch` is Cosmos partial
 *     document update (`set`/`remove`/`incr`, at most 10 operations);
 *   - queries compile to the SQL in `compile.ts`, partition-scoped through
 *     the SDK's `partitionKey` option;
 *   - auth is a key, or Entra ID through a TokenCredential (managed
 *     identity), so key auth can be disabled on the account;
 *   - with `provisionContainers` the database and containers are created on
 *     first use (local development); without it they are only referenced
 *     (they come from the IaC) and never created at runtime (the SDK still
 *     reads each container's partition key definition once, as before);
 *   - documents come back with `_etag` but without Cosmos' other system
 *     fields (`_rid`, `_self`, `_ts`, `_attachments`), which the runtime never
 *     reads and which other adapters do not have.
 */

import {
  CosmosClient,
  type Container,
  type Database,
  type PatchOperation as CosmosPatchOperation,
  type SqlQuerySpec,
} from "@azure/cosmos";
import type { TokenCredential } from "@azure/core-auth";
import {
  StorageError,
  and,
  eq,
  checkCollectionSpec,
  checkPatch,
  checkPatchTargets,
  isNotFound,
  prepareReplace,
  prepareWrite,
  type Collection,
  type CollectionSpec,
  type CountQuery,
  type Doc,
  type Filter,
  type HybridSearchQuery,
  type PatchOperation,
  type Query,
  type StorageAdapter,
  type StorageAdapterPlugin,
  type StorageCapabilities,
  type Stored,
  type VectorSearchQuery,
  type VectorSearchResult,
  type WriteCondition,
} from "@agentforeach/storage";
import {
  DOCUMENT_ALIAS,
  compileCount,
  compileHybridSearch,
  compileQuery,
  compileVectorSearch,
} from "./compile.js";
import { cosmosOptions, jsonPath, toContainerDefinition } from "./definition.js";
import { toStorageError } from "./errors.js";

export type CosmosStorageOptions = {
  /** Account endpoint, e.g. https://<account>.documents.azure.com:443/. */
  endpoint?: string;
  /** Account key or resource token. Omit to use `credential` (Entra ID). */
  key?: string;
  /** Entra ID credential; needs the Cosmos DB Built-in Data Contributor role. */
  credential?: TokenCredential;
  /** A ready client (tests, custom connection policies); overrides the above. */
  client?: CosmosClient;
  /** Database name. Default "agentforeach". */
  databaseId?: string;
  /** Create the database and containers on first use. Default true. */
  provisionContainers?: boolean;
  /** Override capabilities, e.g. an account without vector or full-text search. */
  capabilities?: Partial<StorageCapabilities>;
};

/** Cosmos system fields other than `_etag`, removed from returned documents. */
const COSMOS_SYSTEM_FIELDS = ["_rid", "_self", "_ts", "_attachments", "_lsn"] as const;

/** The document without Cosmos' system fields (except `_etag`). */
function stripSystemFields<D>(document: D): D {
  if (document === null || typeof document !== "object") return document;
  const out = { ...(document as Record<string, unknown>) };
  for (const field of COSMOS_SYSTEM_FIELDS) delete out[field];
  return out as D;
}

/**
 * `where` restricted to one partition by an explicit `<partition key> = value`
 * term, unless a top-level AND already has exactly that term.
 */
function withPartitionFilter(where: Filter | undefined, field: string, value: string): Filter {
  const terms = where === undefined ? [] : where.op === "and" ? where.filters : [where];
  const present = terms.some((t) => t.op === "eq" && t.field === field && t.value === value);
  if (present && where) return where;
  return and(eq(field, value), where);
}

/** A 404 in any of the shapes the SDK uses (numeric code, statusCode, "NotFound"). */
function isMissing(err: unknown): boolean {
  return isNotFound(toStorageError(err));
}

async function call<R>(operation: () => Promise<R>): Promise<R> {
  try {
    return await operation();
  } catch (err) {
    throw toStorageError(err);
  }
}

function accessCondition(condition?: WriteCondition) {
  return condition?.ifMatch !== undefined
    ? { accessCondition: { type: "IfMatch", condition: condition.ifMatch } }
    : undefined;
}

export class CosmosCollection<T extends Doc = Doc> implements Collection<T> {
  readonly spec: CollectionSpec;
  private readonly container: Container;

  constructor(spec: CollectionSpec, container: Container) {
    this.spec = spec;
    this.container = container;
  }

  async read(id: string, partitionKey: string): Promise<Stored<T> | null> {
    try {
      // SDK v4 resolves a missing item with no resource rather than throwing.
      const { resource } = await this.container.item(id, partitionKey).read<Stored<T>>();
      return resource ? stripSystemFields(resource) : null;
    } catch (err) {
      if (isMissing(err)) return null;
      throw toStorageError(err);
    }
  }

  async create(document: T): Promise<Stored<T>> {
    const { doc } = prepareWrite(this.spec, document);
    const { resource } = await call(() => this.container.items.create(doc));
    return stripSystemFields(resource as unknown as Stored<T>);
  }

  async upsert(document: T): Promise<Stored<T>> {
    const { doc } = prepareWrite(this.spec, document);
    const { resource } = await call(() => this.container.items.upsert(doc));
    return stripSystemFields(resource as unknown as Stored<T>);
  }

  async replace(id: string, partitionKey: string, document: T, condition?: WriteCondition): Promise<Stored<T>> {
    const prepared = prepareReplace(this.spec, id, partitionKey, document);
    const { resource } = await call(() =>
      this.container.item(id, partitionKey).replace(prepared.doc, accessCondition(condition)),
    );
    return stripSystemFields(resource as unknown as Stored<T>);
  }

  async patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
    condition?: WriteCondition,
  ): Promise<Stored<T>> {
    checkPatch(operations);
    checkPatchTargets(this.spec, operations);
    const { resource } = await call(() =>
      this.container
        .item(id, partitionKey)
        .patch<Stored<T>>(operations as CosmosPatchOperation[], accessCondition(condition)),
    );
    return stripSystemFields(resource as Stored<T>);
  }

  async delete(id: string, partitionKey: string, condition?: WriteCondition): Promise<boolean> {
    try {
      await this.container.item(id, partitionKey).delete(accessCondition(condition));
      return true;
    } catch (err) {
      if (isMissing(err)) return false;
      throw toStorageError(err);
    }
  }

  async find<R = Stored<T>>(query: Query = {}): Promise<R[]> {
    const spec = compileQuery(query);
    if (query.limit === 0) return [];
    const rows = await this.run<R>(spec, query.partitionKey);
    return query.select ? rows : rows.map(stripSystemFields);
  }

  async count(query: CountQuery = {}): Promise<number> {
    const [count] = await this.run<number>(compileCount(query), query.partitionKey);
    return count ?? 0;
  }

  async vectorSearch<R = Stored<T>>(query: VectorSearchQuery): Promise<VectorSearchResult<R>[]> {
    const { spec, scoreAlias } = compileVectorSearch(this.spec, query);
    if (query.limit === 0) return [];
    const rows = await this.run<Record<string, unknown>>(spec, query.partitionKey);
    return rows.map((row) => {
      // A document without a vector comes back last, with no score.
      const score = typeof row[scoreAlias] === "number" ? (row[scoreAlias] as number) : null;
      if (!query.select) return { document: stripSystemFields(row[DOCUMENT_ALIAS]) as R, score };
      const { [scoreAlias]: _score, ...document } = row;
      return { document: document as R, score };
    });
  }

  async hybridSearch<R = Stored<T>>(query: HybridSearchQuery): Promise<R[]> {
    // `ORDER BY RANK` is ranked by the SDK from the query plan. With only a
    // partition key the SDK (4.10) skips the plan and Cosmos returns the
    // documents unranked, in storage order. forceQueryPlan gets the ranking,
    // but the SDK's hybrid pipeline then fans out across partitions, so the
    // partition is also pinned in the WHERE clause. Both verified live.
    const scoped =
      query.partitionKey !== undefined
        ? { ...query, where: withPartitionFilter(query.where, this.spec.partitionKey, query.partitionKey) }
        : query;
    const spec = compileHybridSearch(this.spec, scoped);
    if (query.limit === 0) return [];
    const rows = await this.run<R>(spec, query.partitionKey, { forceQueryPlan: true });
    return query.select ? rows : rows.map(stripSystemFields);
  }

  private async run<R>(
    spec: SqlQuerySpec,
    partitionKey: string | undefined,
    extra: { forceQueryPlan?: boolean } = {},
  ): Promise<R[]> {
    const { resources } = await call(() => {
      const options = partitionKey !== undefined ? { partitionKey, ...extra } : Object.keys(extra).length ? extra : undefined;
      const iterator = options ? this.container.items.query<R>(spec, options) : this.container.items.query<R>(spec);
      return iterator.fetchAll();
    });
    return resources;
  }
}

export class CosmosStorage implements StorageAdapter {
  readonly name = "cosmosdb";
  readonly capabilities: StorageCapabilities;
  private readonly client: CosmosClient;
  /** Whether this adapter built the client (and so may dispose it). */
  private readonly ownsClient: boolean;
  private readonly databaseId: string;
  private readonly provision: boolean;
  private database: Database | undefined;
  private initializing: Promise<Database> | undefined;
  private readonly collections = new Map<string, Promise<CosmosCollection>>();

  constructor(options: CosmosStorageOptions) {
    this.ownsClient = !options.client;
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.endpoint) throw new Error("cosmosdb: endpoint is required");
      if (options.key) {
        this.client = new CosmosClient({ endpoint: options.endpoint, key: options.key });
      } else if (options.credential) {
        this.client = new CosmosClient({ endpoint: options.endpoint, aadCredentials: options.credential });
      } else {
        throw new Error("cosmosdb: pass a key or an Entra ID credential");
      }
    }
    this.databaseId = options.databaseId ?? "agentforeach";
    this.provision = options.provisionContainers ?? true;
    this.capabilities = { vectorSearch: true, hybridSearch: true, ...options.capabilities };
  }

  async initialize(): Promise<void> {
    await this.getDatabase();
  }

  /** Release the client's connections and timers (a client passed in stays open). */
  async close(): Promise<void> {
    if (this.ownsClient) this.client.dispose();
  }

  /** The underlying client, for administrative tasks outside the contract. */
  getClient(): CosmosClient {
    return this.client;
  }

  getDatabaseId(): string {
    return this.databaseId;
  }

  async collection<T extends Doc = Doc>(spec: CollectionSpec): Promise<CosmosCollection<T>> {
    checkCollectionSpec(spec);
    let collection = this.collections.get(spec.name);
    if (!collection) {
      collection = this.open(spec);
      this.collections.set(spec.name, collection);
      collection.catch(() => this.collections.delete(spec.name));
    }
    return collection as unknown as Promise<CosmosCollection<T>>;
  }

  private getDatabase(): Promise<Database> {
    if (this.database) return Promise.resolve(this.database);
    this.initializing ??= (async () => {
      const database = this.provision
        ? (await call(() => this.client.databases.createIfNotExists({ id: this.databaseId }))).database
        : this.client.database(this.databaseId);
      this.database = database;
      return database;
    })().finally(() => {
      this.initializing = undefined;
    });
    return this.initializing;
  }

  private async open(spec: CollectionSpec): Promise<CosmosCollection> {
    const database = await this.getDatabase();
    const verify = cosmosOptions(spec).verifyPartitionKey;
    let container: Container;
    let actualKey: string | undefined;
    if (this.provision) {
      // createIfNotExists returns an existing container as it is, so its
      // definition tells whether it matches the spec (no extra call).
      const definition = toContainerDefinition(spec);
      const response = await call(() => database.containers.createIfNotExists(definition as never));
      container = response.container;
      actualKey = response.resource?.partitionKey?.paths?.[0];
    } else {
      container = database.container(spec.name);
      if (verify) actualKey = (await call(() => container.read())).resource?.partitionKey?.paths?.[0];
    }
    if (verify && actualKey !== jsonPath(spec.partitionKey)) {
      throw new StorageError(
        "BadRequest",
        `cosmosdb: container "${spec.name}" is partitioned on ${String(actualKey)}, expected ${jsonPath(spec.partitionKey)}`,
      );
    }
    return new CosmosCollection(spec, container);
  }
}

/** Plugin entry point: `createStorageAdapter("cosmosdb", options)`. */
export const storageAdapter: StorageAdapterPlugin = {
  name: "cosmosdb",
  create: (options) => new CosmosStorage(options as CosmosStorageOptions),
};
