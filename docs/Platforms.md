# Platforms

AgentForEach runs on more than one cloud. The gateway's code is written against six cloud-neutral **ports**. Each cloud is a **platform pack**, a package that implements those ports, plus a folder that deploys it. Every port ships a **conformance suite**, and a pack implements a port when it passes that port's suite. [Where each suite runs](#where-each-suite-runs) says which implementations are checked by which suite, and how.

| Cloud | Pack | Deploy | Status |
|---|---|---|---|
| Azure | [`packages/platform-azure`](../packages/platform-azure) | [`infra/`](../infra) (Pulumi) | The default |
| Cloudflare | [`packages/platform-cloudflare`](../packages/platform-cloudflare) | `deploy/cloudflare/` (Wrangler) | New; see [Cloudflare](Cloudflare.md) |
| AWS, Google Cloud | Not yet | | Follow [Adding a cloud](#adding-a-cloud) |

## The ports

| Port | What the gateway needs from it | Contract | Conformance suite |
|---|---|---|---|
| **Host** | Serve the route and schedule table (`gateway/routes.ts`); one scope per invocation, with work that outlives the response (`background`) and per-invocation resources; what the host is (`HostInfo`) | [`host.ts`](../packages/platform/src/host.ts), [`scope.ts`](../packages/platform/src/scope.ts), [`routing.ts`](../packages/platform/src/routing.ts), [`cors.ts`](../packages/platform/src/cors.ts) | `@agentforeach/platform/host/conformance`, plus the route-table test ([`gateway/runtime/routes.test.ts`](../gateway/runtime/routes.test.ts)) |
| **Durable** | Work that outlives a request: **jobs** (run once per id), **waits** (an event or a timeout) and **alarms** (tick forever). Chat turns, channel turns, HITL forms and the cron scheduler are defined once on these (`gateway/workflows.ts`) | [`durable/types.ts`](../packages/platform/src/durable/types.ts) | `@agentforeach/platform/durable/conformance` |
| **Database** | The document-store contract: point reads and writes with etags, TTL, queries, vector and hybrid search | [`packages/storage`](../packages/storage) | `@agentforeach/storage/conformance` |
| **Object store** | Skill files and sandbox exports: list, read with a size cap, write, delete by prefix, signed download links | [`objects/types.ts`](../packages/platform/src/objects/types.ts) | `@agentforeach/platform/objects/conformance` |
| **Realtime** | Push events to a user's connections; relay the browser's live view; one handler for every client message. The wire format is [realtime protocol v1](Realtime-Protocol.md) | [`realtime/types.ts`](../packages/platform/src/realtime/types.ts) | `@agentforeach/platform/realtime/conformance` |
| **Sandbox** | A sandbox per user: run commands, read and write files, inject credentials at the egress, keep files across sleeps; capabilities say which of these a backend has | [`sandbox/types.ts`](../packages/platform/src/sandbox/types.ts) | `@agentforeach/platform/sandbox/conformance` |

## Where each suite runs

A suite checks an implementation only where it is run against it. Today:

| Suite | Run in CI against | Run by hand against |
|---|---|---|
| Host | The Cloudflare Worker host, in Node and on workerd; the Azure registration in Node (two checks are the Functions host's own work and skip there) | |
| Durable | The in-memory implementation; the Cloudflare engine on simulated Durable Objects and on workerd | Azure Durable Functions has no automated run: its orchestrations are unit-tested, and the flows were run end to end on a local Functions host |
| Database | In-memory; PostgreSQL with pgvector | Cosmos DB (the live suite needs an account) |
| Object store | In-memory; `s3` against MinIO; `azure-blob` against Azurite | R2 (the `s3` live suite pointed at a bucket) |
| Realtime | In-memory; the Cloudflare Durable Objects on workerd | Azure Web PubSub (the live suite needs a service) |
| Sandbox | The sandbox server, run locally (egress checks skip: there is no proxy) | ACA Sandboxes, Dynamic Sessions and Cloudflare Containers, with the live runner |

## How the packs implement them

| Port | Azure | Cloudflare |
|---|---|---|
| Host | Azure Functions: each route and schedule registered with `app.http` / `app.timer` | One Worker: `fetch` routes the table, `scheduled` runs the schedules as Cron Triggers |
| Durable | Durable Functions: one generic orchestration per primitive (`DurableJob`, `DurableWait`, `DurableAlarm`) | A Durable Object per instance, driven by its alarm; input in the object's storage |
| Database | Cosmos DB, or PostgreSQL | PostgreSQL through Hyperdrive, with a pool per invocation |
| Object store | Azure Blob Storage | R2, through the S3-compatible provider |
| Realtime | Azure Web PubSub | A Durable Object per user (and one per relay group), with hibernating WebSockets |
| Sandbox | ACA Sandboxes, or Dynamic Sessions | Cloudflare Containers: a Durable Object per sandbox, snapshots across sleeps, egress through an outbound Worker |

Both packs speak the same realtime protocol, so the web chat example and the browser's live view work unchanged on either.

## How an entry point puts a pack together

An entry point is the only code that knows its cloud. The Azure one is [`gateway/index.ts`](../gateway/index.ts):

1. Load the gateway's modules.
2. Install the cloud's providers: object storage, realtime, sandbox backends.
3. Register the durable kinds (`workflows`) with the pack and install its Durable implementation (`installDurable`).
4. Hand the route and schedule table to the host.

The Cloudflare one, `deploy/cloudflare/worker.ts`, does the same and also exports the Durable Object classes the Worker binds to.

## Adding a cloud

1. **Create `packages/platform-<cloud>`.** Mirror `platform-azure`: one folder per port under `src/`, and subpath exports for anything that needs the cloud's runtime.
2. **Host.** Serve `buildRouteTable()`. Hosts that receive raw requests route them with `matchRoute` and answer CORS preflights with `cors.ts`. Open a scope per invocation with `openScope`, and decide what keeps `background()` work alive. Set `HostInfo`, including `persistent: false` if invocations can't share connections.
3. **Durable.** Implement `Durable` and run the registry's kinds. Pass `runDurableConformance`. Handlers may run more than once; failures must not be retried.
4. **Database.** Use the PostgreSQL adapter (any managed Postgres with pgvector), or write a storage adapter that passes the storage suite.
5. **Object store.** Use the `s3` provider if the cloud has an S3-compatible API, or implement `ObjectStore`.
6. **Realtime.** Implement the provider and speak realtime protocol v1, so clients don't change.
7. **Sandbox.** Register a backend under a provider name, and declare its capabilities honestly. The shared image (`gateway/sandbox-container/Dockerfile`) runs on any container platform.
8. **Entry point and deploy.** Write `deploy/<cloud>/`: the entry point and whatever creates the cloud's resources.
9. **Check.** Run every suite against the pack, and add the bundle check if the runtime isn't Node.

The AWS and Google Cloud mappings, for whoever starts them:

| Port | AWS | Google Cloud |
|---|---|---|
| Host | Lambda (function URLs or API Gateway) and EventBridge Scheduler | Cloud Run or Cloud Functions, and Cloud Scheduler |
| Durable | Lambda durable functions or Step Functions, and EventBridge one-time schedules | Workflows with callbacks, and Cloud Tasks |
| Database | PostgreSQL on RDS or Aurora, with RDS Proxy | PostgreSQL on Cloud SQL |
| Object store | S3 (`s3` provider) | Cloud Storage (`s3` provider, interoperability mode) |
| Realtime | API Gateway WebSocket APIs | WebSockets on Cloud Run |
| Sandbox | See [AWS evaluation](AWS_Evaluation.md) | See [Google Cloud evaluation](GCP_Evaluation.md) |
