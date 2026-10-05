# DynamoDB evaluation for the shared storage SDK

> **Status (October 2026):** Source and documentation evaluation on 2 October 2026; recommendation recorded on 3 October. All three storage packages compiled, and 158 offline tests passed; the two live-database suites were skipped. No DynamoDB adapter was built or benchmarked. This is a database selection assessment, separate from the [AWS sandbox evaluation](AWS_Evaluation.md). Existing database configuration is in [Database.md](Database.md).

**We recommend PostgreSQL with pgvector for an AWS deployment that needs to preserve the current storage SDK.** DynamoDB is a viable candidate for a new adapter, but matching the complete contract would require query planning, logical expiry, patch translation and search fallbacks. Those costs need justification by a measured workload or a specific operational requirement.

This is a recommendation about compatibility and implementation effort. We have not established that PostgreSQL is faster or cheaper for the production workload, and we have not selected Aurora, RDS, an instance size or a hosting plan. Azure's default remains Cosmos DB. The related [D1 evaluation](D1_Evaluation.md) assesses the same shared storage requirements for Cloudflare.

## Summary

| Core document operations | Queries | Search | Decision |
|---|---|---|---|
| Good DynamoDB fit, with adapter logic for versions, errors, expiry and patches | The SDK permits arbitrary filters and ordering; efficient DynamoDB queries need deliberately chosen keys and indexes | Native vector search exists, but its filter and result semantics are narrower; hybrid ranking needs additional implementation | Reuse PostgreSQL for the current contract. Reconsider DynamoDB for explicitly designed access patterns |

**Why PostgreSQL fits this code.**

- The adapter already implements documents, conditional writes, atomic patches, expiry filtering and the SDK's query language.
- JSONB queries can combine filters, ordering, projection and counts without defining a separate access path for every query shape.
- Vector and text ranking execute in the same database statement, beside the documents.
- The same adapter can run on different clouds. Selecting an AWS host does not require changing the storage API.

**Why we would not force every operation onto DynamoDB.**

- A correct implementation can still be expensive if a small result requires reading and sorting a large partition or scanning a collection.
- Search needs more than nearest-neighbour retrieval: the contract includes filtering before ranking, cross-partition requests, projections and vectorless documents.
- Native TTL cleanup does not enforce immediate expiry visibility.
- Document and expression limits introduce restrictions the SDK does not currently impose.

These are engineering tradeoffs, not proof that a DynamoDB implementation is impossible.

## What the storage SDK requires

The [contract](../packages/storage/src/types.ts), [filter definitions](../packages/storage/src/filter.ts) and [reference semantics](../packages/storage/src/semantics.ts) define the observable behaviour. The runtime currently declares 20 collections for sessions, messages, memories, episodes, scheduling, identity, rate limits and other state.

- Documents are keyed by a string partition value and an id. Writes ignore incoming system fields; returned whole documents carry the current `_etag`.
- `create` conflicts on an existing live document. Conditional replace, patch and delete reject stale versions. Of two concurrent deletes, exactly one returns true.
- A patch applies up to ten `set`, `remove` and `incr` operations in order and atomically, including repeated operations on one field.
- TTL can be off, opt-in, or a collection default with document overrides. Every write restarts it. Expired documents behave as absent, except that `count` may temporarily include them.
- Filters preserve absent versus null, strict types and three-valued logic. A comparison on an absent field is unknown; negating it does not make it true.
- Queries may span partitions, order on one field, limit after ordering, project with aliases and count matches. Absent sort fields are retained.
- Vector search returns cosine similarity, best first; documents without usable vectors come last with a null score. Approximate nearest neighbours are permitted.
- Hybrid search combines text and vector rankings with weighted reciprocal rank fusion (RRF), using dense ranks and a constant of 60. Hybrid support is optional; the memory store falls back to vector search.

The public API does **not** require joins, multi-document transactions, change feeds or pagination. Their absence from an adapter is not a compatibility gap. A paginated backend must still retrieve enough pages to fulfil a single SDK request.

## Each operation against the adapters

The existing implementations are [Cosmos](../packages/storage-cosmos/src/adapter.ts) and [PostgreSQL](../packages/storage-postgres/src/adapter.ts). The DynamoDB column describes proposed mappings and remaining work; none has been implemented in this evaluation.

| SDK operation or requirement | Cosmos adapter | PostgreSQL adapter | DynamoDB assessment |
|---|---|---|---|
| `initialize`, `collection`, repeated opens | Create or reference containers; cached handles | Create or reference tables; cached handles | Feasible; map collection names and await table/index readiness |
| JSON identity `(partition, id)` | Native item identity | Composite primary key | Natural partition/sort-key mapping; encode edge cases such as empty partition values |
| `create` | Native create and conflict response | Insert; replace a conflicting row only if expired | Conditional put; allow reuse of logically expired keys |
| `read` | Point read, null if missing | Primary-key lookup with expiry predicate | Point get plus expiry check; select read consistency deliberately |
| `upsert` | Native upsert | Insert on conflict update | Put item, generating a version and resetting expiry |
| `replace` | Existing-item replace | Conditional update | Conditional put requiring a live existing item and, if supplied, matching version |
| `_etag`, `ifMatch` | Native ETag | UUID stored outside JSONB | Adapter-managed version attribute and conditional writes |
| `patch.set` | Native partial update | Shared evaluator under a row lock | Native building blocks; preserve ordered patch semantics |
| `patch.remove` | Fails for an absent target | Evaluator checks existence | Native remove ignores absent attributes; needs additional checks |
| `patch.incr` | Native atomic increment | Row lock prevents lost updates | Atomic arithmetic fits; preserve type checks and missing-field initialisation |
| Ordered patch and rollback | Native sequence | Transaction around the whole sequence | Compile safely or use conditional read-modify-write; direct expression substitution is insufficient |
| `delete` with boolean result | True on deletion, false on missing | Affected-row count | Inspect returned old item or conditional failure; enforce expiry and version checks |
| `mutate` | Shared optimistic retry helper | Same helper | Reusable after read/replace/error behaviour matches |
| TTL defaults and overrides | Native container/item TTL | Expiry column derived from policy | Calculate a separate absolute expiry; preserve the document's relative `ttl` |
| Immediate expiry visibility | Native visibility behaviour | Expiry predicates; later physical sweep | Adapter-enforced visibility and write conditions; native TTL for later cleanup |
| `eq`, `ne`, ranges, `oneOf` | Parameterised NoSQL | Parameterised JSONB SQL | Compile exact semantics or evaluate in the application |
| `and`, `or`, `not`, absent/null | Cosmos semantics | SQL unknown plus JSONB null | Explicit semantic translation, especially under negation |
| `contains`, case insensitive | `CONTAINS` and `LOWER` | `strpos` and `lower` | Case-sensitive primitive exists; case folding needs implementation |
| Partition-scoped `find` | Scoped query | Partition predicate | Query is a good fit |
| Cross-partition `find` | Cross-partition query | SQL across the table | Appropriate secondary index, fan-out or scan |
| Arbitrary `orderBy` | Database ordering | Computed type/value order | Index sort key or application sorting; preserve absent/null/mixed-type order |
| `limit` after filtering/ordering | Query limit | SQL limit | Read enough pages before applying the final limit |
| Projection and aliases | SQL projection | SQL and result shaping | Projection plus adapter reshaping |
| Filtered `count` | Database count | SQL count | Paginated query/scan count or maintained counters for specific patterns |
| `vectorSearch` | VectorDistance, flat or diskANN | Exact pgvector cosine search | Native ANN plus compatibility handling; see below |
| `hybridSearch` | FullTextScore and RRF | Text rank and dense-rank RRF | Application ranking or declared unsupported capability |
| Portable errors | HTTP/status mapping | SQLSTATE mapping | Classify conditional failures by operation; map validation and throttling |
| Registry and `close` | Plugin and owned-client disposal | Plugin and owned-pool cleanup | Fits the plugin interface; add a provider implementation and resource cleanup |

The write mappings use documented [PutItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutItem.html), [DeleteItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_DeleteItem.html) and [update-expression](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html) primitives. The table describes feasibility, not completed conformance.

## Writes and expiry

### Ordered patches need translation

The conformance suite applies ten increments to the same field in one patch. Other valid sequences can create a parent object and then update its child. A failure anywhere must leave the document unchanged.

DynamoDB update-expression actions use the pre-update values; they are not the SDK's sequential operation list. Removing an absent attribute is also a no-op. An adapter could optimise independent increments and assignments, and use the shared `patchDocument` evaluator with a version-checked replacement for more complex patches. It must retry safely under contention and never return success after losing an update. [AWS update semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html)

PostgreSQL already does compatibility work too: it locks the row, evaluates the patch in application code and writes it in a transaction. Additional code alone is not a reason to reject DynamoDB; the number of round trips and behaviour under contention need measurement.

### Logical expiry must precede physical deletion

DynamoDB TTL removes expired items asynchronously. Pending deletion, they can still be read and updated. The adapter must check its calculated expiry on reads, filter query/search results, reject replace/patch on expired documents, report expired deletes as false and allow create to reuse the key. Every successful write must refresh expiry according to the collection policy. [AWS expired-item behaviour](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ttl-expired-items.html)

Application-generated timestamps also require a defined clock-skew policy. This differs from the existing adapters' database-generated write times. TTL cleanup by itself cannot provide the SDK's visibility guarantee.

### Consistency is part of the implementation

Use conditional writes for claims and mutations. Base-table reads can request strong consistency; global secondary indexes remain eventually consistent. An adapter that routes a formerly immediate lookup through an index must account for visibility lag, and should revalidate candidate state before a claim. [AWS read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)

## Queries and access patterns

The existing SDK accepts an arbitrary filter tree and one ordering field. Its `indexes` setting is only a list of field paths; it does not describe DynamoDB partition/sort-key combinations, projections or which query should use which index.

DynamoDB Query requires a partition value, orders by the sort key and filters after reading. Its limit bounds evaluated items, not the final SDK result count; a response may contain no matches and still require another page. Filtering does not reduce the read capacity consumed. A compatibility layer must preserve those distinctions. [AWS Query API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)

| Current workload | Required behaviour | Work a DynamoDB adapter would need |
|---|---|---|
| Cron due index and heartbeat events | Shard scope, due-time ranges, missing/dead-letter and claim-state filters, earliest first | Time-based access paths, candidate pagination and conditional claims |
| Session messages | Partition scope, sequence ranges and ordering, run/idempotency filters | Sequence access path plus filters or additional indexes |
| Sessions, usage and digests | User scope, timestamp order and optional filters | User/time indexes; digest substring matching may still need application work |
| Identity and some cron lookups | Some requests omit explicit partition scope | Infer a safe key restriction from the filter or use another access path |
| Counts | Count every matching document | Consume all matching pages, or maintain counters with appropriate semantics |

Source examples: [cron store](../gateway/cron/store.ts), [message store](../gateway/sessions/messages-store.ts), [memory store](../gateway/memory/providers/storage.ts).

**Our assessment:** reading a whole small partition and using the SDK's reference evaluator can be correct. Without an enforced size bound, it is a risky default. A request for ten jobs can otherwise read thousands of documents, transfer them to the application and sort them. No latency or cost for that approach was measured here.

## Vector and hybrid search

DynamoDB gained native vector search on 5 August 2026. Its absence is not a reason to reject DynamoDB. [AWS announcement](https://aws.amazon.com/about-aws/whats-new/2026/08/amazon-dynamodb-vector-search/)

| SDK requirement | Native DynamoDB behaviour | Compatibility work |
|---|---|---|
| Cosine similarity, higher is better | Cosine distance, lower is better | Return `1 - distance` |
| Current 1,536/3,072-dimensional embeddings | Up to 4,096 dimensions | Current models fit |
| Non-negative result limit | Native TopK is 1 to 100 | Return immediately for zero; fallback or a contract limit above 100 |
| General filters before ranking | Equality on configured top-level search attributes | Translate supported cases; use a correct fallback for other predicates |
| Optional partition scope | Partitioned indexes require that partition value | Separate strategy for cross-partition requests |
| Whole documents or projections | Only projected index attributes are returned | Choose projection or fetch base documents and reshape |
| Vectorless documents last, null score | Only valid-vector items enter the index | Supplemental retrieval |
| Recent writes visible to search | Asynchronous index updates | Define visibility expectations and test read-after-write cases |
| Complete requested results | 16 MB response cap, no pagination | Bound payloads and handle unsupported requests explicitly |

Sources: [SearchVectors](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_SearchVectors.html), [vector index behaviour](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/VectorSearch.html), [synchronisation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/VectorSearchDataSync.html) and [requirements](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/VectorSearch.Requirements.html). Vector indexes require on-demand tables.

The memory store caps its searches at 100, so TopK is not an immediate blocker for that caller. It does use category membership filters, however, and the SDK permits nested fields, ranges and other predicates. Equality searches per category with merged results could handle some bounded cases; this does not implement every valid filter.

**Fetching the nearest 100 and then filtering is not generally equivalent to filtering before ranking.** Eligible documents beyond that candidate set are never considered. Likewise, removing expired candidates can leave too few results. An application-side scan and cosine calculation can fill the semantic gap for a bounded dataset, but its data movement and computation must be measured.

The SDK permits approximate nearest neighbours, so ANN itself is compatible. Approximation does not excuse returning another user's documents, ignoring a predicate or exposing expired data.

### Hybrid ranking remains separate work

DynamoDB does not expose the SDK's BM25 plus weighted dense-rank RRF operation. AWS points to OpenSearch integration for full-text and hybrid search. A separate search service would introduce another component and synchronisation behaviour; it is outside the one-database adapter evaluated here. [AWS hybrid search guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ddb-and-amazon-bedrock.html)

An adapter can declare `hybridSearch: false`; the current memory store then uses vector search. That is a supported capability fallback, with different retrieval behaviour. Alternatively, application BM25 and RRF can be implemented with the SDK's [ranking helpers](../packages/storage/src/ranking.ts), provided candidate retrieval is correct and bounded. Positional fusion alone does not preserve the contract's dense ranks for tied scores.

## Document limits

DynamoDB items are limited to 400 KB including attribute names, nested attributes to 32 levels, and numbers to its supported decimal range. Its key values must be nonempty. The SDK accepts empty partition strings and does not enforce those same document limits. Collection/table naming also needs mapping. [AWS constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)

Before migration, measure stored item sizes, especially message and tool-result payloads. Chunking or externalising a large document changes read, write and atomicity behaviour and is a separate design task. The message store already separates messages from session metadata, but an individual message can still be large.

## The existing adapters are not identical

The recommendation does not assume perfect parity between PostgreSQL and Cosmos DB.

| Area | Cosmos adapter | PostgreSQL adapter |
|---|---|---|
| Vector retrieval | Flat for small dimensions; diskANN for larger ones by default | Exact cosine over eligible rows, without an ANN index |
| Text ranking | BM25 | `ts_rank_cd`, with different relevance behaviour |
| Hybrid fusion | Native RRF query | Dense ranks and weighted RRF in SQL |
| Expiry cleanup | Managed by Cosmos | Background sweep; expiry predicates hide rows independently |
| Unicode and numeric details | Original backend semantics | Documented case-folding, string ordering and float32 differences |
| Operational work | Managed document service | Pool sizing, schema/index management and host selection |

The [PostgreSQL README](../packages/storage-postgres/README.md) documents these differences. Its text ranker differs from the BM25 wording in the shared contract; passing the current suite does not prove identical relevance for every corpus. Both adapters advertise search capabilities by default rather than discovering every account/server feature automatically.

Two PostgreSQL tasks remain before production sizing:

1. **Query indexes.** The generated [schema](../infra/postgres-schema.sql) at the evaluated revision has primary-key and TTL indexes. Scheduling, timestamp sorting and other selective filters need query-plan analysis and suitable indexes at realistic scale.
2. **Search growth.** Exact vector search and hybrid ranking over every candidate become more expensive as a user's collection grows. Measure large partitions before deciding whether to add ANN or change candidate selection, and check filtered-result correctness when doing so.

These are reasons to benchmark and tune PostgreSQL. They do not establish that a new DynamoDB adapter would be cheaper or faster.

## When compatibility code makes sense

| Proposed adapter work | Assessment |
|---|---|
| Version tokens, error mapping, expiry metadata and result shaping | Normal compatibility work |
| Conditional mutations and patch compilation | Reasonable, with concurrency tests |
| Explicit indexes for stable query patterns | Reasonable when access patterns are known |
| Application filtering/sorting over an enforced small partition | Possible bounded fallback; record rows and bytes read |
| Unbounded scans to emulate general queries or memory search | Poor default for this SDK; performance would depend on collection growth |

Choose DynamoDB deliberately if its connectionless operation or a measured key-based workload justifies those changes. Do not describe a scan-heavy adapter as equivalent merely because its small conformance fixtures pass.

For the existing contract, retain PostgreSQL and choose the host separately. Both RDS and Aurora offer pgvector, but that does not select between them or establish a cost advantage. [RDS extensions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html), [Aurora pgvector support](https://docs.aws.amazon.com/rds/latest/auroraextendedcontent/aurora-faq-agentic-ai.html).

## When we would look again

- There is a concrete operational or cost target that the existing PostgreSQL deployment cannot meet.
- Required DynamoDB access patterns are explicitly indexed and fallback work is bounded.
- Document limits and search visibility expectations are accepted and enforced.
- Hybrid fallback is acceptable, or an implementation preserves the required ranking behaviour.
- Conformance and realistic-volume benchmarks demonstrate a useful advantage.

The adoption checks should include cron candidate selection and next-wake queries, message history, filtered memory retrieval, TTL reuse and expiry visibility, concurrent claims/increments, and account erasure. Measure p50/p95/p99 latency, rows and bytes read, consumed capacity, retries and correctness under concurrent writes. Test both normal and large partitions, both embedding sizes, empty-result pages and limits beyond one backend page. These are proposed checks, not completed results.

## How we evaluated and what we did not

**Source snapshot:** the repository as of 2 October 2026 (the commit "Browser: frames, shadow DOM, and human checks the user decides about"), with no changes to the evaluated storage code. We read the shared contract and helpers, both adapters and compilers, provisioning/schema code, conformance suite and runtime call sites. Provider claims were checked against the AWS documentation linked beside them on 2 October 2026.

**Offline verification:** the three packages were copied into an isolated temporary directory, compiled with TypeScript using the installed dependencies, and their Node test suites run with live Cosmos/PostgreSQL endpoints unset. The Cosmos catalog fixture was included. The final result was **160 tests: 158 passed, 0 failed, 2 skipped**. This covers the memory reference conformance tests, compiler tests, Cosmos query/catalog parity and offline adapter tests. It does not execute PostgreSQL SQL or Cosmos queries against a server.

The equivalent repository command is:

```sh
env -u STORAGE_COSMOS_ENDPOINT -u STORAGE_POSTGRES_URL npm run test:storage
```

The [conformance suite](../packages/storage/src/conformance/index.ts) skips search tests when an adapter declares those capabilities unavailable. A passing reduced-capability adapter therefore does not prove that memory search works. Live-test instructions are in the [Cosmos](../packages/storage-cosmos/README.md#tests) and [PostgreSQL](../packages/storage-postgres/README.md#tests) READMEs; their previously recorded live results were not rerun for this evaluation.

**Not tested here:** DynamoDB itself, a DynamoDB adapter, live PostgreSQL/Cosmos conformance, cloud round-trip latency, search recall on real data, production concurrency, large-document migration or comparative bills. No cloud resources were created. Timings in the separate D1 evaluation must not be presented as a DynamoDB comparison.

The decision is to reuse PostgreSQL for the present SDK, with indexing and scale validation still required. A future DynamoDB implementation should be judged on both observable correctness and measured work per operation.
