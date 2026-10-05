# Architecture

AgentForEach serves many users from one deployment on **Azure, Cloudflare or AWS**. The gateway, agent loop and workflows use six cloud-neutral contracts: host, durable work, database, files, realtime and sandbox. A platform pack supplies the cloud-specific implementations. Model providers are configured separately from the hosting cloud.

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/architecture-platform-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/architecture-platform-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-platform-dark.svg">
  <img alt="Multi-cloud, multi-tenant architecture: authenticated users share the agent runtime, with user-scoped memory, sessions, schedules, files, sandboxes and connections. Six contracts map to a choice of Azure, Cloudflare or AWS. AWS is in preview." src="assets/architecture-platform-light.svg">
</picture>

[Full diagram](assets/architecture-platform-light.svg) · [Service mapping and backend capabilities](Platforms.md)

## Tenant boundaries

The tenant boundary is a canonical `userId`, resolved from app authentication or a paired channel account. Compute and cloud infrastructure are shared. User-specific state is persisted in the selected database and object store, rather than requiring a gateway process for every user.

- Sessions, memories, schedules and run records are accessed with the owner's identity. Session messages are reached through their owning session.
- Sandbox identifiers encode the user, and optionally the session; files use owner-scoped paths. This is logical ownership, not a separate database per user.
- HITL answers are checked against the request's owner. Realtime access and outgoing events are scoped to the user's connections.
- A renewed lease permits one active turn per conversation. Other users and conversations can run independently.

See the [security model](../SECURITY.md), [identity and pairing](Identity.md), [sessions](Session-management.md) and [sandbox contract](../packages/platform/src/sandbox/identifier.ts) for the implementation boundaries.

## Azure reference deployment

The detailed service diagram and Azure-specific operational settings below describe the Azure pack. [Platforms](Platforms.md) maps these roles to Cloudflare and AWS; their deployment guides document differences in durability, networking, realtime and sandbox capabilities.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="Architecture. Requests come in along the top: users on Telegram, WhatsApp or an app reach one Function App, which runs as 1 to 1,000 identical, stateless instances and scales to zero. It accepts a message in about 0.12 seconds, runs the turn as a durable orchestration and hands it to the agent runner; a sharded scheduler (8 to 128 shards) hands it due reminders and heartbeats. The runner reads and writes Cosmos DB, where every user has their own partition, calls model providers, a per-user sandbox and optional AI Search. The reply goes back along the bottom through Web PubSub to every device the user has open." src="assets/architecture-light.svg">
</picture>

## Components

| Component | Azure service | Role |
|---|---|---|
| Handlers, runner, scheduler | Functions, Flex Consumption (Node 22) | HTTP and WebSocket entry points, the agent loop, timers |
| Background work | Durable Functions (Azure Storage backend) | Chat turns, channel turns, approvals, the cron scheduler, as durable jobs, waits and alarms ([Platforms](Platforms.md)) |
| State | Cosmos DB for NoSQL | Sessions, messages, memories, jobs, identities, … (below) |
| Real-time delivery | Web PubSub | Streams replies to every device a user has connected |
| Code execution | Container Apps Sandboxes (Dynamic Sessions as fallback) | One sandbox per user, suspended when idle |
| Knowledge (optional) | AI Search | Hybrid search over reference documents |
| Secrets | Key Vault | Referenced from app settings by version |
| Telemetry | Application Insights, Log Analytics | Sampled logs, alerts |

The Pulumi program in `infra` creates all of it.

## A chat turn

1. **Accept.** `POST /api/chat` (or a WebSocket `chat` message) authenticates the caller, validates the message, counts it against the user's rate limit, and starts a `ChatTurn` durable job whose id (`chat-<hash>`) is derived from the user and the idempotency key. It returns `202 { runId, sessionId }`. A retry with the same key joins the running turn instead of starting a second one.
2. **Run.** The job (on Azure, the `DurableJobRun` activity of a `DurableJob` orchestration) loads the session and takes its **run lease** (below), then builds the turn: history (or the provider's response chain), compaction summary, recalled memories, recent sessions, prompt documents, tools. The runner calls the model, executes tool calls (each isolated, so one failing tool doesn't fail the turn), and loops until the model answers or a limit is reached.
3. **Stream.** Text deltas are coalesced every 400 ms and pushed through the selected realtime provider with their offset; the `final` event carries the whole reply. Azure uses Web PubSub, Cloudflare uses Durable Object sockets, and AWS uses AppSync Events.
4. **Persist.** The user message and reply are appended to the session (etag-guarded), usage is recorded, memories may be captured, and the lease is released.

Channels (Telegram, WhatsApp) take the same path from their webhooks: they acknowledge first, then run the turn as a `ChannelInboundTurn` durable job.

### Run status

A client that missed the live events (a dropped socket, an app sent to the background) asks how its turn went with `GET /api/chat/runs/{runId}`, using the `runId` from the `202`:

```json
{ "runId": "…", "status": "completed", "sessionId": "…", "createdAt": "…", "startedAt": "…", "finishedAt": "…" }
```

`status` is `accepted` (waiting to start), `running`, `completed`, `awaiting_input` (paused for a form, [HITL](HITL.md)), `failed` (with `error`, a code such as `rate_limited` or `queued_too_long`, and `retryable`), `aborted` (stopped), or `interrupted` (cut off by a restart or a deploy; send it again). Each turn writes its record in the `chat-runs` collection, in the user's partition: another user's run id gets `404`. The record keeps a fingerprint of the message, session and attachments, not the text, so an `idempotencyKey` reused for a different message is refused with `409`. A record left `accepted` or `running` after its last write was lost is reported from its durable job instead (failed, stopped, or ended without a status) once a minute has passed since the turn started or was accepted. A turn run in the request (`"wait": true`) writes the same record.

Two guards run before the model is called. A background turn that waited more than 5 minutes to start is refused with a retryable `queued_too_long` error, and a Stop pressed while it waited stops it. The Stop marker lasts 10 minutes, so the marker is still there when the turn starts.

### Real-time protocol

The [portable client](../packages/platform/src/realtime/client/index.ts) uses the negotiated connection descriptor to select its protocol. Azure and Cloudflare use protocol v1; AWS uses AppSync Events, with incoming client messages sent over HTTP.

On Azure, a client calls `GET /negotiate` (authenticated like any API call) and gets a Web PubSub URL with an access token for that user. It then opens a WebSocket to that URL. What the client sends reaches `/ws/message` as a Web PubSub event, verified by its signature:

| Client message | Meaning |
|---|---|
| `{ type: "chat", message, sessionId?, idempotencyKey?, attachments? }` | Start a turn (same as `POST /api/chat`) |
| `{ type: "input_response", requestId, data?, cancelled? }` | Answer a form or approval ([HITL](HITL.md)) |
| `{ type: "abort" }` | Stop the running turn |
| `{ type: "ping" }` | Keep-alive; answered with `pong` |

The server pushes frames `{ type: "event", event: "chat", payload }` to every connection of the user, where `payload.state` is one of `thinking`, `delta` (with `offset`), `reasoning_delta`, `tool_start` / `tool_delta` / `tool_done`, `input_request` / `input_expired`, `final`, `aborted` or `error`, and carries the `runId` and `sessionId`. Handlers live in `gateway/handlers/ws-*.ts`; frame types in `gateway/websocket/types.ts`.

### Failure handling

- **Deadlines.** A turn has a budget (9 minutes in the background, 215 s in an HTTP request); a model stream that stops producing events is aborted after an idle timeout.
- **Run lease.** A session holds at most one running turn: a 60-second lease renewed every 20 s. A second message to a busy session gets `SESSION_BUSY`; a second delivery of the *same* run waits for the first to finish (then replays its reply) or for its lease to lapse (then answers itself).
- **Lost instances.** Flex Consumption can stop an instance mid-turn during scale-in. Durable redelivers the work within about a minute and the lease lapses within one, so the turn completes on another instance.
- **Idempotency.** Replies are stored with the request's idempotency key; a retry after completion replays the stored reply without calling the model.
- **Dropped model streams.** A stream that fails before any output is retried once; after output has started the error reaches the user.
- **History retention.** Finished orchestrations are purged an hour after creation, so messages and attachments don't outlive the message TTL.

## Data model

Every container is defined by the code that uses it and recorded in `infra/cosmos-containers.json`, which Pulumi provisions (see [CONTRIBUTING](../CONTRIBUTING.md)).

| Container | Partition key | TTL | Holds |
|---|---|---|---|
| `sessions` | `/userId` | 24 h, renewed on every message | One doc per conversation: counters, compaction summary, provider chain, run lease |
| `session-messages-v2` | `/pk` = `user:session:instance` | per message (7 days) | Messages, reachable only through the owning session |
| `memories` | `/userId` | None | Long-term memories with vector and full-text indexes |
| `episodes`, `session-digests` | `/userId` | none / per document | Episodic memory, summaries of past sessions |
| `prompt-documents`, `onboarding-state` | `/userId` | None | The agent's documents (SOUL, USER, …) and onboarding |
| `cron-jobs` | `/userId` | None | Scheduled jobs |
| `cron-due-index`, `cron-heartbeat-events` | `/shardId` | 7 days, 2 days | What each scheduler shard runs next |
| `cron-runs` | `/jobId` | 1 day | Run history |
| `identity-links`, `identity-channel-index`, `identity-pairing` | `/userId`, `/id`, `/code` | none, none, 5 min | Channel accounts linked to users |
| `hitl-requests` | `/userId` | 1 h | Paused runs waiting for a form or approval |
| `usage-records` | `/userId` | 90 days | Tokens and cost per run |
| `rate-limits` | `/id` | per document | Per-user message counters |
| `abort-requests` | `/userId` | 10 min | Stop-button markers that reach any instance |
| `chat-runs` | `/userId` | 7 days | Each chat turn's status and request fingerprint (no message text) |
| `user-skills`, `whatsapp-state` | `/userId`, `/scope` | none, per document | Skill settings, WhatsApp delivery state |

Almost everything is partitioned by user, so a turn's reads and writes are point reads or single-partition queries.

## Scheduled work

Jobs are spread over scheduler shards (8 by default), each a durable alarm that sleeps until its next due job and then starts a `CronRun` job for each job that is due. A job's due time lives in `cron-due-index`, partitioned by shard, so a shard finds its next work with a single-partition query. A timer restarts any shard that stopped.

## Scaling

Compute is shared, user data is scoped to its owner, schedules are spread over shards, and the turn lease belongs to one session. The Azure service ceilings and configuration settings below describe that pack; other packs have their own limits in [Cloudflare](Cloudflare.md) and [AWS](AWS.md).

| Layer | What Microsoft publishes | The setting here |
|---|---|---|
| Functions, Flex Consumption | Up to [1,000 instances](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan) per function group; 250 cores per region per subscription by default, raised by a support request | `agentforeach:functionMaxInstances` (100 by default), `httpPerInstanceConcurrency` (16) |
| Cosmos DB | [No limit](https://learn.microsoft.com/azure/cosmos-db/concepts-limits) on storage or physical partitions per container; 10,000 RU/s and 20 GB per logical partition (one user's data) | `agentforeach:cosmosCapacity`: `serverless` by default; `autoscale` with `cosmosAutoscaleMaxRu` for sustained load. Fixed when the account is created |
| Web PubSub | [1,000 connections per unit](https://learn.microsoft.com/azure/azure-web-pubsub/howto-scale-manual-scale), up to 100 units on Standard and Premium_P1; Premium_P2 goes to 1,000 units | `agentforeach:webPubSubSku`, `webPubSubUnits` (1 by default) |
| Scheduler | Not an Azure limit | `CRON_SCHEDULER_SHARDS`: 8 by default, up to 128 |
| Durable Functions (Azure Storage backend) | [1 to 16 partitions](https://learn.microsoft.com/azure/durable-task/durable-functions/durable-functions-azure-storage-provider); activities scale out with instances, and each orchestration lives in one partition | `partitionCount` 16 in `gateway/host.json`, the maximum |
| Model providers | Tokens and requests per minute, [per model and region](https://learn.microsoft.com/azure/foundry/openai/quotas-limits) | Failover between providers (`llms.failover` in the config) |

Limits as published on 30 September 2026. Two notes for very large deployments:

- **The model usually runs out first.** A deployment's token rate limit is reached well before the platform's limits; plan quota per region, and use failover.
- **The Durable task hub is the first platform ceiling.** Every chat turn is a Durable orchestration, and the Azure Storage backend tops out at 16 partitions. Microsoft's [Durable Task Scheduler](https://learn.microsoft.com/azure/durable-task/scheduler/durable-task-scheduler) is the documented next step (about five times the work-item throughput in Microsoft's comparison). It isn't wired up or measured here yet.

What has been measured end to end is in [Benchmarks](Benchmarks.md).

## Security boundaries

See [SECURITY.md](../SECURITY.md) for the model and its limits. The data-path rules: every read and write carries the authenticated user's id; channel identities resolve only through links made by pairing or an admin; the model can call only the tools offered in that turn; untrusted URLs go through an SSRF-safe client; credentials for skills are injected outside the sandbox.

## Design choices

Choices made on purpose for a shared, serverless deployment:

- **Structured documents instead of workspace files.** The agent's SOUL, USER, AGENTS and other documents are Cosmos documents with fields, not Markdown files on a disk that doesn't exist here.
- **Static prompt mode.** Deployments can lock every document except USER, so operators control the agent's character and users control their own profile.
- **No heartbeat daemon.** Proactive behaviour is a scheduled job on the sharded scheduler, not a process per user.
- **Compaction feeds memory.** When a long conversation is compacted, the summary is also stored as a memory.
- **One key per provider** per deployment, instead of per-user keys.
- **Limits on schedules.** Minimum intervals and maximum lifetimes for jobs, because one deployment serves everyone.
