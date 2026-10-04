/**
 * AgentForEach Database Layer — Storage adapter
 *
 * The runtime's storage, through the shared SDK (@agentforeach/storage):
 * every store works against a `StorageAdapter`, so the database behind it is
 * a configuration choice ("database.provider" / DATABASE_PROVIDER):
 *
 *   - "cosmosdb" (default): Azure Cosmos DB, key or Entra ID (managed
 *     identity) auth, from COSMOS_ENDPOINT / COSMOS_KEY / COSMOS_DATABASE
 *     (loaded on first use, so other deployments never load the Azure SDK);
 *   - "postgres": PostgreSQL with pgvector, from DATABASE_URL (loaded on
 *     first use, so Cosmos deployments never load the driver). On a host
 *     whose connections can't outlive an invocation (`HostInfo.persistent`
 *     false: Cloudflare Workers through Hyperdrive), each invocation gets
 *     its own small pool, ended with it; the adapter itself, and the tables
 *     it has provisioned, stay shared;
 *   - "memory": in-process, for tests and single-process local runs;
 *   - anything else: an adapter package or file, loaded at first use
 *     (`createStorageAdapter` in the SDK), e.g. "@acme/storage-dynamo".
 */

import {
  createStorageAdapter,
  InMemoryStorage,
  type CollectionSpec,
  type Doc,
  type StorageAdapter,
  type StorageCapabilities,
} from "@agentforeach/storage";
import { background, currentScope, scopeKey } from "@agentforeach/platform";
import type { createPool, PoolOptions, PoolSource } from "@agentforeach/storage-postgres";
import { hostInfo } from "../runtime/host.js";
import { loadDatabaseConfig, type ResolvedDatabaseConfig } from "./config.js";

/** Entra ID resource for the Cosmos DB data plane. */
const COSMOS_TOKEN_RESOURCE = "https://cosmos.azure.com";

/**
 * An adapter loaded on first use (plugin packages load asynchronously, while
 * stores are constructed synchronously). Capabilities read as "none" until
 * it is initialized; stores initialize before they search.
 */
class LazyStorage implements StorageAdapter {
  readonly name: string;
  private loaded: StorageAdapter | undefined;
  private loading: Promise<StorageAdapter> | undefined;

  constructor(
    name: string,
    private readonly load: () => Promise<StorageAdapter>,
  ) {
    this.name = name;
  }

  get capabilities(): StorageCapabilities {
    return this.loaded?.capabilities ?? { vectorSearch: false, hybridSearch: false };
  }

  /** The plugin, loaded and initialized once (concurrent callers share it). */
  private adapter(): Promise<StorageAdapter> {
    this.loading ??= this.load().then(
      async (adapter) => {
        try {
          await adapter.initialize();
        } catch (err) {
          // The next call loads a fresh adapter; release this one's resources.
          await adapter.close?.().catch(() => undefined);
          throw err;
        }
        return (this.loaded = adapter);
      },
      (err) => {
        this.loading = undefined;
        throw err;
      },
    );
    this.loading.catch(() => {
      this.loading = undefined;
    });
    // Concurrent callers share it: keep it alive past the request that began it (see background()).
    background(this.loading, () => {});
    return this.loading;
  }

  async initialize(): Promise<void> {
    await this.adapter();
  }

  async collection<T extends Doc>(spec: CollectionSpec) {
    return (await this.adapter()).collection<T>(spec);
  }

  async close(): Promise<void> {
    const adapter = this.loaded ?? (await this.loading?.catch(() => undefined));
    await adapter?.close?.();
  }

  /** The loaded adapter's sweep of every collection in `specs`, or null when it has none. */
  async sweepAll(specs: readonly CollectionSpec[]): Promise<number | null> {
    const adapter = (await this.adapter()) as StorageAdapter & { sweepAll?: (s: readonly CollectionSpec[]) => Promise<number> };
    return typeof adapter.sweepAll === "function" ? adapter.sweepAll(specs) : null;
  }
}

/** Each invocation's Postgres pool, on hosts that aren't persistent. */
const POSTGRES_POOL = scopeKey<ReturnType<typeof createPool>>("database.postgresPool");

/** Connections per invocation when none are configured: Workers allow six outbound at once. */
const SCOPED_POOL_SIZE = 2;

/**
 * A pool source giving each invocation its own pool, ended when the
 * invocation is (after its background work). A connection used across
 * invocations on such a host doesn't fail, it hangs until the query timeout,
 * so outside an invocation this refuses at once.
 */
export function scopedPoolSource(create: typeof createPool, options: PoolOptions): PoolSource {
  return () => {
    const scope = currentScope();
    if (!scope) {
      throw new Error(
        "database: on this host a database connection only exists inside an invocation (a request, a schedule tick or a job), and none is open here.",
      );
    }
    return scope.resource(POSTGRES_POOL, () => {
      // Ending the pool closes its connections, and on workerd each closed
      // socket is reported as an error; those are the pool closing on purpose.
      let ending = false;
      const pool = create({
        ...options,
        poolSize: options.poolSize ?? SCOPED_POOL_SIZE,
        // The pool ends with the invocation. Closing idle connections earlier
        // only reconnects, and on workerd each close is reported as an error
        // (a turn waiting on the model logged one every time).
        idleTimeoutMs: options.idleTimeoutMs ?? 0,
        onError: (err) => {
          if (!ending) options.onError?.(err);
        },
      });
      scope.onEnd(() => {
        ending = true;
        return pool.end();
      });
      return pool;
    });
  };
}

/** The storage adapter for a resolved database configuration. */
export function createStorage(config: ResolvedDatabaseConfig): StorageAdapter {
  switch (config.provider) {
    case "cosmosdb": {
      if (!config.endpoint) {
        throw new Error(
          'database: "cosmosdb" provider requires an endpoint. ' +
            "Set COSMOS_ENDPOINT env var or configure in agentforeach.json.",
        );
      }
      const endpoint = config.endpoint;
      return new LazyStorage("cosmosdb", async () => {
        const [{ CosmosStorage }, { createAzureTokenCredential }] = await Promise.all([
          // The adapter subpath only: a Worker bundle aliases it away (deploy/cloudflare/wrangler.jsonc).
          import("@agentforeach/storage-cosmos/adapter"),
          import("@agentforeach/platform-azure/identity"),
        ]);
        // No key: Entra ID (the managed identity in Azure, `az login` locally),
        // so the master key need not be handed to the app at all.
        return new CosmosStorage({
          endpoint,
          key: config.key || undefined,
          credential: config.key ? undefined : createAzureTokenCredential(COSMOS_TOKEN_RESOURCE, config.identityClientId),
          databaseId: config.databaseId,
          provisionContainers: config.provisionContainers,
        });
      });
    }
    case "postgres": {
      const connectionString = config.connectionString;
      if (!connectionString) {
        throw new Error(
          'database: "postgres" provider requires a connection string. ' +
            "Set DATABASE_URL or database.connectionString in agentforeach.json.",
        );
      }
      // Read when the storage is built: a host installs its HostInfo first.
      const persistent = hostInfo().persistent !== false;
      return new LazyStorage("postgres", async () => {
        const { PostgresStorage, createPool } = await import("@agentforeach/storage-postgres");
        const onError = (err: unknown) =>
          console.warn(`[database] postgres background error: ${err instanceof Error ? err.message : String(err)}`);
        const pool: PoolOptions = { connectionString, poolSize: config.poolSize, serverTimeouts: config.serverTimeouts, onError };
        return new PostgresStorage({
          // Persistent hosts keep one pool for the process, as before.
          // Elsewhere each invocation has its own, and shared setup outlives the request that began it.
          ...(persistent
            ? pool
            : { poolSource: scopedPoolSource(createPool, pool), sweepIntervalMs: 0, keepAlive: (work) => background(work, () => {}) }),
          schema: config.schema,
          provisionTables: config.provisionContainers,
          onError,
        });
      });
    }
    case "memory":
      return new InMemoryStorage();
    default:
      return new LazyStorage(config.provider, () =>
        createStorageAdapter(config.provider, {
          endpoint: config.endpoint,
          key: config.key,
          databaseId: config.databaseId,
          provisionContainers: config.provisionContainers,
          identityClientId: config.identityClientId,
        }),
      );
  }
}

let shared: StorageAdapter | undefined;

/**
 * The process-wide storage adapter, from `loadDatabaseConfig()`. Every store
 * uses this one, so a process holds one database client (one connection
 * pool, one metadata cache) instead of one per subsystem.
 */
export function getSharedStorage(): StorageAdapter {
  return (shared ??= createStorage(loadDatabaseConfig()));
}

/** Test helper: forget the shared adapter. */
export function resetSharedStorage(): void {
  shared = undefined;
}
