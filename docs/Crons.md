# AgentForEach Cron System (Azure Durable + Cosmos) — Architecture and OpenClaw Parity

For an implementation + operations guide focused on Durable Functions and Cosmos usage, see:
`docs/Cron-Durable-Cosmos.md`

## 1. Purpose

This document describes **how cron jobs run in AgentForEach today** and how that maps to OpenClaw's cron model.

AgentForEach keeps OpenClaw's cron concepts (at/every/cron schedules, one-shot behavior, backoff, run logs, delivery modes, session target semantics), but replaces the runtime/storage layers with Azure-native components:

- Scheduler runtime: Azure Durable Functions orchestration instead of in-process `setTimeout`
- Persistence: Cosmos DB containers instead of file-backed `jobs.json` and `*.jsonl` logs

## 2. Runtime Architecture

### 2.1 Durable Components

- `CronScheduler` orchestration (`gateway/cron/orchestrator.ts`) — one instance per shard
- Activities:
  - `GetDueJobs`
  - `ExecuteAndRecordJob`
  - `ComputeNextWake`
  - `ProcessHeartbeatQueue`
- Health timer:
  - `CronSchedulerHealthCheck` ensures all configured shard orchestrations are running

### 2.2 Eternal Loop

Each orchestration iteration:

1. Reads due jobs from Cosmos (`getDueJobs`)
2. Fans out job execution (`ExecuteAndRecordJob`) and, in parallel, drains the shard's heartbeat queue (`ProcessHeartbeatQueue`)
3. Computes earliest next wake (`computeNextWakeMs`)
4. Waits on timer or `jobsChanged` external event
5. `continueAsNew()` to keep history bounded

Non-duplicacy guard:
- Due jobs are first **claimed atomically** in Cosmos (running token + timestamp)
- Activity starts only if claim is still valid
- Result application is token-guarded so stale/retried attempts are ignored
- Stale claims are recoverable after a configurable timeout window
- Jobs are deterministically assigned to scheduler shards via `shardId`

## 3. Data Model (Cosmos)

### 3.1 Containers

- `cron-jobs` (partition key: `/userId`)
- `cron-due-index` (partition key: `/shardId`): each job's next due time, so a shard finds its work with a single-partition query
- `cron-heartbeat-events` (partition key: `/shardId`): queued `main`-session events waiting for the next heartbeat flush
- `cron-runs` (partition key: `/jobId`, TTL on run docs)

### 3.2 Job Semantics

AgentForEach cron jobs now use OpenClaw-like core semantics:

- Schedule: `at | every | cron`
- Session target: `main | isolated`
- Wake mode: `next-heartbeat | now`
- Payload:
  - `systemEvent` for `main`
  - `agentTurn` for `isolated`
- Delivery mode:
  - `none`
  - `announce`/`channel` (alias)
  - `webhook`

Store-level invariants are enforced in `gateway/cron/store.ts`:

- `main` requires `payload.kind = systemEvent`
- `isolated` requires `payload.kind = agentTurn`
- `main` only supports webhook delivery (non-webhook delivery rejected)
- `every` schedules normalize/repair `anchorMs`

## 4. Schedule Behavior

### 4.1 `every` correctness (spin-loop prevention)

`every` scheduling uses a strictly-future next-run computation (OpenClaw-compatible), preventing `nextRunAtMs === now` loops.

### 4.2 Cron stagger behavior

Top-of-hour cron jobs use deterministic per-job offsets. AgentForEach now uses OpenClaw-style cursor shifting so staggered jobs do not skip the active schedule window.

## 5. Execution Paths

## 5.1 `isolated` jobs

- Executes the `agentTurn` payload as a single model call through AgentForEach's provider layer (not a full chat turn)
- Applies the timeout override from payload (a `payload.model` override is ignored; isolated jobs use the default model)
- Records run history and usage

## 5.2 `main` jobs

- The `systemEvent` text is queued in `cron-heartbeat-events` and delivered to the user's main session as a normal turn (`AgentClient.send()`, marked `scheduled`); events due for the same user/agent/session are batched into one turn
- `wakeMode: "next-heartbeat"` only queues the event; the shard's next `ProcessHeartbeatQueue` flush delivers it
- `wakeMode: "now"` queues the event and then tries to flush it immediately; if the session is busy or a backlog has built up, it stays queued for the next flush instead of being dropped
- Supports optional `agentId` and `sessionId` routing

## 6. Write Paths and Scheduler Wake

Any cron mutation should wake scheduler promptly.

### 6.1 HTTP cron API path

`gateway/cron/api.ts` raises Durable external event `jobsChanged` after create/update/delete and force-run state updates.

### 6.2 Tool path (LLM function tools)

`CronToolHandler` accepts an `onMutation` callback. The chat and channel turn handlers pass `onCronMutation` (from `handlers/cron-signal.ts`), which raises `jobsChanged` on the owning shard, so cron mutations made by the model through tools also wake the scheduler.

Wired in:

- `gateway/handlers/chat-turn.ts`
- `gateway/handlers/channel-webhook.ts`
- `gateway/client/runner.ts`

## 7. Force-Run Semantics

`POST /cron/jobs/{id}/run` now:

1. Executes job
2. Records run history
3. Applies normal result state transitions (`applyResult`) including next-run recomputation / one-shot cleanup
4. Signals scheduler wake

This aligns with OpenClaw's `run(..., mode="force")` behavior more closely than the prior "record-only" implementation.

## 8. Error Handling and Resilience

`ExecuteAndRecordJob` activity is wrapped defensively:

- Execution/storage errors are converted into error run records when possible
- Activity returns a result instead of crashing the whole fanout cycle

This reduces orchestration-wide failure risk from a single job failure.

## 9. OpenClaw Parity Matrix

### 9.1 Aligned

- Schedule kinds: `at`, `every`, `cron`
- Backoff progression for consecutive failures
- One-shot disable/delete handling
- Deterministic cron staggering
- Run history persistence
- Session-target and payload-kind invariants
- Durable equivalent of scheduler loop + periodic health recovery

### 9.2 Intentional platform differences

- OpenClaw scheduler is in-process timer loop; AgentForEach uses Durable orchestration
- OpenClaw persistence is local files; AgentForEach uses Cosmos containers

- OpenClaw's heartbeat is a per-agent timer; AgentForEach's heartbeat queue is flushed by the shard scheduler

## 10. Key Files

- `gateway/cron/types.ts`
- `gateway/cron/store.ts`
- `gateway/cron/schedule.ts`
- `gateway/cron/executor.ts`
- `gateway/cron/orchestrator.ts`
- `gateway/cron/api.ts`
- `gateway/cron/tools.ts`
- `gateway/handlers/cron-signal.ts`

## 11. Operational Notes

- Scheduler runs as sharded Durable instances (`<prefix>` for shard 0, `<prefix>-{shardId}` for shard > 0; the prefix is `cron.scheduler.instanceIdPrefix`).
- Due-job and wake queries are shard-scoped through `cron-due-index`. Jobs created before the index existed are picked up by `POST /cron/admin/backfill-due-index` (run once), or by the legacy cross-partition sweep if `CRON_LEGACY_SWEEP=true`.
- Default shard count is `8` (`agentforeach:cronSchedulerShards` / `CRON_SCHEDULER_SHARDS`). Raise it as job volume grows; don't lower it on a live deployment.
- Scheduler control endpoints (`/cron/status`, `/cron/start`) require the **admin role** (`auth.settings.adminRole`, default `"admin"`); the scheduler itself is started by the `CronSchedulerHealthCheck` timer, so ordinary users never need them.
- `cron.enabled: false` removes the whole `/cron/*` HTTP API (the scheduler, tools and delivery keep working).
- `POST /cron/jobs/{id}/run` respects the job's `expiresAt` and `maxRuns` (409 when exceeded).
- Delivery only goes to the job owner's own accounts: push, a channel account linked to the owner, or the chat the job was created from. A job whose recipient is refused is disabled before it runs, and the owner is told by push.
- `PATCH /cron/jobs/{id}` accepts only user-settable fields; scheduler state can't be changed through the API.
