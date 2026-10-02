# Why AgentForEach on Cloudflare will use PostgreSQL, not D1

> **Status (October 2026):** Evaluated on 2 October 2026 against Cloudflare's published limits, with the behaviour measured locally on workerd (Wrangler 4.147.0). AgentForEach runs on Azure with Cosmos DB today. A Cloudflare deployment and PostgreSQL as a second database are in development; this is how we chose the database for Cloudflare.

Cloudflare has its own serverless SQL database, D1, which is SQLite, and a separate vector database, Vectorize. Before choosing a database for the Cloudflare deployment, we checked whether they could stand behind AgentForEach's data layer in place of PostgreSQL. They can't without giving up memory search, so the Cloudflare deployment will use your own PostgreSQL through Hyperdrive, Cloudflare's connection pooler for existing databases.

## Summary

| Vector search | Throughput | Transactions | Portability |
|---|---|---|---|
| **None in D1.** The fastest workaround took **85 ms** for one user's 2,000 memories and moved **29 MB** into the Worker; pgvector did it in **8.7 ms** | **One query at a time** per database, and **10 GB** per database | **No `BEGIN`.** Atomic `batch()` only; patches need retries or single-statement SQL | **Workers only.** PostgreSQL runs on every cloud on our roadmap, with one adapter |

**Why PostgreSQL.**
- **Memory recall stays in the database.** With auto-recall on (the default), every user message runs a hybrid search: full-text plus vector, fused by rank. pgvector and `tsvector` do both in one SQL statement, next to the rows.
- **One adapter on every cloud.** PostgreSQL is coming to the Azure deployment as an alternative to Cosmos DB, and it runs on AWS and Google Cloud too. Cloudflare reuses the same adapter, held to the same conformance tests.
- **The data isn't tied to the host.** The Worker can move to another platform and keep the same database.

**Why not D1.**
- **No vector search.** SQLite extensions such as `sqlite-vec` are refused. Every workaround either moves the user's vectors into the Worker on each message, or reads millions of rows per search.
- **Vectorize doesn't fill the gap.** It is a second store with no transaction shared with D1, its writes become searchable only after an asynchronous index rebuild, and it caps vectors at 1,536 dimensions, so `text-embedding-3-large` (3,072) won't fit.
- **One query at a time per database.** A slow search stalls every other query in that database, and splitting the data across databases doesn't fit how a Worker reaches D1.

## AgentForEach on Cloudflare

The runtime needs six things from a platform: a host, durable orchestration, real-time delivery, sandboxes, object storage and a database. On Cloudflare, each maps to one product. Only the database comes from outside Cloudflare, through Hyperdrive.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/cloudflare-database-map-dark.svg">
  <img alt="AgentForEach on Cloudflare, one product per port. Host: Workers with Cron Triggers. Durable: Durable Objects, one per run. Realtime: Durable Objects. Sandbox: Containers. Objects: R2 through the S3 API. Database, highlighted: Hyperdrive in front of your own PostgreSQL with pgvector. Considered for the database and not used: D1 (no vector search, one query at a time), Vectorize (a second store whose writes show up later), Durable Object SQLite (no vector search, per-object data) and Workers KV (key-value only)." src="assets/cloudflare-database-map-light.svg">
</picture>

SQLite does run inside the Cloudflare deployment: each durable run is a Durable Object that keeps its own state in SQLite. That data is private to one object. The shared document store has different needs.

## What the database has to do

Every store in the runtime (sessions, messages, memories, scheduler, identity, rate limits and more) keeps its data in Cosmos DB today, across 20 containers. A database that replaces it has to behave the same way and provide:

- **JSON documents** keyed by partition key and id, up to 2 MB each.
- **Conflict-checked writes:** `create` fails if the id exists, and `ifMatch` rejects a stale `_etag`.
- **Atomic patches** of up to 10 operations, including an increment that never loses an update.
- **TTL:** expired documents are hidden at once.
- **Queries** within one partition or across all of them: filtered, ordered on one field, limited, projected and counted.
- **Vector search and hybrid search** (BM25 plus vector, fused with weighted reciprocal rank fusion) on `memories` and `episodes`. Embeddings are 1,536 dimensions by default and 3,072 with `text-embedding-3-large`.

## D1 against those needs

| Need | D1 | |
|---|---|---|
| Documents, ids, 2 MB rows | JSON text in a table, with a 2 MB row limit | ✅ |
| `create` conflicts, `ifMatch` | A primary key, and `UPDATE … WHERE etag = ? RETURNING` in one statement (measured) | ✅ |
| TTL | An expiry column hidden at read time and a scheduled sweep, as our PostgreSQL adapter does | ✅ |
| Queries and counts | JSON functions. `json_extract` returns SQL `NULL` both for a missing field and for JSON `null`, and booleans come back as integers 1 and 0 (measured), so the required sort order needs a computed sort key built from `json_type` | ◐ |
| Atomic patches | No `BEGIN` or `SAVEPOINT` (measured). Increments work as one `json_set` statement; general patches need read, patch, then write-if-unchanged with retries | ◐ |
| Full-text ranking | FTS5 with `bm25()`, kept in sync by triggers (measured). This is closer to Cosmos DB's BM25 than PostgreSQL's `ts_rank_cd` | ✅ |
| Vector search | No vector type or index. `vec0` virtual tables and `load_extension` are refused (measured) | ❌ |
| Hybrid search | Full-text in D1, vectors somewhere else, fused in the Worker | ❌ |
| Size and throughput | 10 GB per database, one query at a time | ❌ at our scale |

Everything except vector search could be built. The gap is in the one feature that runs on every message.

## Vector search

D1 has no vector type, so we tried every way we could find to compute exact cosine similarity, over one user's memories, as the runtime does.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/d1-vector-search-dark.svg">
  <img alt="Milliseconds for one user vector search over 2,000 memories of 1,536 dimensions, exact cosine, log scale. PostgreSQL with pgvector in the database: 8.7 ms. D1 with rows sent to the Worker and scored in JavaScript: 85 ms, 2,000 rows read and 29 MB moved. D1 SQL with the query vector in a keyed table: 239 ms, 6.1 million rows read and 3,072 rows written. D1 SQL with jsonb_extract per element: 5.6 s, 3.1 million rows read. D1 SQL with a json_each join: 110 s, about 4.7 billion rows read, past the 30 second D1 query limit." src="assets/d1-vector-search-light.svg">
</picture>

| Approach | 100 memories | 500 | 2,000 | Rows read at 2,000 |
|---|---:|---:|---:|---:|
| PostgreSQL + pgvector, exact, in the database | | | **8.7 ms** | (not billed by row) |
| D1: send the rows to the Worker, score in JavaScript | 4 ms | 22 ms | **85 ms** | 2,000, and 29 MB of JSON moved |
| D1 SQL: query vector written to a keyed table, then joined | 12 ms | 61 ms | **239 ms** | 6.1 million, plus 3,072 rows written |
| D1 SQL: `jsonb_extract` into the query vector per element | 270 ms | 1.4 s | **5.6 s** | 3.1 million |
| D1 SQL: `json_each` join on the element index | 5.5 s | 27 s | **110 s** | about 4.7 billion |

**What this means:**
- **The only fast option leaves the database.** Sending rows to the Worker costs 2,000 rows read, but moves every vector on every message: 14.4 KB of JSON per memory, 29 MB at 2,000 memories. A Worker has 128 MB of memory, so this stops at a few thousand memories per user (about three times more if vectors are stored as float32 blobs).
- **SQL inside D1 is billed per row it touches.** The best SQL form reads about 3,072 rows per memory. A user with 2,000 memories costs 6.1 million rows read per message. The Workers Paid plan's 25 billion included rows cover about 4,000 such messages a month; after that, each costs about $0.006 in reads.
- **Slow searches block everything else.** D1 runs one query at a time per database, so a 239 ms search holds up every other user's reads and writes in that database.
- **The obvious query fails outright.** The `json_each` join reads every element of the query vector for every element of every memory. At 500 memories it is already close to the 30 s query limit.

**Vectorize, Cloudflare's vector database, as the vector half:**
- **Two stores, no transaction.** A memory written to D1 and its vector written to Vectorize can disagree after a failure, and erasure has to reach both.
- **Writes show up later.** An insert becomes searchable only after an asynchronous job rebuilds the index files, so a memory saved in one message may be missing from the next one's recall.
- **Limits that don't fit our queries.**
  - 1,536 dimensions at most, which rules out `text-embedding-3-large`.
  - At most 50 results when values or metadata are returned.
  - Metadata filters on at most 10 indexed fields, 64 bytes each, where our queries can filter on any field.
  - Splitting users into namespaces caps an index at 50,000 users.
- **The fusion moves to the Worker.** Full-text ranking from D1 and vector ranking from Vectorize would be fused in JavaScript. PostgreSQL does it in one statement.

## One query at a time

Cloudflare documents that each D1 database processes queries one after another: about 1,000 per second for 1 ms queries, and about 10 per second for 100 ms queries. A chat turn touches sessions, messages, rate limits, usage records and memory recall, so one database serves tens to low hundreds of turns per second at best. Each database is also capped at 10 GB.

The usual answer is many small databases, but that fits AgentForEach poorly:
- **Databases are bound ahead of time.** A Worker reaches a D1 database through a binding in its configuration, so one database per user means one binding per user.
- **Some queries cross every user.** The scheduler finds every enabled job, and the identity and rate-limit indexes are looked up by channel or key, not by user. Those would need a global database, which brings the bottleneck back.

## Transactions and patches

D1 refuses SQL transactions. Locally, `BEGIN TRANSACTION` and `SAVEPOINT` fail with:

```
D1_ERROR: To execute a transaction, please use the state.storage.transaction() or
state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.
```

Our PostgreSQL adapter patches a document by locking the row, applying the operations and writing it back, all in one transaction. On D1 the equivalent is optimistic: read, patch in the Worker, and write only if `_etag` is unchanged, retrying on a clash.

| 50 concurrent increments of one field | Final value | Retries | Time |
|---|---:|---:|---:|
| Read, patch, write-if-unchanged, retry | 50 (correct) | 1,225 | 2,469 ms |
| One `json_set` statement each | 50 (correct) | 0 | 13 ms |

Both are correct, so patches aren't the blocker. On contended documents (rate limits, counters) the retry loop costs a round trip per retry, so a D1 adapter would compile increments to single statements and keep retries for the other operations. `batch()` is atomic: when the second statement of a batch failed, the first was rolled back (measured).

## Reach

D1 is built for Workers: a Worker reaches it through a binding, and anything else goes through Cloudflare's account REST API, which has account-wide rate limits. Deployments on Azure, AWS or Google Cloud couldn't use a D1 database, so a D1 adapter would be Cloudflare-only, with its own conformance gaps. PostgreSQL is one adapter for every platform.

## Durable Object SQLite

Durable Objects run the same SQLite, with two advantages over D1:
- **Real transactions:** `transactionSync()` rolled back a failed update (measured).
- **Unlimited objects** of 10 GB each, so one object per user scales without configuration.

It is still not a fit:
- **No vector search:** `vec0` is refused here too (measured).
- **Cross-user queries become a fan-out:** the scheduler and the identity indexes would need a separate global index.

## What D1 does better

- **No idle cost.** D1 bills rows read, rows written and storage, with nothing for idle time. PostgreSQL needs a running server unless your provider scales to zero (Neon, for example).
- **No server to run.** There's no connection string and no extension to install.
- **Full-text ranking.** FTS5's `bm25()` is closer to Cosmos DB's ranking than PostgreSQL's `ts_rank_cd`.

Hyperdrive has a cost of its own: queries travel from the Worker's location to your database's region. Hyperdrive pools the connections. Its query cache stays off, because a cached read could return rows after an account erasure.

## When we would look again

- D1 or Durable Object SQLite gains a vector index (`sqlite-vec` or a native one) usable in the same statement as FTS5.
- Vectorize offers read-your-writes and filters on arbitrary fields.
- D1 lets a Worker reach databases created at runtime without a binding for each, so a database per user becomes practical.

## How we tested, and what we did not

**Setup:**
- **D1:** local `wrangler dev` (Wrangler 4.147.0, compatibility date 2026-09-01, `nodejs_compat`), which runs D1 on workerd's SQLite. One test Worker probed each SQL feature, then timed the searches.
- **PostgreSQL:** 17.11 with pgvector 0.8.7 in Docker, using a `vector(1536)` column and `<=>` (cosine distance) without an index, as the adapter does.
- **Data:** random 1,536-dimension vectors, stored in D1 as JSON text (14.4 KB each), all in one partition.
- **Machine:** one Apple silicon laptop, on 2 October 2026.

**Limits of this report:**
- **Local, not remote, D1.** Remote D1 adds a network round trip per query and enforces the 30 s limit; locally the `json_each` query ran for 110 s.
- **Serial execution wasn't observable locally.** A point read issued during a long search returned in 1 ms, so the one-query-at-a-time limit is Cloudflare's documented behaviour, not our measurement.
- **Small samples.** Three runs each for the `json_each`, JavaScript and pgvector timings, and one run each for the keyed-table and `jsonb_extract` forms. Treat them as orders of magnitude.
- **One counter wrapped.** For the `json_each` join at 2,000 memories, D1 reported 426,703,777 rows read. That is the true count (about 4.72 billion) modulo 2³². At 100 memories it reported 236,086,473, which matches 100 × 1,536 × 1,536 plus the base rows.
- **Prices** come from Cloudflare's published D1 pricing, not from a bill.
- **Not tested:** remote D1, read replicas and the Sessions API, Vectorize itself, and hybrid fusion across D1 and Vectorize.

**Probe results** (local D1 unless noted):

| Probe | Result |
|---|---|
| `BEGIN TRANSACTION`, `SAVEPOINT` | Refused (the error above) |
| `CREATE VIRTUAL TABLE … USING vec0(…)` | `not authorized: SQLITE_AUTH` |
| `load_extension(…)` | `not authorized` |
| `sqlite_version()` | `not authorized to use function` |
| `INSERT … RETURNING`, `UPDATE … WHERE etag = ? RETURNING` | Work; a stale etag updates 0 rows |
| Duplicate `(pk, id)` | `UNIQUE constraint failed … SQLITE_CONSTRAINT_PRIMARYKEY` |
| `json_extract` of a JSON `null` and of a missing field | Both SQL `NULL`; `json_type` tells them apart (`'null'` vs `NULL`) |
| `json_extract` of `true` | Integer `1` |
| `jsonb()`, `unixepoch('subsec')` | Work |
| `batch()` with a failing second statement | First statement rolled back |
| 100 and 101 bound parameters | 100 works; 101 fails with `too many SQL variables` |
| FTS5 contentless table, porter tokenizer, insert trigger, `bm25()` | Works |
| Durable Object SQLite: `BEGIN`, `vec0`, `transactionSync()` rollback | Refused, refused, rolled back |

## Sources

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 SQL statements and extensions](https://developers.cloudflare.com/d1/sql-api/sql-statements/), [D1 Worker API: `batch()` and sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/), [Vectorize: inserting vectors](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)
- Requests for `sqlite-vec` in [D1 and Durable Objects](https://community.cloudflare.com/t/please-add-support-for-sqlite-vec-for-durable-objects-sql-storage-and-d1/786935) and [cloudflare/agents #1472](https://github.com/cloudflare/agents/issues/1472)
