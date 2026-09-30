# Architecture

AgentForEach is one stateless Function App in front of Cosmos DB. Every turn loads what it needs, calls the model, writes the result and forgets; nothing about a user lives in memory between turns. That is what lets it run one deployment for any number of users and cost nothing for users who aren't talking to it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img alt="Architecture. Users reach one Function App on Flex Consumption from an app or the web over HTTP and WebSocket, or from Telegram and WhatsApp webhooks. The app accepts a message in about 0.12 seconds, runs the turn in a Durable orchestration and hands it to the agent runner; a sharded scheduler wakes the runner for reminders and heartbeats. The runner calls model providers, Cosmos DB partitioned by user, Web PubSub, a per-user sandbox and optional AI Search. The reply streams back to every device the user has open. The app is stateless, so any instance serves any user and it scales to zero." src="assets/architecture-light.svg">
</picture>

## Components

| Component | Azure service | Role |
|---|---|---|
| Handlers, runner, scheduler | Functions, Flex Consumption (Node 22) | HTTP and WebSocket entry points, the agent loop, timers |
| Background work | Durable Functions (Azure Storage backend) | Chat turns, channel turns, approvals, the cron scheduler |
| State | Cosmos DB for NoSQL | Sessions, messages, memories, jobs, identities, … (below) |
| Real-time delivery | Web PubSub | Streams replies to every device a user has connected |
| Code execution | Container Apps Sandboxes (Dynamic Sessions as fallback) | One sandbox per user, suspended when idle |
| Knowledge (optional) | AI Search | Hybrid search over reference documents |
| Secrets | Key Vault | Referenced from app settings by version |
| Telemetry | Application Insights, Log Analytics | Sampled logs, alerts |

The Pulumi program in `infra` creates all of it.

## A chat turn

1. **Accept.** `POST /api/chat` (or a WebSocket `chat` message) authenticates the caller, validates the message, counts it against the user's rate limit, and starts a `ChatTurn` orchestration whose id is derived from the user and the idempotency key. It returns `202 { runId, sessionId }`. A retry with the same key joins the running turn instead of starting a second one.
2. **Run.** The `RunChatTurn` activity loads the session and takes its **run lease** (below), then builds the turn: history (or the provider's response chain), compaction summary, recalled memories, recent sessions, prompt documents, tools. The runner calls the model, executes tool calls (each isolated, so one failing tool doesn't fail the turn), and loops until the model answers or a limit is reached.
3. **Stream.** Text deltas are coalesced every 400 ms and pushed over Web PubSub with their offset; the `final` event carries the whole reply.
4. **Persist.** The user message and reply are appended to the session (etag-guarded), usage is recorded, memories may be captured, and the lease is released.

Channels (Telegram, WhatsApp) follow the same path from their webhooks, acknowledging first and running the turn in a `ChannelInboundTurn` orchestration.

### Real-time protocol

A client calls `GET /negotiate` (authenticated like any API call) and gets `{ url }`, a Web PubSub URL with an access token for that user, and opens a WebSocket to it. What the client sends reaches `/ws/message` as a Web PubSub event, verified by its signature:

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
| `memories` | `/userId` | — | Long-term memories with vector and full-text indexes |
| `episodes`, `session-digests` | `/userId` | — / per document | Episodic memory, summaries of past sessions |
| `prompt-documents`, `onboarding-state` | `/userId` | — | The agent's documents (SOUL, USER, …) and onboarding |
| `cron-jobs` | `/userId` | — | Scheduled jobs |
| `cron-due-index`, `cron-heartbeat-events` | `/shardId` | 7 days, 2 days | What each scheduler shard runs next |
| `cron-runs` | `/jobId` | 1 day | Run history |
| `identity-links`, `identity-channel-index`, `identity-pairing` | `/userId`, `/id`, `/code` | —, —, 5 min | Channel accounts linked to users |
| `hitl-requests` | `/userId` | 1 h | Paused runs waiting for a form or approval |
| `usage-records` | `/userId` | 90 days | Tokens and cost per run |
| `rate-limits` | `/id` | per document | Per-user message counters |
| `abort-requests` | `/userId` | 10 min | Stop-button markers that reach any instance |
| `user-skills`, `whatsapp-state` | `/userId`, `/scope` | —, per document | Skill settings, WhatsApp delivery state |

Almost everything is partitioned by user, so a turn's reads and writes are point reads or single-partition queries.

## Scheduled work

Jobs are spread over scheduler shards (8 by default), each an eternal Durable orchestration that sleeps until its next due job. A job's due time lives in `cron-due-index`, partitioned by shard, so a shard finds its next work with a single-partition query. A timer restarts any shard that stopped.

## Scaling

Nothing in the design is per user or global. A turn holds no state between calls, user data sits in that user's partition, schedules are spread over shards, and the only lock is a lease on one session. So each ceiling below is either a limit Microsoft publishes or a setting in this repo, and you raise it without changing code.

| Layer | What Microsoft publishes | The setting here |
|---|---|---|
| Functions, Flex Consumption | Up to [1,000 instances](https://learn.microsoft.com/azure/azure-functions/flex-consumption-plan) per function group; 250 cores per region per subscription by default, raised by a support request | `agentforeach:functionMaxInstances` (100 by default), `httpPerInstanceConcurrency` (16) |
| Cosmos DB | [No limit](https://learn.microsoft.com/azure/cosmos-db/concepts-limits) on storage or physical partitions per container; 10,000 RU/s and 20 GB per logical partition (one user's data) | `agentforeach:cosmosCapacity`: `serverless` by default; `autoscale` with `cosmosAutoscaleMaxRu` for sustained load. Fixed when the account is created |
| Web PubSub | [1,000 connections per unit](https://learn.microsoft.com/azure/azure-web-pubsub/howto-scale-manual-scale), up to 100 units on Standard and Premium_P1; Premium_P2 goes to 1,000 units | `agentforeach:webPubSubSku`, `webPubSubUnits` (1 by default) |
| Scheduler | — | `CRON_SCHEDULER_SHARDS`: 8 by default, up to 128 |
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
