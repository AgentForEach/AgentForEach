# AgentForEach Cron on Azure Durable Functions + Cosmos DB

This document is the implementation reference for AgentForEach cron/reminders.

It explains:

- Architecture (Durable orchestration + Cosmos persistence)
- Scheduling semantics (`at`, `every`, `cron`)
- Execution semantics (`main` vs `isolated`)
- Non-duplication and reliability behavior
- API behavior, auth, and operations
- Differences from OpenClaw heartbeat-linked cron behavior

## 1. Executive Summary

AgentForEach cron is a **shared scheduler model**:

- Jobs are stored in Cosmos DB (`cron-jobs`)
- A Durable orchestrator loop (`CronScheduler`) fetches due jobs and executes them
- Results are stored in Cosmos (`cron-runs`)
- Scheduler wake-up is timer-driven + event-driven (`jobsChanged`)

Important:

- This is **not** one Durable ticker per user.
- It is one scheduler instance per shard.
- Default is **8 shards** (`CRON_SCHEDULER_SHARDS=8`).

## 2. Component Map

Core modules:

- `gateway/cron/config.ts`
- `gateway/cron/types.ts`
- `gateway/cron/schedule.ts`
- `gateway/cron/store.ts`
- `gateway/cron/executor.ts`
- `gateway/cron/delivery.ts`
- `gateway/cron/orchestrator.ts`
- `gateway/cron/api.ts`
- `gateway/cron/tools.ts`
- `gateway/websocket/push-adapter.ts`

Runtime registrations:

- `gateway/index.ts`

## 3. Data Model in Cosmos

### 3.1 Containers

- `cron-jobs`
  - Partition key: `/userId`
  - Stores job definitions + mutable job state
- `cron-due-index`
  - Partition key: `/shardId`
  - Stores scheduler index rows (`jobId`, `userId`, `nextRunAtMs`, running-claim fields, `jobVersion`)
  - Optimized for shard-local due/next-wake queries
- `cron-runs`
  - Partition key: `/jobId`
  - Stores immutable run history
  - TTL enabled (default 24h)
- `cron-heartbeat-events`
  - Partition key: `/shardId`
  - Stores queued main-session events for `wakeMode="next-heartbeat"` and `wakeMode="now"`
  - Uses `enqueuedAtMs` as created-time ordering key for deterministic per-target drain ordering
  - Claimed/retried by scheduler activities
  - Events crossing max-attempt cutoff are marked dead-letter in-place (`deadLetteredAtMs`, `deadLetterReason`) and excluded from due processing

### 3.2 Job shape (high-level)

Each job document stores:

- identity: `id`, `userId`, `agentId`, `sessionId`
- concurrency/version: `version` (monotonic per successful mutation)
- routing: `shardId`
- schedule: `schedule.kind` (`at` | `every` | `cron`)
- behavior: `sessionTarget`, `wakeMode`, `enabled`, `deleteAfterRun`
- payload: `systemEvent` or `agentTurn`
- delivery settings (optional)
- runtime state: `nextRunAtMs`, `runningToken`, `runningAtMs`, `lastStatus`, `consecutiveErrors`, etc.

### 3.3 Run shape (high-level)

Each run document stores:

- `jobId`, `userId`, `ts`
- `status`, `error`, `summary`, `durationMs`
- `model`, `usage`
- delivery metadata (`delivered`, `deliveryChannel`)
- `ttl`

## 4. End-to-End Lifecycle

### 4.1 Create/Update/Delete

1. API/tool writes job mutation in `cron-jobs`
2. Mutation path also upserts/deletes the job's due-index row in `cron-due-index`
3. Mutation path raises Durable external event `jobsChanged`
4. Scheduler wakes early and recomputes next due work

Write consistency note:

- `cron-jobs` is source-of-truth.
- Due-index writes are best-effort dual-writes; claim checks and later mutations reconcile drift. Jobs created before the due index existed are indexed once with `POST /cron/admin/backfill-due-index` (admin).
- Due-index upserts are monotonic by source `jobVersion`: stale lower-version index writes are ignored.

Mutation signal paths:

- HTTP cron API (`gateway/cron/api.ts`)
- LLM cron tool handler via `onCronMutation` callback (`gateway/cron/tools.ts`, `gateway/client/runner.ts`, gateway handlers)

### 4.2 Execution loop

For each orchestrator iteration:

1. `GetDueJobs` activity reads+claims due jobs for a shard
2. `ExecuteAndRecordJob` activity runs each job
3. `ProcessHeartbeatQueue` activity flushes due queued heartbeat events (shard-wide)
4. Activity records runs in `cron-runs`
5. Activity applies result/state transitions in `cron-jobs`
6. `ComputeNextWake` returns earliest next run (including heartbeat queue wake)
7. Orchestrator waits for timer or `jobsChanged`
8. `continueAsNew` resets orchestration history

Additional `wakeMode="now"` path:

- `ExecuteAndRecordJob` enqueues a heartbeat event due immediately (`dueAtMs=now`)
- Runtime attempts an immediate target-scoped heartbeat flush for the same `userId`/`agentId`/`sessionId`
- If immediate flush fails, the event remains queued for retry by scheduler heartbeat processing

## 5. Scheduler Loop Frequency

The scheduler is **not fixed-interval polling**.

It wakes by this logic:

- If a next due job exists: sleep until that due timestamp
- If no jobs exist: fallback wake every `FALLBACK_WAKE_INTERVAL_MS` (5 minutes)
- If a mutation occurs: wake immediately via `jobsChanged`

Also:

- `CronSchedulerHealthCheck` runs every 5 minutes to ensure scheduler instances are alive.
- Durable timer waits are capped by `MAX_DURABLE_TIMER_MS` due to JS Durable timer limits.

## 6. Scheduling Semantics

## 6.1 `at` (one-shot)

- Input: absolute timestamp (`schedule.at`)
- Supports ISO and numeric epoch-like values through `parseAbsoluteTimeMs`
- Past-due `at` remains schedulable until terminal handling (OpenClaw parity behavior)

Terminal handling:

- On success and `deleteAfterRun=true`: delete job
- Otherwise: disable job after terminal run (prevents loops)

## 6.2 `every`

- Input: `everyMs` (+ optional `anchorMs`)
- If anchor omitted, it is normalized during create/update
- Next run is computed as aligned interval boundary after `now`

## 6.3 `cron`

- Input: cron expression + optional `tz`
- Uses `croner`
- Timezone fallback: host timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`)
- Same-second guard avoids immediate re-trigger loops

### 6.4 Cron stagger

For top-of-hour expressions, AgentForEach applies deterministic staggering:

- Default window: 5 minutes (`DEFAULT_TOP_OF_HOUR_STAGGER_MS`)
- Offset is stable per job (`sha256(jobId) % staggerMs`)
- Cursor shifting prevents skipping the current valid window

## 7. Session Target Semantics

## 7.1 `sessionTarget = "isolated"`

- Requires `payload.kind = "agentTurn"`
- Executor calls OpenAI Responses API directly
- Supports per-job model override and timeout override

## 7.2 `sessionTarget = "main"`

- Requires `payload.kind = "systemEvent"`
- Main-lane sends route through `AgentClient.send()` with interactive/full context.
- Sends happen through the heartbeat event lane (not direct one-off bypass writes).

## 7.3 `wakeMode` semantics

`wakeMode` is now functionally active for `sessionTarget="main"` jobs:

- `wakeMode="now"`
  - Enqueues a heartbeat event due `now`.
  - Attempts immediate target-scoped queue flush (same `userId`/`agentId`/`sessionId`) in the same execution path (OpenClaw-like wake-now behavior).
  - Immediate flush is bounded by `CRON_WAKE_NOW_IMMEDIATE_FLUSH_LIMIT` to protect hot-path latency.
  - If target backlog is above `CRON_WAKE_NOW_BACKLOG_THRESHOLD`, runtime degrades to queued delivery (no immediate flush) to avoid burst-induced overload.
  - If flush cannot complete, event remains queued for retry (no drop).
- `wakeMode="next-heartbeat"`
  - Queues the system event in `cron-heartbeat-events`.
  - `ProcessHeartbeatQueue` drains queued events on heartbeat cadence and sends grouped turns.
  - Multiple queued items for the same user/session in the same drain cycle are coalesced in bounded groups (`CRON_HEARTBEAT_GROUP_BATCH_SIZE`).
  - Coalescing policy is ordered merge (not last-write-wins): each queued text is preserved and emitted in sequence.

Target-scoped flush detail (`wakeMode="now"`):

- Immediate flush query is filtered by target identity (`userId`, optional `agentId`, optional `sessionId`).
- This avoids draining unrelated users/sessions during a single user's wake-now execution.

Ordering policy (`userId` + `agentId` + `sessionId`):

- Queue query order: `dueAtMs ASC` (Cosmos-index friendly claim query)
- Drain order within target group: deterministic sort by `dueAtMs ASC, enqueuedAtMs ASC, id ASC` before chunking/sending
- FIFO guarantee scope: deterministic FIFO within a single claimed drain batch for a target
- Cross-drain global FIFO is best-effort (concurrent workers/retries can still reorder across separate batches)

## 8. Delivery Semantics

Delivery modes:

- `none`
- `webhook`
- `announce` / `channel` (normalized internally)

## 8.1 Webhook

- POSTs run result JSON to `delivery.to`
- Optional bearer token support (`delivery.token`)
- `bestEffort` controls whether delivery failure fails the run

## 8.2 Channel/announce adapters

- Routed via adapter registry (`gateway/cron/delivery.ts`)
- Current built-in adapter: `push` via Azure Web PubSub
- Push adapter checks user online status before sending

Default behavior differences:

- LLM tool path defaults isolated jobs to `announce` push + `bestEffort=true`
- Raw HTTP API create does not force this default; explicit delivery may be required depending on caller behavior

## 9. Non-Duplication and Reliability

AgentForEach uses claim-token based execution ownership.

Authoritative lock semantics:

- Authoritative execution lock is on `cron-jobs` via optimistic concurrency + `runningToken` claim (`ETag`-guarded write).
- `cron-due-index` running fields are scheduler hints only (candidate shaping), not the source-of-truth lock.
- If index and source diverge, scheduler re-validates against `cron-jobs` before execution claim.
- Stale index state is corrected by source re-sync during claim checks; missing rows for pre-index jobs by the one-off backfill.

Key protections:

1. Due query filters for eligible, non-running/stale-running jobs
2. Claim step sets `runningToken` + `runningAtMs` with optimistic concurrency
3. Start step (`beginClaimedRun`) re-validates token before execution
4. Apply-result can enforce token ownership and return `stale` when superseded
5. Stale claim recovery after `RUNNING_CLAIM_STALE_MS`
6. Force-run endpoint acquires an atomic running claim before execution
7. If result persistence fails, runtime attempts explicit claim release to avoid long stale blocks
8. Heartbeat queue events use claim tokens (`runningToken`) and stale-claim recovery, same anti-duplication pattern as jobs
9. Due-job fetch is bounded per tick (`CRON_MAX_DUE_JOBS_PER_TICK`) to prevent unbounded orchestrator fan-out
10. Heartbeat event claims are bounded per drain (`CRON_MAX_HEARTBEAT_EVENTS_PER_CLAIM`) to prevent per-iteration spikes
11. Heartbeat processing has max-attempt cutoff (`CRON_HEARTBEAT_MAX_ATTEMPTS`); failed events are dead-lettered and no longer retried indefinitely
12. Due-index sync is version-monotonic (`jobVersion`); stale index writes cannot overwrite newer rows

This protects against duplicate execution in retries/races.

## 10. Sharding and Scale Model

Shard derivation:

- `shardId = hash(userId) % shardCount`

Scheduler instances:

- shard 0: `agentforeach-cron-scheduler`
- shard > 0: `agentforeach-cron-scheduler-{shardId}`

Current default:

- `DEFAULT_SCHEDULER_SHARDS = 8`

Scale control:

- env var: `CRON_SCHEDULER_SHARDS`
- Pulumi config: `agentforeach:cronSchedulerShards`

Scheduler query path:

1. Scheduler reads due/next-wake candidates from `cron-due-index` scoped to one shard partition.
2. Scheduler reads+claims the source job in `cron-jobs` using optimistic concurrency.
3. Claim/result transitions update `cron-due-index` so active running claims are not re-selected.
4. Due-index updates are idempotent and monotonic (`incoming jobVersion >= stored jobVersion` only).

Backward-compatibility path:

- A legacy fallback query against `cron-jobs` remains for pre-index rows and migration safety.
- Fallback results are re-synced into `cron-due-index` opportunistically.
- Next-wake computation always cross-checks legacy `cron-jobs` top-1 as a safety net.
- The legacy sweep (a cross-partition query over `cron-jobs` every 60 s) is **off** by default; `CRON_LEGACY_SWEEP=true` turns it on. Prefer the one-off backfill.

Operational threshold guidance:

- `CRON_SCHEDULER_SHARDS=1` is fine for local development.
- For larger SaaS workloads, increase shards and monitor per-shard RU + durable throughput.

## 11. API Surface

Main endpoints:

- `POST /cron/jobs`
- `GET /cron/jobs`
- `GET /cron/jobs/{id}`
- `PATCH /cron/jobs/{id}`
- `DELETE /cron/jobs/{id}`
- `POST /cron/jobs/{id}/run`
- `GET /cron/runs/{id}`
- `GET /cron/status`
- `POST /cron/start`

Functional notes:

- `/cron/jobs/{id}/run` performs real execution, records run, applies state transitions, and signals scheduler
- `/cron/status` supports per-shard inspection (`?shardId=`); **admin role required**
- `/cron/start` can ensure one or all shard schedulers; **admin role required** (the `CronSchedulerHealthCheck` timer normally does this)

## 12. Auth and Access Rules

All cron routes resolve caller identity using gateway Easy Auth resolver (`resolveAuthContext`).

Current behavior:

- Without resolved user identity => `401 Unauthorized`
- Job read/write is scoped by `userId` in store calls
- Scheduler control endpoints also enforce authenticated identity in handler logic

Dev fallback:

- `AUTH_ALLOW_INSECURE_USER_ID_HEADER=true` allows `x-user-id` fallback
- For production, disable insecure header mode

## 13. Tooling Behavior (LLM Cron Tools)

Registered tools:

- `cron_create`, `cron_list`, `cron_get`, `cron_update`, `cron_delete`, `cron_runs`

Important guardrails:

- Reminder guardrail enforces one-shot `at` for reminder-like requests unless recurrence is explicit
- Tool mutation triggers scheduler wake callback
- Tool handler always injects server-side `userId` (model cannot set owner)

## 14. Operational Runbook

### 14.1 Deploy-time configuration

Set and verify:

- `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE`
- `OPENAI_API_KEY`
- `CRON_SCHEDULER_SHARDS`
- `CRON_HEARTBEAT_INTERVAL_MS`
- `CRON_MAX_DUE_JOBS_PER_TICK`
- `CRON_MAX_HEARTBEAT_EVENTS_PER_CLAIM`
- `CRON_WAKE_NOW_IMMEDIATE_FLUSH_LIMIT`
- `CRON_WAKE_NOW_BACKLOG_THRESHOLD`
- `CRON_HEARTBEAT_GROUP_BATCH_SIZE`
- `CRON_HEARTBEAT_MAX_ATTEMPTS`
- `CRON_MAX_JOBS_PER_USER`
- `AUTH_ALLOW_INSECURE_USER_ID_HEADER`
- `WEBPUBSUB_CONNECTION_STRING` (if using announce/push)

### 14.2 Post-deploy sanity checks

1. `GET /cron/status` (as a caller with the admin role) should show running scheduler(s)
2. Create an `at` job for +1 to +2 minutes
3. Validate one run appears in `cron-runs`
4. Validate one-shot job is disabled/deleted terminally (no repeated fire)
5. Create `every` job and verify periodic runs
6. Validate both wake modes:
   - `wakeMode="now"` force-run should deliver quickly to target session
   - `wakeMode="next-heartbeat"` force-run should return queued summary and deliver on heartbeat flush

### 14.3 Suggested alerts/observability

Track:

- Durable instance runtime status (Failed/Terminated)
- Activity failure counts (`ExecuteAndRecordJob`)
- 401 rates on cron APIs
- Delivery failure rates (`delivered=false`, webhook non-2xx)
- Cosmos RU spikes on due/wake query paths
- Dead-lettered heartbeat event count (`deadLetteredAtMs` set)

### 14.4 Automated validation

Run advanced multi-user cron/heartbeat e2e suite:

- `npm run test:cron-heartbeat:e2e`
- Optional load knobs:
  - `npm run test:cron-heartbeat:e2e -- --users 6 --due-users 3`
  - `AGENTFOREACH_BASE_URL=https://<app>.azurewebsites.net npm run test:cron-heartbeat:e2e`

What it validates:

- Scheduler status
- Concurrent `wakeMode="now"` and `wakeMode="next-heartbeat"` across multiple users
- Scheduler-due execution without force-run
- Cross-user endpoint isolation and session-content isolation

## 15. Troubleshooting Guide

### Symptom: one-time reminder repeats

Check:

- job schedule is `kind="at"`
- run status/state transitions in `applyResult`
- client UI is not duplicating display from multiple streams

### Symptom: scheduler looks idle

Check:

- `/cron/status`
- health timer logs (`CronSchedulerHealthCheck`)
- job `enabled=true` and `state.nextRunAtMs` exists
- shard config and instance id mapping

### Symptom: job ran but no in-app reminder message

Check:

- run exists in `cron-runs`
- delivery mode and channel config
- WebPubSub connectivity / online status (push adapter skips offline users)
- `bestEffort` masking delivery failures

### Symptom: heartbeat events stop retrying

Check:

- event has `deadLetteredAtMs` / `deadLetterReason` in `cron-heartbeat-events`
- `CRON_HEARTBEAT_MAX_ATTEMPTS` is set appropriately for your downstream reliability
- persistent send failures in gateway/client logs (`sendMainSessionText` path)

### Symptom: unauthorized from web app

Check:

- Easy Auth principal present OR insecure dev header fallback enabled
- `AUTH_ALLOW_INSECURE_USER_ID_HEADER` alignment with client behavior
- CORS and cookie credential settings if using browser auth flow

## 16. OpenClaw Parity Notes

Aligned concepts:

- Schedule types (`at`, `every`, `cron`)
- One-shot terminal behavior
- Error backoff pattern
- Top-of-hour stagger behavior
- Tool-based cron UX

Intentional platform change:

- OpenClaw uses in-process scheduler + heartbeat wake queue
- AgentForEach uses Durable orchestration + Cosmos state

Current known functional difference:

- OpenClaw heartbeat cadence/behavior is configured in-process per agent.
- AgentForEach heartbeat queue cadence is scheduler-driven (`CRON_HEARTBEAT_INTERVAL_MS`) and shard-scoped via Durable/Cosmos.
- OpenClaw wake-now uses in-process heartbeat wake; AgentForEach wake-now uses queue + immediate target-scoped flush with queued retry fallback.

## 17. FAQ

### Q: Do we run one scheduler per user?

No. AgentForEach runs one scheduler per shard (8 by default); users are spread across them by id.

### Q: How often does scheduler loop?

Not fixed polling. It wakes at the earliest due timestamp, or every 5 minutes when no jobs exist, and immediately on `jobsChanged` events.

### Q: Is this production-ready with 1 shard?

For low-traffic testing/staging, yes. For higher multi-user load, increase `CRON_SCHEDULER_SHARDS` and monitor Cosmos RU + Durable throughput.
