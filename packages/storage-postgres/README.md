# @agentforeach/storage-postgres

The PostgreSQL adapter for [`@agentforeach/storage`](../storage). It passes the same conformance suite as the Cosmos DB adapter, so the runtime behaves the same on either database.

It needs PostgreSQL 13 or later with the [pgvector](https://github.com/pgvector/pgvector) extension. Managed services that offer pgvector work: Azure Database for PostgreSQL (allow `VECTOR` in `azure.extensions`), Amazon RDS and Aurora, Google Cloud SQL, Supabase, Neon. Locally, run the `pgvector/pgvector:pg17` image.

```ts
import { PostgresStorage } from "@agentforeach/storage-postgres";

const storage = new PostgresStorage({
  connectionString: process.env.DATABASE_URL, // postgres://user:pass@host:5432/db?sslmode=require
  schema: "public",                           // default
  provisionTables: true,                      // default: create tables on first use
});
```

The adapter also loads by name: `createStorageAdapter("postgres", options)`. Through the registry it also accepts the generic host options: `endpoint` is used as the connection string and `provisionContainers` as `provisionTables`.

| Option | Default | Effect |
|---|---|---|
| `connectionString` | | Where to connect. Required unless you pass `pool` |
| `pool` | | Your own `pg.Pool`. The adapter never closes a pool it did not create |
| `poolSize` | 10 | Most connections the adapter's pool opens. Keep it small when many instances share one server |
| `connectionTimeoutMs` | 10000 | Give up connecting after this long |
| `statementTimeoutMs` | 30000 | Server-side limit on one statement, a patch waiting on a locked row included; `0` for none. The pool also sets a client-side query timeout 5 s later (so a dead socket cannot hold a connection), TCP keepalive, and a 60 s `idle_in_transaction_session_timeout`. These apply to the adapter's own pool; set them yourself on a pool you pass in |
| `serverTimeouts` | `true` | Send the statement and idle-in-transaction timeouts as connection startup parameters. Set `false` behind a pooler that refuses startup parameters (PgBouncer, unless they are in its `ignore_startup_parameters`); the client-side query timeout still applies |
| `schema` | `public` | Schema holding the tables |
| `provisionTables` | `true` | Create the tables, and the pgvector extension where a collection needs it, on first use. Columns and indexes a newer spec adds are added; nothing is dropped. With `false`, the tables must already exist (see `schemaSql`) |
| `sweepIntervalMs` | 60000 | How often expired rows are deleted. `0` turns the sweep off. Expired rows are invisible either way |
| `capabilities` | both on | Override `vectorSearch` / `hybridSearch` |
| `onError` | ignored | Receives errors from background work: the sweep and dropped idle connections |

`close()` stops the sweep and ends the adapter's own pool; it is idempotent, and the adapter cannot be used afterwards.

## How it maps the contract

| Contract | PostgreSQL |
|---|---|
| Collection | One table per collection, named exactly like the collection (quoted, so `rate-limits` keeps its hyphen). `PRIMARY KEY (pk, id)` |
| Document | A `jsonb` column, stored as written. A field is `doc #> '{a,b}'`, which is SQL NULL when the field is absent, so absent and JSON `null` stay different |
| `_etag`, `ifMatch` | A UUID column, rewritten on every write; `ifMatch` is a condition in the same statement |
| `create` | `INSERT ... ON CONFLICT DO UPDATE ... WHERE <expired>`: a live row means `Conflict`; an expired row still holding the key is replaced |
| `patch` | A transaction: `SELECT ... FOR UPDATE`, the SDK's own `patchDocument`, `UPDATE`. Concurrent increments queue on the row lock, so none is lost |
| TTL | `expires_at`, set from the database clock on every write. Every read and query filters on it, so expiry is exact. A background sweep deletes expired rows in batches |
| Filters | Three-valued logic is SQL's own: absent is NULL. `eq`/`ne`/`in` use jsonb equality, which is type-strict. Range comparisons are a `CASE` on `jsonb_typeof`, so a comparison across types is NULL (unknown) as in Cosmos DB. Strings compare in UTF-8 byte order (`COLLATE "C"`). Case-insensitive `contains` folds both sides with the database's `lower()` |
| `orderBy` | Type rank first (absent < null < boolean < number < string), then the value: jsonb for numbers and booleans, `COLLATE "C"` for strings. Ties are broken by `(pk, id)`, here and in vector and hybrid search, so a limit cuts the same rows on every call |
| `vectorSearch` | Exact cosine similarity with pgvector (`1 - (embedding <=> query)`). Rows without a vector of the collection's size come last with a `null` score |
| `hybridSearch` | One statement: `ts_rank_cd` on a generated `tsvector` column and the vector similarity, `dense_rank()` per component over every candidate, then `ORDER BY sum(weight / (60 + rank))` |
| Errors | `StorageError`s, with the `pg` error as `cause`. Client-side network errors (refused or dropped connections) pass through unchanged, as the Cosmos adapter's do. `23505` → `Conflict`; retry-later conditions (deadlocks, serialization failures, lock and statement timeouts, resource and connection limits, a read-only server during failover, shutdown or startup) → `Throttled`; values PostgreSQL cannot store (`\u0000` in text, numbers out of range, keys too large for the index) → `BadRequest` |

### Table layout

```sql
CREATE TABLE "public"."memories" (
  "pk"         text NOT NULL,          -- the partition key value
  "id"         text NOT NULL,
  "doc"        jsonb NOT NULL,         -- the document, without _etag
  "etag"       text NOT NULL,
  "expires_at" timestamptz,            -- NULL: never expires
  "embedding"  vector,                 -- collections with a vector policy
  "fts:english:text" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, ...)) STORED,
  PRIMARY KEY (pk, id)
);
```

`schemaSql(spec, { schema })` returns this DDL, with the indexes, for migrations and infrastructure code. The adapter uses the same definitions when it provisions tables.

Design choices worth knowing:

- **The vector is stored twice.** It stays in `doc`, so documents read back exactly as written, and goes into `embedding` (float32) for search. `embedding` has no fixed size, so changing the embedding model leaves old rows unscored until they are rewritten, instead of failing writes.
- **Vector search is exact; there is no vector index.** Searches are scoped to one user's partition, which the primary key finds directly. An approximate (HNSW) index can return fewer rows than the limit once a filter applies; an exact scan cannot.
- **Full-text relevance is `ts_rank_cd`, not BM25.** It ranks by term frequency and proximity, with no inverse document frequency. Within one user's memories this ranks much like BM25; it can differ when a query mixes rare and common words. Each `fullText.language` maps to the matching built-in configuration (`en-US` → `english`, `de` → `german`, `hi` → `hindi`, ...), or to `simple` (no stemming) when there is none. Query terms are split into words (letters, digits and combining marks), and any word may match.
- **Stored as UTF-8 jsonb.** Object keys come back in jsonb's order (shorter keys first), not the order they were written; arrays keep their order. A lone UTF-16 surrogate in a string (half of an emoji cut by `slice`) is stored as U+FFFD. `\u0000` cannot be stored at all and is `BadRequest`.
- **Where results can differ from the in-memory reference adapter** (found by comparing the two side by side; none matters for the runtime's queries):
  - Vector scores are computed in float32, so they agree to about 1e-7, and vectors that differ by less than that tie. A query vector with a value outside the float32 range is `BadRequest`.
  - Strings order by UTF-8 bytes, the reference by UTF-16 code units. The two disagree only between characters above U+FFFF (emoji) and U+E000–U+FFFF (private use, full-width forms).
  - Case-insensitive `contains` uses the database's case mapping. With a UTF-8 locale (`en_US.UTF-8`, `C.UTF-8`, the usual defaults) only special cases differ from JavaScript's `toLowerCase` (Turkish dotted İ, Greek final sigma). Under the plain `C` locale, only ASCII letters fold.
- **Indexes:** the primary key; a partial index on `expires_at` for collections with TTL; and a btree on each field in the spec's `indexes`, which equality filters on that field can use.
- **Index names** carry a hash of the collection and the indexed path (`rate-limits_expires_at_1a2b3c4d5e`), because index names share one namespace with every table in the schema.
- **Provisioning is serialized** across processes with an advisory lock, and it checks the catalog before issuing DDL, so starting against a complete schema takes no table locks. DDL waits at most 5 s for a table lock (then the open fails with `Throttled` and the next call retries), so a long transaction cannot stall every starting instance.
- **Schema changes on a live table.** Adding a full-text field (or changing `fullText.language`, which adds a column for the new configuration and leaves the old one) rewrites the table to fill the generated column. Adding a vector policy leaves existing rows unscored until they are rewritten. On large tables, run `schemaSql` as a migration instead of letting an instance do it at startup.
- **Privileges.** Provisioning needs `CREATE` on the database (or the schema), and `CREATE EXTENSION vector` needs a role allowed to create it (a superuser, or `azure_pg_admin` on Azure). With a least-privilege application role, create the extension and run `schemaSql` once as a migration and set `provisionTables: false`. pgvector's type and operators must be on the role's `search_path` (on Supabase they live in the `extensions` schema, which is on it by default).
- **The sweep** runs in every instance, over the collections that instance has opened, deleting up to 10,000 expired rows per collection per interval. Skipped or slow sweeps cost only disk: expired rows are invisible regardless.

## Tests

```sh
npm test --workspace @agentforeach/storage-postgres
```

This runs the compiler, schema and error tests offline. To also run the conformance suite, the Postgres-specific tests, and a randomized comparison of the compiled SQL with the SDK's reference semantics against a real server:

```sh
docker run -d --name agentforeach-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 pgvector/pgvector:pg17
STORAGE_POSTGRES_URL=postgres://postgres:pw@localhost:55432/postgres \
npm test --workspace @agentforeach/storage-postgres
```

Everything runs in a throwaway schema, dropped afterwards. The TTL tests wait about 18 seconds. CI runs the suite against a pgvector service container.
