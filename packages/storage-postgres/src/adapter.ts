/**
 * AgentForEach Storage — PostgreSQL adapter
 *
 * The storage contract on PostgreSQL (13 or later) with pgvector, one table
 * per collection (see `schema.ts`), behaving as Cosmos DB does:
 *
 *   - `create` is an INSERT that fails with Conflict on a live row (an
 *     expired one is replaced); `upsert` is INSERT ... ON CONFLICT DO UPDATE;
 *   - `_etag` is a UUID written with every change, and `ifMatch` a condition
 *     on it in the same statement;
 *   - `patch` runs in a transaction: the row is locked (SELECT ... FOR
 *     UPDATE), patched with the SDK's own `patchDocument`, and written back, so
 *     concurrent increments serialize and none is lost;
 *   - TTL: every write sets `expires_at` from the database clock, every read
 *     and query hides rows past it, and a background sweep deletes them;
 *   - queries compile to the SQL in `compile.ts`; vector search is exact
 *     cosine similarity (pgvector), hybrid search fuses `ts_rank_cd` and
 *     vector ranks with weighted RRF in one statement;
 *   - with `provisionTables` the tables (and the pgvector extension, where a
 *     collection needs it) are created on first use, and columns or indexes a
 *     newer spec adds are added; without it they must exist (`schemaSql`).
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  StorageError,
  checkCollectionSpec,
  checkPatch,
  checkPatchTargets,
  expiresAtMs,
  patchDocument,
  prepareReplace,
  prepareWrite,
  selectionKey,
  type Collection,
  type CollectionSpec,
  type CountQuery,
  type Doc,
  type HybridSearchQuery,
  type PatchOperation,
  type Query,
  type Selection,
  type StorageAdapter,
  type StorageAdapterPlugin,
  type StorageCapabilities,
  type Stored,
  type VectorSearchQuery,
  type VectorSearchResult,
  type WriteCondition,
} from "@agentforeach/storage";
import {
  LIVE,
  SCORE_COLUMN,
  compileCount,
  compileFind,
  compileHybridSearch,
  compileVectorSearch,
  projectedColumn,
  toJsonText,
  vectorLiteral,
} from "./compile.js";
import { toStorageError } from "./errors.js";
import {
  checkSchemaName,
  createTableSql,
  embeddingOf,
  quoteIdentifier,
  tableColumns,
  tableIndexes,
  tableName,
} from "./schema.js";

/**
 * Where the adapter gets its pool, asked once per query or transaction.
 *
 * Most hosts keep one pool for the life of the process (`connectionString`
 * or `pool`). A host whose connections can't outlive one invocation
 * (Cloudflare Workers through Hyperdrive) passes a source that returns that
 * invocation's own pool, so no connection is ever used across invocations.
 * The adapter never ends a pool it got from a source.
 */
export type PoolSource = () => pg.Pool;

/** How a pool is built: the connection settings of `PostgresStorageOptions`. */
export type PoolOptions = Pick<
  PostgresStorageOptions,
  "connectionString" | "poolSize" | "connectionTimeoutMs" | "idleTimeoutMs" | "statementTimeoutMs" | "serverTimeouts" | "onError"
>;

export type PostgresStorageOptions = {
  /** e.g. postgres://user:password@host:5432/database?sslmode=require */
  connectionString?: string;
  /** A ready pool (tests, custom settings); overrides `connectionString`. */
  pool?: pg.Pool;
  /** A pool per operation (see `PoolSource`); overrides `pool` and `connectionString`. */
  poolSource?: PoolSource;
  /** Most connections the adapter's own pool opens. Default 10. */
  poolSize?: number;
  /** Give up connecting after this many ms. Default 10000. */
  connectionTimeoutMs?: number;
  /**
   * Close a connection idle this many ms. Default 10000 (pg's); 0 keeps
   * idle connections until the pool ends, for a pool that lives only as long
   * as one invocation (on workerd closing one is reported as an error).
   */
  idleTimeoutMs?: number;
  /**
   * Server-side limit on one statement, in ms (a patch waiting on a locked
   * row included). Default 30000; 0 means none. Applies to the adapter's own
   * pool; configure a pool you pass in yourself.
   */
  statementTimeoutMs?: number;
  /**
   * Send `statement_timeout` and `idle_in_transaction_session_timeout` as
   * connection startup parameters. Default true. Poolers that refuse startup
   * parameters (PgBouncer, unless they are in its ignore_startup_parameters)
   * need false; the client-side query timeout still applies.
   */
  serverTimeouts?: boolean;
  /** Schema holding the tables. Default "public". */
  schema?: string;
  /** Create tables (and the pgvector extension) on first use. Default true. */
  provisionTables?: boolean;
  /**
   * How often expired rows are deleted, in ms. Default 60000; 0 disables
   * the sweep (expired rows stay invisible either way).
   */
  sweepIntervalMs?: number;
  /** Override capabilities. */
  capabilities?: Partial<StorageCapabilities>;
  /** Errors from background work (the sweep, idle connections). Default: ignored. */
  onError?: (err: unknown) => void;
  /**
   * Called with work that later callers share and wait on: the connection
   * check and each collection's provisioning. On a host that cancels the I/O
   * of a request once it ends (a Cloudflare Worker), work one request started
   * would otherwise never finish if that request ended first, and everyone
   * awaiting it would wait forever. Hand it to whatever keeps work alive
   * past its request (the gateway passes background()). Default: nothing.
   */
  keepAlive?: (work: Promise<unknown>) => void;
};

/** Rows one sweep statement deletes, and statements per collection per sweep. */
const SWEEP_BATCH = 1000;
const SWEEP_MAX_BATCHES = 10;

/** Advisory lock serializing provisioning across processes (concurrent CREATE TABLE IF NOT EXISTS can fail). */
const PROVISION_LOCK = "agentforeach.storage.provision";

/**
 * How long provisioning DDL waits for a table lock. A long transaction on the
 * table would otherwise stall the ALTER, every query queued behind it, and
 * (through the advisory lock) every other process provisioning anything.
 * The timeout fails the open with Throttled; the next `collection()` retries.
 */
const PROVISION_LOCK_TIMEOUT = "5s";

type Row = { doc: Record<string, unknown>; etag: string };
type Queryable = Pick<pg.Pool, "query">;

/**
 * A pool with the adapter's connection settings: timeouts on the client and
 * (unless `serverTimeouts` is false) on the server, TCP keepalive, and errors
 * from idle connections passed to `onError` rather than crashing the process.
 */
export function createPool(options: PoolOptions): pg.Pool {
  if (!options.connectionString) throw new Error("postgres: pass a connectionString or a pool");
  const statementTimeout = options.statementTimeoutMs ?? 30_000;
  const serverTimeouts = options.serverTimeouts ?? true;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolSize,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMillis: options.idleTimeoutMs } : {}),
    keepAlive: true,
    statement_timeout: (serverTimeouts && statementTimeout) || undefined,
    // Client side, a little later than the server's: a query on a dead
    // socket fails instead of holding its connection forever.
    query_timeout: statementTimeout ? statementTimeout + 5_000 : undefined,
    // A transaction left open by a lost client releases its row locks.
    idle_in_transaction_session_timeout: serverTimeouts ? 60_000 : undefined,
  });
  // An idle connection dropped by the server must not crash the process.
  const onError = options.onError ?? (() => {});
  pool.on("error", (err) => onError(err));
  return pool;
}

/** The pool (from its source, per operation), with errors mapped and transactions on one connection. */
class Database {
  constructor(private readonly source: PoolSource) {}

  get pool(): pg.Pool {
    return this.source();
  }

  async query<R extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
    on: Queryable = this.pool,
  ): Promise<pg.QueryResult<R>> {
    try {
      return await on.query<R>(text, values);
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async transaction<R>(work: (client: pg.PoolClient) => Promise<R>): Promise<R> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw toStorageError(err);
    }
    // While a client is checked out the pool no longer listens for its
    // errors: a connection lost mid-transaction (failover, admin shutdown,
    // network reset) would be an unhandled 'error' event and kill the
    // process. The pending query rejects on its own; this only marks the
    // connection broken so it is not returned to the pool.
    let broken = false;
    const onClientError = () => {
      broken = true;
    };
    client.on("error", onClientError);
    try {
      await this.query("BEGIN", [], client);
      const result = await work(client);
      await this.query("COMMIT", [], client);
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true; // the connection is unusable: drop it from the pool
      }
      throw err;
    } finally {
      client.off("error", onClientError);
      client.release(broken);
    }
  }
}

function output<T extends Doc>(row: Row): Stored<T> {
  return { ...row.doc, _etag: row.etag } as Stored<T>;
}

/** A projected row (`c0`, `c1`... as JSON text) as an object; absent fields left out. */
function projected(row: Record<string, unknown>, select: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  select.forEach((selection, i) => {
    const text = row[projectedColumn(i)];
    if (typeof text === "string") out[selectionKey(selection)] = JSON.parse(text);
  });
  return out;
}

export class PostgresCollection<T extends Doc = Doc> implements Collection<T> {
  readonly spec: CollectionSpec;
  /** `"schema"."name"`. */
  readonly table: string;
  private readonly db: Database;
  /** Column list, VALUES and ON CONFLICT assignments of a full row write. */
  private readonly insertColumns: string;
  private readonly insertValues: string;
  private readonly assignments: string;
  private readonly updateSet: string;

  constructor(spec: CollectionSpec, table: string, db: Database) {
    this.spec = spec;
    this.table = table;
    this.db = db;
    const vector = spec.vector !== undefined;
    this.insertColumns = `pk, id, doc, etag, expires_at${vector ? ", embedding" : ""}`;
    this.insertValues = `$1, $2, $3::jsonb, $4, now() + make_interval(secs => $5::float8)${vector ? ", $6::vector" : ""}`;
    this.assignments =
      "doc = EXCLUDED.doc, etag = EXCLUDED.etag, expires_at = EXCLUDED.expires_at" +
      (vector ? ", embedding = EXCLUDED.embedding" : "");
    this.updateSet =
      "doc = $3::jsonb, etag = $4, expires_at = now() + make_interval(secs => $5::float8)" +
      (vector ? ", embedding = $6::vector" : "");
  }

  /** Parameters $1.. of a full row write (see `insertValues`), and the new etag. */
  private row(doc: Record<string, unknown>, partitionKey: string): { values: unknown[]; etag: string } {
    const etag = `"${randomUUID()}"`;
    const ttlMs = expiresAtMs(this.spec, doc, 0);
    const values: unknown[] = [partitionKey, doc.id, toJsonText(doc), etag, ttlMs === undefined ? null : ttlMs / 1000];
    if (this.spec.vector) {
      const embedding = embeddingOf(this.spec, doc);
      values.push(embedding ? vectorLiteral(embedding) : null);
    }
    return { values, etag };
  }

  private where(extra = ""): string {
    return `t.pk = $1 AND t.id = $2 AND ${LIVE}${extra}`;
  }

  private async exists(id: string, partitionKey: string): Promise<boolean> {
    const { rowCount } = await this.db.query(`SELECT 1 FROM ${this.table} t WHERE ${this.where()}`, [partitionKey, id]);
    return (rowCount ?? 0) > 0;
  }

  async read(id: string, partitionKey: string): Promise<Stored<T> | null> {
    const { rows } = await this.db.query<Row>(
      `SELECT t.doc, t.etag FROM ${this.table} t WHERE ${this.where()}`,
      [partitionKey, id],
    );
    return rows[0] ? output<T>(rows[0]) : null;
  }

  async create(document: T): Promise<Stored<T>> {
    const { doc, partitionKey } = prepareWrite(this.spec, document);
    const { values, etag } = this.row(doc, partitionKey);
    // An expired row still holding the key is replaced, as if it were gone.
    const { rowCount } = await this.db.query(
      `INSERT INTO ${this.table} AS t (${this.insertColumns}) VALUES (${this.insertValues}) ` +
        `ON CONFLICT (pk, id) DO UPDATE SET ${this.assignments} WHERE t.expires_at <= now()`,
      values,
    );
    if (!rowCount) {
      throw new StorageError("Conflict", `document "${String(doc.id)}" already exists in partition "${partitionKey}"`);
    }
    return { ...doc, _etag: etag } as Stored<T>;
  }

  async upsert(document: T): Promise<Stored<T>> {
    const { doc, partitionKey } = prepareWrite(this.spec, document);
    const { values, etag } = this.row(doc, partitionKey);
    await this.db.query(
      `INSERT INTO ${this.table} AS t (${this.insertColumns}) VALUES (${this.insertValues}) ` +
        `ON CONFLICT (pk, id) DO UPDATE SET ${this.assignments}`,
      values,
    );
    return { ...doc, _etag: etag } as Stored<T>;
  }

  async replace(id: string, partitionKey: string, document: T, condition?: WriteCondition): Promise<Stored<T>> {
    const { doc } = prepareReplace(this.spec, id, partitionKey, document);
    const { values, etag } = this.row(doc, partitionKey);
    const ifMatch = condition?.ifMatch;
    const etagTerm = ifMatch !== undefined ? ` AND t.etag = $${values.push(ifMatch)}` : "";
    const { rowCount } = await this.db.query(
      `UPDATE ${this.table} AS t SET ${this.updateSet} WHERE ${this.where(etagTerm)}`,
      values,
    );
    if (!rowCount) {
      if (ifMatch !== undefined && (await this.exists(id, partitionKey))) {
        throw new StorageError("PreconditionFailed", "the document changed since it was read (etag mismatch)");
      }
      throw new StorageError("NotFound", `document "${id}" not found`);
    }
    return { ...doc, _etag: etag } as Stored<T>;
  }

  async patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
    condition?: WriteCondition,
  ): Promise<Stored<T>> {
    checkPatch(operations);
    checkPatchTargets(this.spec, operations);
    return this.db.transaction(async (client) => {
      const { rows } = await this.db.query<Row>(
        `SELECT t.doc, t.etag FROM ${this.table} t WHERE ${this.where()} FOR UPDATE`,
        [partitionKey, id],
        client,
      );
      const current = rows[0];
      if (!current) throw new StorageError("NotFound", `document "${id}" not found`);
      if (condition?.ifMatch !== undefined && condition.ifMatch !== current.etag) {
        throw new StorageError("PreconditionFailed", "the document changed since it was read (etag mismatch)");
      }
      const { doc } = patchDocument(this.spec, current.doc, operations);
      const { values, etag } = this.row(doc, partitionKey);
      await this.db.query(`UPDATE ${this.table} AS t SET ${this.updateSet} WHERE t.pk = $1 AND t.id = $2`, values, client);
      return { ...doc, _etag: etag } as Stored<T>;
    });
  }

  async delete(id: string, partitionKey: string, condition?: WriteCondition): Promise<boolean> {
    const values: unknown[] = [partitionKey, id];
    const ifMatch = condition?.ifMatch;
    const etagTerm = ifMatch !== undefined ? ` AND t.etag = $${values.push(ifMatch)}` : "";
    const { rowCount } = await this.db.query(`DELETE FROM ${this.table} AS t WHERE ${this.where(etagTerm)}`, values);
    if (rowCount) return true;
    if (ifMatch !== undefined && (await this.exists(id, partitionKey))) {
      throw new StorageError("PreconditionFailed", "the document changed since it was read (etag mismatch)");
    }
    return false;
  }

  async find<R = Stored<T>>(query: Query = {}): Promise<R[]> {
    const { text, values } = compileFind(this.table, query);
    if (query.limit === 0) return [];
    const { rows } = await this.db.query(text, values);
    return rows.map((row) => (query.select ? projected(row, query.select) : output(row as Row)) as R);
  }

  async count(query: CountQuery = {}): Promise<number> {
    const { text, values } = compileCount(this.table, query);
    const { rows } = await this.db.query<{ n: string }>(text, values);
    return Number(rows[0]?.n ?? 0);
  }

  async vectorSearch<R = Stored<T>>(query: VectorSearchQuery): Promise<VectorSearchResult<R>[]> {
    const { text, values } = compileVectorSearch(this.table, this.spec, query);
    if (query.limit === 0) return [];
    const { rows } = await this.db.query(text, values);
    return rows.map((row) => ({
      document: (query.select ? projected(row, query.select) : output(row as Row)) as R,
      score: row[SCORE_COLUMN] === null ? null : Number(row[SCORE_COLUMN]),
    }));
  }

  async hybridSearch<R = Stored<T>>(query: HybridSearchQuery): Promise<R[]> {
    const { text, values } = compileHybridSearch(this.table, this.spec, query);
    if (query.limit === 0) return [];
    const { rows } = await this.db.query(text, values);
    return rows.map((row) => (query.select ? projected(row, query.select) : output(row as Row)) as R);
  }

  /** Delete expired rows; returns how many. The adapter's sweep calls this. */
  async sweepExpired(): Promise<number> {
    if (this.spec.defaultTtl === undefined) return 0;
    let deleted = 0;
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      // SKIP LOCKED: rows a writer holds (say, a create reviving the key)
      // are left to the next sweep.
      const { rowCount } = await this.db.query(
        `DELETE FROM ${this.table} WHERE expires_at <= now() AND ctid = ANY (ARRAY(` +
          `SELECT ctid FROM ${this.table} WHERE expires_at <= now() LIMIT ${SWEEP_BATCH} FOR UPDATE SKIP LOCKED))`,
      );
      deleted += rowCount ?? 0;
      if ((rowCount ?? 0) < SWEEP_BATCH) break;
    }
    return deleted;
  }
}

export class PostgresStorage implements StorageAdapter {
  readonly name = "postgres";
  readonly capabilities: StorageCapabilities;
  private readonly db: Database;
  /** Whether this adapter built the pool (and so may end it). */
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly provision: boolean;
  private readonly sweepIntervalMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly keepAlive: ((work: Promise<unknown>) => void) | undefined;
  private readonly collections = new Map<string, Promise<PostgresCollection>>();
  private initializing: Promise<void> | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping: Promise<unknown> | undefined;
  private closed = false;

  constructor(options: PostgresStorageOptions) {
    this.onError = options.onError ?? (() => {});
    this.keepAlive = options.keepAlive;
    let source: PoolSource;
    if (options.poolSource) {
      source = options.poolSource;
      this.ownsPool = false;
    } else if (options.pool) {
      const pool = options.pool;
      source = () => pool;
      this.ownsPool = false;
    } else if (options.connectionString) {
      const pool = createPool({ ...options, onError: this.onError });
      source = () => pool;
      this.ownsPool = true;
    } else {
      throw new Error("postgres: pass a connectionString, a pool or a poolSource");
    }
    this.db = new Database(source);
    this.schema = checkSchemaName(options.schema ?? "public");
    this.provision = options.provisionTables ?? true;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.capabilities = { vectorSearch: true, hybridSearch: true, ...options.capabilities };
  }

  /** Check the connection and start the TTL sweep. Idempotent. */
  async initialize(): Promise<void> {
    this.checkOpen();
    if (!this.initializing) {
      this.initializing = this.db.query("SELECT 1").then(
        () => this.startSweep(),
        (err) => {
          this.initializing = undefined;
          throw err;
        },
      );
      this.keepAlive?.(this.initializing);
    }
    await this.initializing;
  }

  async collection<T extends Doc = Doc>(spec: CollectionSpec): Promise<PostgresCollection<T>> {
    this.checkOpen();
    checkCollectionSpec(spec);
    let collection = this.collections.get(spec.name);
    if (!collection) {
      collection = this.open(spec);
      this.collections.set(spec.name, collection);
      collection.catch(() => this.collections.delete(spec.name));
      this.keepAlive?.(collection);
    }
    this.startSweep();
    return collection as unknown as Promise<PostgresCollection<T>>;
  }

  /** Delete expired rows in every collection opened so far; returns how many. */
  async sweepExpired(): Promise<number> {
    let deleted = 0;
    for (const pending of [...this.collections.values()]) {
      const collection = await pending.catch(() => undefined);
      if (collection) deleted += await collection.sweepExpired();
    }
    return deleted;
  }

  /**
   * Open every collection in `specs` (provisioning it, unless
   * `provisionTables` is off) and delete its expired rows; returns how many.
   * For hosts that sweep on a schedule because a process-lifetime timer
   * can't run there (`sweepIntervalMs: 0`). The specs are the gateway's
   * catalog (`recordCollectionSpecs`), so collections nobody has opened in
   * this process are swept too.
   */
  async sweepAll(specs: readonly CollectionSpec[]): Promise<number> {
    let deleted = 0;
    for (const spec of specs) {
      if (spec.defaultTtl === undefined) continue;
      deleted += await (await this.collection(spec)).sweepExpired();
    }
    return deleted;
  }

  /** Stop the sweep and, if the adapter created the pool, close it. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.sweeping?.catch(() => undefined);
    if (this.ownsPool) await this.db.pool.end();
  }

  /** The pool (the current one, with a `poolSource`), for administrative tasks outside the contract. */
  getPool(): pg.Pool {
    return this.db.pool;
  }

  getSchema(): string {
    return this.schema;
  }

  private checkOpen(): void {
    if (this.closed) throw new Error("postgres: the adapter is closed");
  }

  private startSweep(): void {
    if (this.closed || this.sweepTimer || this.sweepIntervalMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      if (this.sweeping) return; // the previous sweep is still running
      this.sweeping = this.sweepExpired()
        .catch((err) => this.onError(err))
        .finally(() => {
          this.sweeping = undefined;
        });
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private async open(spec: CollectionSpec): Promise<PostgresCollection> {
    const table = tableName(spec, this.schema);
    if (this.provision) await this.provisionTable(spec, table);
    return new PostgresCollection(spec, table, this.db);
  }

  /**
   * Create the table, or bring an existing one up to the spec: missing
   * columns (a new full-text field, a vector policy) and indexes are added;
   * nothing is dropped or changed. Catalog checks first, so a table that is
   * already complete takes no locks beyond the advisory one.
   */
  private async provisionTable(spec: CollectionSpec, table: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const run = (text: string, values: unknown[] = []) => this.db.query(text, values, client);
      await run(`SET LOCAL lock_timeout = '${PROVISION_LOCK_TIMEOUT}'`);
      await run("SELECT pg_advisory_xact_lock(hashtext($1))", [PROVISION_LOCK]);
      if (spec.vector && !(await run("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).rowCount) {
        await run("CREATE EXTENSION IF NOT EXISTS vector");
      }
      if (!(await run("SELECT 1 FROM pg_namespace WHERE nspname = $1", [this.schema])).rowCount) {
        await run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(this.schema)}`);
      }
      const relation = await run("SELECT relkind FROM pg_class WHERE oid = to_regclass($1)", [table]);
      const kind = relation.rows[0]?.relkind as string | undefined;
      if (kind !== undefined && kind !== "r" && kind !== "p") {
        throw new StorageError("BadRequest", `postgres: ${table} exists and is not a table (relkind ${kind})`);
      }
      const { rows } =
        kind === undefined
          ? { rows: [] as Array<Record<string, unknown>> }
          : await run("SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped", [
              table,
            ]);
      if (rows.length === 0) {
        await run(createTableSql(spec, this.schema));
      } else {
        const present = new Set(rows.map((r) => r.attname as string));
        for (const column of tableColumns(spec)) {
          if (!present.has(column.name)) {
            await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column.name)} ${column.definition}`);
          }
        }
      }
      const indexes = await run("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2", [
        this.schema,
        spec.name,
      ]);
      // (Index names carry a hash of collection and purpose, so a name taken
      // by another table's index is not a realistic collision.)
      const existing = new Set(indexes.rows.map((r) => r.indexname as string));
      for (const index of tableIndexes(spec, this.schema)) {
        if (!existing.has(index.name)) await run(index.sql);
      }
    });
  }
}

/**
 * Plugin entry point: `createStorageAdapter("postgres", options)`. Besides
 * its own options it reads the generic ones a host passes to any adapter:
 * `endpoint` as the connection string, `provisionContainers` as
 * `provisionTables`.
 */
export const storageAdapter: StorageAdapterPlugin = {
  name: "postgres",
  create: (options) => {
    const generic = options as PostgresStorageOptions & { endpoint?: unknown; provisionContainers?: unknown };
    return new PostgresStorage({
      ...generic,
      connectionString: generic.connectionString ?? (typeof generic.endpoint === "string" ? generic.endpoint : undefined),
      provisionTables:
        generic.provisionTables ?? (typeof generic.provisionContainers === "boolean" ? generic.provisionContainers : undefined),
    });
  },
};
