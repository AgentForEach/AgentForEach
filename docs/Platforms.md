# Platforms

AgentForEach runs on more than one cloud. The gateway's code is written against six cloud-neutral **ports**. Each cloud is a **platform pack**, a package that implements those ports, plus a folder that deploys it. Every port ships a **conformance suite**, and a pack implements a port when it passes that port's suite. [Where each suite runs](#where-each-suite-runs) says which implementations are checked by which suite, and how.

| Cloud | Pack | Deploy | Status |
|---|---|---|---|
| Azure | [`packages/platform-azure`](../packages/platform-azure) | [`infra/`](../infra) (Pulumi) | The default |
| Cloudflare | [`packages/platform-cloudflare`](../packages/platform-cloudflare) | `deploy/cloudflare/` (Wrangler) | New; see [Cloudflare](Cloudflare.md) |
| AWS | [`packages/platform-aws`](../packages/platform-aws) | [`deploy/aws/`](../deploy/aws) (Pulumi) | Preview; live-validated on a fresh deployment. See [AWS](AWS.md) and the [validation record](AWS-Validation.md) |
| Google Cloud | Not yet | | Follow [Adding a cloud](#adding-a-cloud) |

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
| Host | The Cloudflare Worker host, in Node and on workerd; the Azure registration in Node (two checks are the Functions host's own work and skip there); the Lambda host in Node | |
| Durable | The in-memory implementation; the Cloudflare engine on simulated Durable Objects and on workerd; Lambda durable functions on the durable execution SDK's local test runner | Azure Durable Functions has no automated run: its orchestrations are unit-tested, and the flows were run end to end on a local Functions host. Lambda durable functions: the deployed `conformance` function ([AWS](AWS.md#check-a-deployment)) |
| Database | In-memory; PostgreSQL with pgvector | Cosmos DB (the live suite needs an account); RDS PostgreSQL |
| Object store | In-memory; `s3` against MinIO; `azure-blob` against Azurite | R2 and Amazon S3 (the `s3` live suite pointed at a bucket) |
| Realtime | In-memory; the Cloudflare Durable Objects on workerd; the AppSync Events provider against a local stand-in | Azure Web PubSub: `WEBPUBSUB_CONNECTION_STRING=... npm test --workspace @agentforeach/platform-azure` runs the suite against the service, on a hub of its own. AppSync Events: `scripts/test-aws-application-live.mjs` on a deployed stack |
| Sandbox | The sandbox server, run locally (egress checks skip: there is no proxy) | ACA Sandboxes, Dynamic Sessions, Cloudflare Containers and AgentCore Runtime, with the live runner |

## How the packs implement them

| Port | Azure | Cloudflare | AWS |
|---|---|---|---|
| Host | Azure Functions: each route and schedule registered with `app.http` / `app.timer` | One Worker: `fetch` routes the table, `scheduled` runs the schedules as Cron Triggers | Lambda: one package with a handler per entry. API Gateway (HTTP API, payload v2) calls `http`; EventBridge Scheduler calls `schedule` every minute. Lambda freezes after a response, so the host awaits background work before returning |
| Durable | Durable Functions: one generic orchestration per primitive (`DurableJob`, `DurableWait`, `DurableAlarm`) | A Durable Object per instance, driven by its alarm; input in the object's storage | One Lambda durable function for every primitive, started on its published version, with an instance table in the database and a sweep on the minute schedule |
| Database | Cosmos DB, or PostgreSQL | PostgreSQL through Hyperdrive, with a pool per invocation | PostgreSQL in your VPC (RDS, or any with pgvector); the schema applied by a `migrate` function per release |
| Object store | Azure Blob Storage | R2, through the S3-compatible provider | Amazon S3, through the same provider with the function role's credentials |
| Realtime | Azure Web PubSub | A Durable Object per user (and one per relay group), with hibernating WebSockets | AppSync Events: a Lambda authorizer for clients, IAM-only publishing, client messages over HTTP |
| Sandbox | ACA Sandboxes, or Dynamic Sessions | Cloudflare Containers: a Durable Object per sandbox, snapshots across sleeps, egress through an outbound Worker | Bedrock AgentCore Runtime: a session per sandbox, IAM-only, in the VPC without internet; optional S3 checkpoints of `/mnt/data` |

Azure and Cloudflare speak [realtime protocol v1](Realtime-Protocol.md) over WebSockets; AWS speaks AppSync Events. `/api/token` and `/negotiate` return a connection descriptor keyed on its `protocol`, and one portable client connects to any of them, so the web chat example and the browser's live view work unchanged on every cloud.

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

How AWS was mapped, and a mapping for Google Cloud, for whoever starts it:

| Port | AWS (built) | Google Cloud |
|---|---|---|
| Host | Lambda behind an API Gateway HTTP API, and EventBridge Scheduler | Cloud Run or Cloud Functions, and Cloud Scheduler |
| Durable | Lambda durable functions | Workflows with callbacks, and Cloud Tasks |
| Database | PostgreSQL with pgvector on RDS (or any reachable from the VPC) | PostgreSQL on Cloud SQL |
| Object store | S3 (`s3` provider) | Cloud Storage (`s3` provider, interoperability mode) |
| Realtime | AppSync Events | WebSockets on Cloud Run |
| Sandbox | Bedrock AgentCore Runtime ([evaluation](AWS_Evaluation.md)) | See [Google Cloud evaluation](GCP_Evaluation.md) |
