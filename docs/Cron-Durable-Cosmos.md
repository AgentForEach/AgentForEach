# AgentForEach cron on Azure Durable Functions + Cosmos DB

This document is the implementation reference for AgentForEach cron/reminders on Azure. The scheduler is written against the cloud-neutral Durable port ([Platforms](Platforms.md)); this document covers how the Azure pack runs it.

It explains:

- Architecture (Durable Functions orchestrations + Cosmos persistence)
- Scheduling semantics (`at`, `every`, `cron`)
- Execution semantics (`main` vs `isolated`)
- Non-duplication and reliability behavior
- API behavior, auth, and operations

## 1. Executive summary

AgentForEach cron uses a **shared scheduler model**:

- Jobs are stored in Cosmos DB (`cron-jobs`)
- A durable alarm per shard (`CronScheduler`; on Azure a `DurableAlarm` orchestration) claims due jobs and starts a `CronRun` durable job (a `DurableJob` orchestration) for each
- Results are stored in Cosmos (`cron-runs`)
- Scheduler wake-up is timer-driven + event-driven (`wakeAlarm`, which raises the alarm's `wake` event)

Important:

- This is **not** one Durable ticker per user.
- It is one scheduler instance per shard.
- Default is **8 shards** (`CRON_SCHEDULER_SHARDS=8`).

## 2. Component map

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

- `gateway/workflows.ts`: the durable kinds (`CronScheduler` alarm, `CronRun` job, and the gateway's other kinds)
- `gateway/index.ts`: registers them with the Azure pack (`registerDurable`, `registerLegacyOrchestrations`) and adds `DurableHistoryPurge` (`withDurableMaintenance`)
- `packages/platform-azure/src/durable/`: the generic orchestrations (`durable.ts`), the pre-port ones kept for one release (`legacy.ts`), history purge (`maintenance.ts`)

## 3. Data model in Cosmos

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
  - Claimed/retried by the scheduler tick
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

## 4. End-to-end lifecycle

### 4.1 Create/update/delete

1. API/tool writes job mutation in `cron-jobs`
2. Mutation path also upserts/deletes the job's due-index row in `cron-due-index`
3. Mutation path wakes the shard's alarm (`wakeAlarm`: the `wake` external event on its `DurableAlarm` orchestration)
4. Scheduler wakes early and recomputes next due work

Write consistency note:

- `cron-jobs` is source-of-truth.
- Due-index writes are best-effort dual-writes; claim checks and later mutations reconcile drift. Jobs created before the due index existed are indexed once with `POST /cron/admin/backfill-due-index` (admin).
- Due-index upserts are monotonic by source `jobVersion`: stale lower-version index writes are ignored.

Mutation signal paths:

- HTTP cron API (`gateway/cron/api.ts`)
- LLM cron tool handler via `onCronMutation` callback (`gateway/cron/tools.ts`, `gateway/client/runner.ts`, gateway handlers)

### 4.2 Execution loop

For each `DurableAlarm` iteration (the tick, `schedulerTick`, runs in the `DurableAlarmTick` activity):

1. `getDueJobs` reads+claims due jobs for a shard
2. The tick starts one `CronRun` durable job per claimed job (id `cron-run-<jobId>-<runningToken>`): a `DurableJob` orchestration with one `DurableJobRun` activity, never retried
3. `processHeartbeatQueue` flushes due queued heartbeat events (shard-wide)
4. `computeNextWakeMs` returns earliest next run (including heartbeat queue wake); with nothing scheduled the tick returns now + `FALLBACK_WAKE_INTERVAL_MS`
5. The orchestration waits for a timer to that time or the `wake` event
6. `continueAsNew` resets orchestration history

Each `CronRun` job (`executeAndRecordJob`):

1. Re-validates the claim (`beginClaimedRun`) and executes the job
2. Records the run in `cron-runs`
3. Applies result/state transitions in `cron-jobs`

Additional `wakeMode="now"` path:

- The `CronRun` job enqueues a heartbeat event due immediately (`dueAtMs=now`)
- Runtime attempts an immediate target-scoped heartbeat flush for the same `userId`/`agentId`/`sessionId`
- If immediate flush fails, the event remains queued for retry by scheduler heartbeat processing

## 5. Scheduler loop frequency

The scheduler is **not fixed-interval polling**.

It wakes by this logic:

- If a next due job exists: sleep until that due timestamp
- If no jobs exist: fallback wake every `FALLBACK_WAKE_INTERVAL_MS` (5 minutes)
- If a mutation occurs: wake immediately via `wakeAlarm`

Also:

- `CronSchedulerHealthCheck` runs every 5 minutes to ensure scheduler instances are alive.
- The `DurableAlarm` timer is capped at 6 days (`MAX_TIMER_MS` in `packages/platform-azure/src/durable/durable.ts`), the longest JavaScript Durable Functions timer; the alarm then ticks and sleeps again.

## 6. Scheduling semantics

## 6.1 `at` (one-shot)

- Input: absolute timestamp (`schedule.at`)
- Supports ISO and numeric epoch-like values through `parseAbsoluteTimeMs`
- Past-due `at` remains schedulable until terminal handling

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

## 7. Session target semantics

## 7.1 `sessionTarget = "isolated"`

- Requires `payload.kind = "agentTurn"`
- Executor makes a single model call through AgentForEach's provider layer (not a full chat turn)
- Supports a per-job timeout override; `payload.model` is ignored and the default model is used

## 7.2 `sessionTarget = "main"`

- Requires `payload.kind = "systemEvent"`
- Main-lane sends route through `AgentClient.send()` with interactive/full context.
- Sends happen through the heartbeat event lane (not direct one-off bypass writes).

## 7.3 `wakeMode` semantics

`wakeMode` takes effect for `sessionTarget="main"` jobs:

- `wakeMode="now"`
  - Enqueues a heartbeat event due `now`.
  - Attempts immediate target-scoped queue flush (same `userId`/`agentId`/`sessionId`) in the same execution path.
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

## 8. Delivery semantics

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

## 9. Non-duplication and reliability

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
9. Due-job fetch is bounded per tick (`CRON_MAX_DUE_JOBS_PER_TICK`) to bound how many `CronRun` jobs one tick starts
10. Heartbeat event claims are bounded per drain (`CRON_MAX_HEARTBEAT_EVENTS_PER_CLAIM`) to prevent per-iteration spikes
11. Heartbeat processing has max-attempt cutoff (`CRON_HEARTBEAT_MAX_ATTEMPTS`); failed events are dead-lettered and no longer retried indefinitely
12. Due-index sync is version-monotonic (`jobVersion`); stale index writes cannot overwrite newer rows

This protects against duplicate execution in retries/races.

## 10. Sharding and scale model

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

- Jobs created before the due index existed are indexed by the one-off backfill (`POST /cron/admin/backfill-due-index`). The old legacy sweep (a cross-partition query over `cron-jobs`, off by default) was removed with the move to the storage SDK.

Operational threshold guidance:

- `CRON_SCHEDULER_SHARDS=1` is fine for local development.
- For larger SaaS workloads, increase shards and monitor per-shard RU + durable throughput.

## 11. API surface

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

- `/cron/jobs/{id}/run` claims the job and starts a `CronRun` durable job (id `force-run-<jobId>-<ms>`) that performs real execution, records the run and applies state transitions; the API wakes the scheduler when it dispatches the run
- `/cron/status` supports per-shard inspection (`?shardId=`); **admin role required**
- `/cron/start` can ensure one or all shard schedulers; **admin role required** (the `CronSchedulerHealthCheck` timer normally does this)

## 12. Auth and access rules

All cron routes resolve caller identity using gateway Easy Auth resolver (`resolveAuthContext`).

Current behavior:

- Without resolved user identity => `401 Unauthorized`
- Job read/write is scoped by `userId` in store calls
- Scheduler control endpoints also enforce authenticated identity in handler logic

Dev fallback:

- `AUTH_ALLOW_INSECURE_USER_ID_HEADER=true` allows `x-user-id` fallback
- For production, disable insecure header mode

## 13. Tooling behavior (LLM cron tools)

Registered tools:

- `cron_create`, `cron_list`, `cron_get`, `cron_update`, `cron_delete`, `cron_runs`

Guardrails:

- Reminder guardrail enforces one-shot `at` for reminder-like requests unless recurrence is explicit
- Tool mutation triggers scheduler wake callback
- Tool handler always injects server-side `userId` (model cannot set owner)

## 14. Operational runbook

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
- `DurableJobRun` activity failures for `CronRun` instances (ids `cron-run-*`, `force-run-*`)
- 401 rates on cron APIs
- Delivery failure rates (`delivered=false`, webhook non-2xx)
- Cosmos RU spikes on due/wake query paths
- Dead-lettered heartbeat event count (`deadLetteredAtMs` set)

### 14.4 Automated validation

Run the multi-user cron/heartbeat e2e suite:

- `npm run test:cron-heartbeat:e2e`
- Optional load knobs:
  - `npm run test:cron-heartbeat:e2e -- --users 6 --due-users 3`
  - `AGENTFOREACH_BASE_URL=https://<app>.azurewebsites.net npm run test:cron-heartbeat:e2e`

What it validates:

- Scheduler status
- Concurrent `wakeMode="now"` and `wakeMode="next-heartbeat"` across multiple users
- Scheduler-due execution without force-run
- Cross-user endpoint isolation and session-content isolation

### 14.5 Upgrading from the pre-port scheduler

Instance ids are unchanged. A shard still running the old `CronScheduler` orchestration doesn't listen for `wake`, so `wakeAlarm` skips it. The next `ensureAlarm` for that shard terminates it and starts a `DurableAlarm` with the same id: the `CronSchedulerHealthCheck` (within 5 minutes of deploy) or a cron tool change (`handlers/cron-signal.ts`). Until then `/cron/status` shows it running and `/cron/start` reports it as `already-running`.

The pre-port `CronForceRunExecution` orchestration (and the `ChatTurn`, `ChannelInboundTurn` and `HitlAwaitInput` orchestrations) stay registered for one release, so instances in flight at deploy finish (`packages/platform-azure/src/durable/legacy.ts`). New work never starts them.

## 15. Troubleshooting guide

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
- after an upgrade, whether the shard is still an old `CronScheduler` instance (§14.5)

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

## 16. Design notes

- Schedule types (`at`, `every`, `cron`), one-shot terminal behavior, error backoff, top-of-hour stagger, and tool-based cron UX.
- Scheduling runs on durable alarms and jobs (on Azure, `DurableAlarm` and `DurableJob` orchestrations) with state in Cosmos.
- Heartbeat queue cadence is scheduler-driven (`CRON_HEARTBEAT_INTERVAL_MS`) and shard-scoped.
- Wake-now enqueues, then flushes the target's queue immediately, with queued retry as the fallback.

## 17. FAQ

### Q: Do we run one scheduler per user?

No. AgentForEach runs one scheduler per shard (8 by default); users are spread across them by id.

### Q: How often does scheduler loop?

Not fixed polling. It wakes at the earliest due timestamp, or every 5 minutes when no jobs exist, and immediately when a cron change wakes it (`wakeAlarm`).

### Q: Is this production-ready with 1 shard?

For low-traffic testing/staging, yes. For higher multi-user load, increase `CRON_SCHEDULER_SHARDS` and monitor Cosmos RU + Durable throughput.
