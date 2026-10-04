# @agentforeach/storage

The storage SDK behind AgentForEach. Every database the runtime can run on (Cosmos DB, Postgres, your own) plugs in as an **adapter** that implements one small document-store contract. If an adapter passes the conformance suite, it can replace any other adapter without the runtime noticing.

This package contains:

- **The contract** (`StorageAdapter`, `Collection`, `CollectionSpec`, `Query`).
- **Filters**, written as a small tree instead of SQL text (`eq`, `and`, `missing`...).
- **`StorageError`**, with portable error codes.
- **`mutate`**, the shared optimistic read-modify-write loop.
- **The adapter registry**, which also loads plugin adapters.
- **`InMemoryStorage`**, a complete reference adapter for tests and local development.
- **The conformance suite**, at `@agentforeach/storage/conformance`.

It has no runtime dependencies.

## What an adapter must provide

The contract is exactly what the runtime relies on. Nothing more is required.

| Requirement | Why the runtime needs it |
|---|---|
| JSON documents keyed by `(partition key, id)`, one string partition-key field per collection | All collections |
| `create` fails with `Conflict` if the id exists | Idempotent writes and claims: session creation, webhook dedupe, memory dedupe, counter creation |
| `read`, `upsert`, `replace`, `delete`. `delete` reports whether it deleted, and of two concurrent deletes only one returns true | Point access; pairing codes are consumed exactly once |
| Conditional `replace`/`delete`/`patch` on the document's `_etag`, failing with `PreconditionFailed` | Session appends and run leases, cron claims, HITL answers. See `mutate` |
| Atomic `patch` with `set`, `remove`, and a server-side `incr` that never loses an update. At most 10 operations, and paths may only name object members | Rate-limit counters, access counts |
| TTL: a collection `defaultTtl` (unset = off, -1 = opt-in) plus a per-document `ttl`. The clock restarts on every write, and expired documents vanish immediately from every operation | Idle sessions, pending HITL requests, lockouts, caches |
| Filters with Cosmos semantics: three-valued logic, type-strict comparisons, absent ≠ null, ordinal string order. Filter values must be plain, finite JSON | Cron scheduling, session lists |
| Queries within one partition or across partitions: one sort field, a limit, projection with aliases, and count. Documents that lack the sort field come first ascending and last descending. `count` may briefly include expired documents that the database hasn't purged yet | All list and lookup paths |
| Vector search (cosine, top-k, filtered) returning similarity scores. It may be approximate, and documents without a vector come last with a `null` score | Memories and episodes |
| *Optional:* hybrid search (BM25 + vector, weighted RRF with k = 60 over dense ranks, where tied scores share a rank) | Memory recall. Without it, callers fall back to vector search |

The contract does not require multi-document transactions, joins, change feeds or paging.

The exact rules are in [`src/types.ts`](src/types.ts) and [`src/filter.ts`](src/filter.ts). [`src/semantics.ts`](src/semantics.ts) is the reference implementation: when a compiled query's behaviour is in doubt, it decides.

## Using it

```ts
import { createStorageAdapter, and, eq, missing, mutate } from "@agentforeach/storage";

const storage = await createStorageAdapter("memory"); // or "cosmosdb", "postgres", "@acme/storage-dynamo"
await storage.initialize();

const jobs = await storage.collection<Job>({ name: "cron-jobs", partitionKey: "userId" });

await jobs.create({ id: "j1", userId: "u1", enabled: true });

const due = await jobs.find({
  where: and(eq("enabled", true), missing("state.runningToken")),
  orderBy: { field: "state.nextRunAtMs" },
  limit: 50,
});

const result = await mutate(jobs, "j1", "u1", (job) =>
  job.enabled ? { ...job, enabled: false } : undefined, // undefined = write nothing
);
// result.status: "updated" | "skipped" | "notFound" | "contention"
```

Errors are `StorageError`s. Their `code` is one of `NotFound`, `Conflict`, `PreconditionFailed`, `Throttled`, `BadRequest` or `Unsupported`. Test for them with `isNotFound(err)`, `isConflict(err)` and similar helpers. Each error also carries the Cosmos-style `statusCode` (404, 409, 412...).

## Writing an adapter

1. Implement `StorageAdapter` and `Collection`. Reuse `prepareWrite`, `prepareReplace`, `expiresAtMs` and `checkQuery` from this package so validation matches every other adapter. If you apply patches in the application (under a lock or in a transaction), `patchDocument` does it exactly as the other adapters do. Compile `Filter` trees to your query language. Where you evaluate anything in the application, use `evaluateFilter`, `sortDocuments` and `project`.
2. Declare `capabilities` honestly: `vectorSearch` and `hybridSearch`. If you have vector search but no hybrid ranking, `fuseRanks` (from scores) or `reciprocalRankFusion` (from ranked lists) can fuse rankings in the application. Call `checkPatch` before sending a patch to your database, so every adapter refuses the same patches.
3. Export a plugin, so configuration can name your package directly:

   ```ts
   export const storageAdapter: StorageAdapterPlugin = {
     name: "dynamodb",
     create: (options) => new DynamoStorage(options),
   };
   ```

4. Run the conformance suite against a real instance:

   ```ts
   import { runStorageConformance } from "@agentforeach/storage/conformance";

   runStorageConformance({
     name: "dynamodb",
     createAdapter: () => new DynamoStorage({ table: "conformance" }),
     cleanup: async (adapter, collectionNames) => { /* drop them */ },
   });
   ```

   The suite isolates each test in its own partitions, so a shared database is fine. Its TTL tests wait in real time, about 18 seconds in total. The margins allow for Cosmos's one-second timestamp precision and network latency.

## Tests

```sh
npm test --workspace @agentforeach/storage
```

This runs the conformance suite against `InMemoryStorage` on a fake clock, plus unit tests.
