# @agentforeach/storage-cosmos

The Azure Cosmos DB (NoSQL API) adapter for [`@agentforeach/storage`](../storage). It is the backend AgentForEach has always run on, now behind the shared storage contract.

```ts
import { CosmosStorage } from "@agentforeach/storage-cosmos";

const storage = new CosmosStorage({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,      // or credential: <TokenCredential> for Entra ID / managed identity
  databaseId: "agentforeach",
  provisionContainers: false,       // containers come from the IaC; no control-plane calls on cold start
});
```

The adapter also loads by name: `createStorageAdapter("cosmosdb", options)`.

## How it maps the contract

| Contract | Cosmos DB |
|---|---|
| `_etag`, `ifMatch` | The item's `_etag`, sent as an `IfMatch` access condition. The other system fields (`_rid`, `_self`, `_ts`, `_attachments`) are removed from returned documents |
| TTL (`defaultTtl`, per-document `ttl`) | Native container and item TTL |
| `patch` (`set` / `remove` / `incr`) | Partial document update, at most 10 operations. Patches are validated with `checkPatch` before they are sent |
| `find` / `count` | Parameterized NoSQL; `partitionKey` becomes the SDK's partition-scoped query option |
| `vectorSearch` | `ORDER BY VectorDistance(...)`. The cosine result is already a similarity score |
| `hybridSearch` | `ORDER BY RANK RRF(FullTextScore(...), VectorDistance(...), [weights])`, sent with `forceQueryPlan`, with the partition key also added to the WHERE clause. Without the plan, SDK 4.10 returns partition-scoped `RANK` queries unranked; with it, the SDK fans out across partitions unless the WHERE clause pins one. Both behaviours were verified on a live account |
| Errors 400/404/409/412/429 | `StorageError` `BadRequest` / `NotFound` / `Conflict` / `PreconditionFailed` / `Throttled`. The Cosmos error is kept as `cause` |

### Generated queries

The compiler (`compile.ts`) produces queries in the same shape the stores used to write by hand:

- Flat `AND` chains, with parentheses only where `AND` and `OR` mix.
- `NOT IS_DEFINED(c.x) OR c.x = null` for `missing("x")`.
- `null` written as a literal; every other value passed as a parameter.
- `TOP` written as a literal integer.

`parity.test.ts` holds every query the gateway sent before the move to the SDK, copied verbatim. It checks that the compiler produces the same query from the SDK form, scoped to the same partition. Parameter names, whitespace and quoting are ignored; nothing else is.

The one deliberate difference is hybrid search. The adapter forces the query plan (see the table above), so results are actually ranked. The gateway's memory store sent these queries partition-scoped without the plan, and Cosmos returned them unranked.

### Container definitions

`toContainerDefinition(spec)` turns a `CollectionSpec` into the container definition. It is used both when the adapter provisions containers and by the IaC catalog (`infra/cosmos-containers.json`). From the spec it derives:

- Partition key `/<field>`, Hash v2.
- The TTL.
- An indexing policy that indexes everything except `unindexed` fields, the vector field and `_etag`.
- Vector and full-text policies and their indexes. Up to 505 dimensions the vector index is `flat` (exact); above that it is `diskANN`.

`definition.test.ts` checks that all 20 containers deployed today are reproduced exactly.

Cosmos-only settings go in `spec.adapterOptions.cosmosdb`:

| Option | Effect |
|---|---|
| `indexingPolicy` | Use this policy instead of the derived one. `null` sends none, so the account default applies |
| `vectorIndexType` | `flat`, `quantizedFlat` or `diskANN` |
| `verifyPartitionKey` | When containers are only referenced, read the container once and refuse to start if its partition key differs from the spec's |

## Tests

```sh
npm test --workspace @agentforeach/storage-cosmos
```

This runs the compiler, parity, definition and adapter tests offline.

To also run the storage conformance suite against a real account:

```sh
STORAGE_COSMOS_ENDPOINT=https://<account>.documents.azure.com:443/ \
STORAGE_COSMOS_KEY=<key> \            # omit to use `az login` (Entra ID)
npm test --workspace @agentforeach/storage-cosmos
```

The full suite (42 tests) passes against a serverless account with vector search enabled; the last runs were on 2026-10-02 (the whole suite, then the hybrid tests again after a stricter dense-rank test was added). It needs vector search, plus full-text search for the hybrid tests. The suite creates six `conformance_*` containers in the database `agentforeach-conformance` (override with `STORAGE_COSMOS_DATABASE`) and deletes them when it finishes.
