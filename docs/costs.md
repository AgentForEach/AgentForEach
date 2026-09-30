# What it costs

A deployment has three kinds of cost: **model tokens** for every turn, the **platform** (Azure) for every turn, and **storage** for every user. Model tokens are most of the bill. The platform adds about one to two cents per user per month, and a user who isn't talking to their agent costs only storage.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/costs-dark.svg">
  <img alt="100,000 users for a month. A machine per user: about $772,340. AgentForEach: about $14,292, of which $1,152 is the platform and the rest model tokens. Both include up to $13,140 of model tokens." src="assets/costs-light.svg">
</picture>

The saving comes from what an agent does all day: almost nothing. It wakes for a message or a scheduled job, works for about 0.7 s of platform time plus the model call, and goes back to storage.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/day-dark.svg">
  <img alt="One user's day. A machine per user is billed for all 24 hours. With AgentForEach the agent wakes only for a scheduled reminder and a handful of messages, each about 0.7 seconds of platform work plus model tokens; in between it costs only storage." src="assets/day-light.svg">
</picture>

These are estimates from [`scripts/cost-model.mjs`](../scripts/cost-model.mjs). Every assumption below is a flag, so you can run it with your own numbers:

```bash
node scripts/cost-model.mjs --users 250000 --turns 90 --online 0.1
```

## Estimates

Each user sends 60 turns a month (about two a day), and 5% of users are connected at the busiest moment. Prices are Azure list prices for East US from the Azure Retail Prices API on 29 September 2026, after the monthly free grants.

| | 10,000 users | 100,000 users | 1,000,000 users |
|---|---|---|---|
| Turns a month | 600,000 | 6 million | 60 million |
| Functions compute | $95 | $147 | $1,497 |
| Cosmos DB requests | $30 | $300 | $3,000 |
| Cosmos DB storage | $8 | $75 | $750 |
| Web PubSub | $49 (1 unit) | $245 (5 units) | $2,449 (50 units) |
| Logs (Log Analytics) | $16 | $265 | $2,749 |
| Durable Functions task hub | $12 | $120 | $1,200 |
| **Platform** | **$210** | **$1,152** | **$11,645** |
| Platform per user | 2.1¢ | 1.2¢ | 1.2¢ |
| Model tokens | $1,032–1,314 | $10,320–13,140 | $103,200–131,400 |
| **Total a month** | **$1,242–1,524** | **$11,472–14,292** | **$114,845–143,045** |
| For comparison: a machine per user | $75,920 | $759,200 | $7,592,000 |

- **Model tokens are 83–92% of the total.** The choice of model and how much context each turn sends matter far more than the infrastructure.
- **An idle user costs about $0.0008 a month**: 3 MB of Cosmos DB storage. Idle users run no scheduled work unless they set reminders or heartbeat tasks.
- **A machine per user** is priced as the smallest general-purpose VM (B1s, $7.59 a month) before it does any work. The model tokens come on top of that, the same as for AgentForEach.

## Assumptions

| Input | Default | Source |
|---|---|---|
| Turns per user per month | 60 | Assumption; set `--turns` |
| Share of users connected at the peak | 5% | Assumption; set `--online`. Drives Web PubSub units |
| Model cost per 1,000 turns | $1.72–2.19 | **Measured** with GPT-5.6 Luna, 11.6k input tokens per turn ([Benchmarks](Benchmarks.md)) |
| Turn duration | 5.4 s | **Measured**, p50 with GPT-5.6 Luna |
| Turns one instance runs at once | 12 | **Measured**: about 84 turns in flight on 7 instances at 1,000 users |
| Cosmos DB request units per turn | 200 | **Estimated** from the reads, queries and writes a turn performs (range 150–300); not yet measured |
| Web PubSub messages per turn | 16 | From the code: text is sent in 400 ms batches, plus a start and a final event |
| Log data per turn | 20 KB | Estimated: about 10 app log lines and 4 requests; sampling lowers it under load |
| Task hub storage operations per turn | 50 | Estimated for the Azure Storage Durable Functions backend |
| Storage per user | 3 MB | Estimated: memories and episodes keep their 1,536-dimension embeddings |

At 150 or 300 request units per turn instead of 200, the 100,000-user platform cost is $1,077 or $1,302.

## How each part is priced

- **Functions (Flex Consumption):** billed for an instance's memory (2 GB) while it is running at least one turn, at $0.000026 per GB-second, plus $0.40 per million executions (a turn is about four). At low volume an instance often runs a single turn; at high volume turns share instances, which is why the cost per user falls as users grow.
- **Cosmos DB:** serverless at $0.25 per million request units and $0.25 per GB-month. Messages expire after 7 days and sessions after 24 idle hours; long-term memories and episodes are kept.
- **Web PubSub:** Standard units at $1.61 a day, each allowing 1,000 connections and 1 million messages a day, then $1 per million messages.
- **Logs:** $2.30 per GB ingested after 5 GB a month.
- **Durable Functions task hub:** Azure Storage queue operations at $0.004 per 10,000.

## Running at a million users

The estimate assumes the deployment is set up for that scale:

- **Switch Cosmos DB to autoscale** (`agentforeach:cosmosCapacity: autoscale`). Serverless caps throughput per container and has no throughput SLA; it suits development and small deployments. The mode is fixed when the account is created. At steady load, autoscale throughput usually costs less than paying per request unit.
- **Raise the Log Analytics daily cap** (`agentforeach:logDailyCapGb`, 5 GB by default). Beyond the cap, logs are dropped until the next day.
- **Size Web PubSub for your peak connections** (1,000 per unit) and check Functions' maximum instance count (`agentforeach:functionMaxInstances`, 100 by default).

## Not included

- **Compaction:** every 20 turns or so a session is summarised by a smaller model (gpt-5-mini by default).
- **Embeddings** for memory recall and storage (`text-embedding-3-small`): a few dozen tokens per turn.
- **Sandboxes, AI Search and other optional services**, which you pay for only when they are enabled and used.
- **Small fixed costs:** Key Vault, alert rules, the scheduler's background work and network egress. Together these are a few dollars a month.
- **Always-ready instances**, if you add them to cut tail latency.

## Measure your own

1. Run a load test against a scratch stack ([Benchmarks](Benchmarks.md#running-it)).
2. In Cost Management, filter to the resource group for the test window and group by resource.
3. For Cosmos DB, the **Total Request Units** metric divided by completed turns gives your request units per turn. Pass it back to the model with `--ru`.
