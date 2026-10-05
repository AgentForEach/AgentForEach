# AgentForEach docs

## Start here

| Doc | What it covers |
|---|---|
| [Getting started](getting-started.md) | Deploy to Azure, sign users in, run locally |
| [Cloudflare](Cloudflare.md) | Deploy on Cloudflare Workers: Hyperdrive to your Postgres, R2, Durable Objects, limits, running locally |
| [AWS](AWS.md) | Deploy on AWS (preview): Lambda, durable functions, AppSync Events, S3, AgentCore sandboxes, your PostgreSQL; IAM, network, costs, what was validated |
| [What it costs](costs.md) | Monthly cost at 10,000 to 1,000,000 users, the assumptions, and a script to run your own |
| [Benchmarks](Benchmarks.md) | Load-test method, results and how to measure your own stack |
| [Upgrading](UPGRADING.md) | Behaviour changes an operator needs to know about, newest first |
| [FAQ](FAQ.md) | Short answers: models, apps, clouds, scale, cost, isolation |

## How it works

| Doc | What it covers |
|---|---|
| [Architecture](Architecture.md) | The stateless Function App, how a turn flows, the real-time protocol, how far it scales |
| [Platforms](Platforms.md) | The six cloud-neutral ports, the Azure, Cloudflare and AWS packs, and how to add a cloud |
| [Realtime protocol](Realtime-Protocol.md) | The WebSocket protocol every realtime provider speaks: frames, acks, groups, relay |
| [Comparisons](Comparisons.md) | A machine per user, agent frameworks, Cloudflare Agents and Letta |
| [Database](Database.md) | Cosmos DB or PostgreSQL behind the storage SDK: settings, migrations, what differs |
| [Sessions and messages](Session-management.md) | How conversations are stored, kept private per user and compacted |
| [Identity](Identity.md) | Mapping channel senders to users, account linking and pairing |
| [Easy Auth](EasyAuth.md) | Signing users in with App Service authentication |

## Features

| Doc | What it covers |
|---|---|
| [Scheduler](Crons.md) | Reminders, recurring jobs and heartbeats on the sharded scheduler |
| [Scheduler internals](Cron-Durable-Cosmos.md) | Implementation and operations reference for the scheduler on Durable Functions and Cosmos DB |
| [Human in the loop](HITL.md) | Forms and approvals that pause a run and resume it later |
| [Channels](Channel.md) | Telegram and WhatsApp: webhooks, security model, identity resolution |
| [WhatsApp](Channel-WhatsApp.md) | WhatsApp Cloud API setup and specifics |
| [Skills](Skills_Architecture.md) | `SKILL.md` instruction files, per-user settings and credential handling |
| [Sandboxes](Sandbox.md) | Per-user code sandboxes and their two backends |
| [Sandbox backends compared](Sandbox-Migration.md) | Why ACA Sandboxes replaced Dynamic Sessions as the default, and the risks |
| [Sandboxes on Google Cloud](GCP_Evaluation.md) | GKE Agent Substrate and GKE Agent Sandbox tested as alternatives to ACA Sandboxes, with verdicts |
| [Sandboxes on Cloudflare](Cloudflare_Evaluation.md) | Cloudflare Containers tested as an alternative to ACA Sandboxes: starts, snapshots, egress and feedback for the Containers team |
| [Sandboxes on AWS](AWS_Evaluation.md) | AWS Bedrock AgentCore Runtime tested as an alternative to ACA Sandboxes: sessions, session storage, egress and a five-platform comparison |
| [D1 on Cloudflare](D1_Evaluation.md) | Why the coming Cloudflare deployment will use PostgreSQL through Hyperdrive, not D1 or Vectorize: vector search measured, throughput, transactions |
| [DynamoDB on AWS](DynamoDB_Evaluation.md) | Shared storage SDK compatibility against Cosmos DB and PostgreSQL: queries, TTL, patches and search; why PostgreSQL is recommended and what remains untested |
| [Browser](Browser.md) | A real browser for the agent, inside each user's sandbox |
| [Knowledge](Knowledge.md) | The optional, deployment-wide Azure AI Search library |

## Project

[Roadmap](../ROADMAP.md) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md) · [Support](../SUPPORT.md)
