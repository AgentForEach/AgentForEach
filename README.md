<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img alt="AgentForEach: the open-source brain for personal AI agents. One agent for each of your users, serverless, so an idle agent costs only storage." src="docs/assets/banner-light.svg">
</picture>

<p align="center"><code>users.forEach(user =&gt; agent(user))</code></p>

<p align="center"><b>Give every user of your app their own AI agent.</b> It remembers them, works on a schedule while they're away and answers on web, Telegram or WhatsApp. It's serverless, so an idle agent costs only storage, and the platform adds about 1–2¢ per user a month.</p>

<p align="center">Runs on Azure today. AWS and Google Cloud are next.</p>

<p align="center">
  <a href="https://github.com/agentforeach/agentforeach/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/agentforeach/agentforeach/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-151827"></a>
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-F29A1F">
  <img alt="1,100+ tests" src="https://img.shields.io/badge/tests-1%2C100%2B-151827">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Node%2022-151827">
</p>

<p align="center">
  <a href="docs/getting-started.md"><b>Get started</b></a> ·
  <a href="#how-it-compares">How it compares</a> ·
  <a href="docs/Architecture.md">Architecture</a> ·
  <a href="docs/Benchmarks.md">Benchmarks</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

<p align="center"><sub>Created by <a href="https://github.com/mohit67890">Mohit Garg</a> · <a href="https://x.com/mohitt_garg">@mohitt_garg</a></sub></p>

## What it is

A personal AI agent product is much more than a model and a chat window. Behind apps like Muse, Grok and Dots, every user has an agent that remembers them, works on a schedule while they're away, uses tools, runs code, asks before it acts and answers on whichever channel they use. The company runs all of those agents at once, for every user, without a server for each.

**AgentForEach is that backend, open source. You build the product; it runs the agents.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/stack-dark.svg">
  <img alt="Three layers. You build your product: app and brand, onboarding and sign-in, the agent's personality, skills and knowledge, pricing, your users. AgentForEach runs the brain: one agent per user, sessions and history, long-term memory, reminders and heartbeats, the tool loop, model failover, streaming to every device, approvals, per-user sandboxes, web, Telegram and WhatsApp, and tenant isolation. It runs on Azure serverless services created by one Pulumi program: Functions, Durable Functions, Cosmos DB, Web PubSub, Container Apps, AI Search and Key Vault." src="docs/assets/stack-light.svg">
</picture>

## Who it's for

Teams shipping a product where every user gets their own agent:

- **Startups building a personal-agent app.** Your own Muse for a market, a language or a niche, without spending months on the platform first.
- **Product teams adding an agent to an app they already have.** A tutor for every student, a coach for every client, a concierge for every customer.

It also runs in **single-user mode** for one person's own agent ([setup](docs/Identity.md#deployment-scenarios)). That works, but it isn't what the architecture is for: one agent doesn't need a platform built for millions.

## Your agent in code

You configure the agent and teach it skills; you don't write the platform. Three pieces:

**Who the agent is.** Every user's agent is built from these documents (excerpt). By default they stay as you write them, and a change reaches every user; with `"prompt": { "type": "dynamic" }` each user's agent can update its own copy. What it learns about each user lives in their own profile and memories either way:

```jsonc
// gateway/config/agentforeach.json
"templates": {
  "IDENTITY": { "name": "Tara", "emoji": "📚", "role": "Study coach", "vibe": "Patient and encouraging" },
  "SOUL": { "coreTruths": ["Find out what the student already knows before explaining anything."] }
}
```

**What it can do.** A skill is a Markdown file. Each user adds their own credentials, which the platform injects so the model never sees them ([Skills](docs/Skills_Architecture.md)):

```markdown
---
id: courses
name: Courses
description: Look up the student's courses, grades and deadlines
category: education
credentials: [{"key":"LMS_TOKEN","label":"Your LMS token","hosts":["lms.example.com"],"header":"Authorization","format":"Bearer {value}"}]
---
Call `https://lms.example.com/api/me/courses` with `Authorization: Bearer $LMS_TOKEN`.
```

**How your app talks to it.** One request per message, as the signed-in user; the reply streams to every device they have open:

```js
await fetch(`${API}/api/chat`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ message: "Remind me to revise chapter 3 at 7pm" }),
}); // 202 { runId, sessionId }; the reply arrives over Web PubSub
```

Memory, the reminder at 7pm, the tool loop, approvals and the per-user sandbox come with the platform.

## How it's different

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/day-dark.svg">
  <img alt="One user's day. A machine per user is billed for all 24 hours. With AgentForEach the agent wakes only for a scheduled reminder and a handful of messages, each about 0.7 seconds of platform work plus model tokens; in between it costs only storage." src="docs/assets/day-light.svg">
</picture>

The usual way to give each user an agent is a machine or container per user: simple at a hundred users, a fleet to run at a million, and billed while every user sleeps. AgentForEach keeps nothing in memory between turns. Each turn loads what it needs from Cosmos DB, calls the model and streams the reply, so every agent shares **one serverless deployment** that scales to zero and back out.

## How it compares

| | Self-hosted personal agents (a machine per user) | Agent frameworks | AgentForEach |
|---|---|---|---|
| Built for | One person running their own agent | Developers writing agent logic | Companies running an agent for every user |
| Users per deployment | One owner | Whatever you build | Any number, on one deployment |
| An idle user costs | A machine that stays on | Whatever you build | Storage only |
| 1M users means | 1M machines to run, patch and monitor | Whatever you build | The same deployment, scaled out |
| Per-user memory, schedules and sandboxes | For the one owner | Build it yourself | Built in, isolated per tenant in every data path |
| Always-on work (reminders, heartbeats) | A process per user | Build it yourself | A sharded scheduler on Durable Functions |
| Channels and identity linking | The owner's own accounts | Build it yourself | Web and apps, Telegram and WhatsApp, with pairing |
| Infrastructure | A machine or container | Bring your own | One Pulumi program, fully serverless |

**Why not Cloudflare Agents?** [Cloudflare Agents](https://developers.cloudflare.com/agents/) gives each agent a Durable Object that hibernates when idle, the same economics as AgentForEach. It hands you strong primitives (state, schedules, WebSockets) and you build the product on them: long-term memory with recall, heartbeats, approvals, Telegram and WhatsApp with identity pairing, per-user sandboxes with credential injection. AgentForEach ships those as one working system that you configure. If your stack is already on Cloudflare, it's a good place to build.

**Why not Letta?** [Letta](https://github.com/letta-ai/letta) is an open-source server for stateful agents with a deep memory model. Its agents live in a Letta server backed by Postgres, which you run and scale, or you use Letta's cloud. AgentForEach is built around what a per-user product needs beyond memory (channels, identity linking, schedules, tenant isolation) on infrastructure that scales to zero.

**Why not an agent framework?** LangGraph, Mastra or the OpenAI Agents SDK define how an agent thinks. Where each user's state lives, what wakes their agent at 7pm and how a million of them share one deployment is left to you. That part is what AgentForEach is.

## Built to scale, and measured

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/stats-dark.svg">
  <img alt="3,000 of 3,000 turns completed with 1,000 users arriving in 3 minutes; 0.12 s to accept a message; about $2 model cost per 1,000 turns with GPT-5.6 Luna; zero servers per user." src="docs/assets/stats-light.svg">
</picture>

The design has no per-user servers and nothing held in memory between turns, so it is built to scale to millions. What we have measured so far is 1,000 users on one deployment, with a real model: 4,799 of 4,800 turns completed with GPT-5.6 Luna, and about 0.7 s of platform work per turn. Sandboxes, channels and more than a few hundred users active at once are not measured yet. Method, charts and raw results: [Benchmarks](docs/Benchmarks.md).

## What it costs

Model tokens are most of the bill. **The platform adds about 1–2¢ per user a month, and an idle user costs about $0.0008 a month of storage.** For 100,000 users that is about $1,152 of platform a month next to $10,000–13,000 of model tokens.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/costs-dark.svg">
  <img alt="100,000 users for a month. A machine per user: about $772,340. AgentForEach: about $14,292, of which $1,152 is the platform and the rest model tokens. Both include up to $13,140 of model tokens." src="docs/assets/costs-light.svg">
</picture>

The comparison is the smallest VM per user, the way self-hosted personal agents usually run. The estimate for 10,000, 100,000 and 1,000,000 users, every assumption behind it and a script to run with your own numbers are in [What it costs](docs/costs.md).

## What companies build with it

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/icons/use-app.svg" width="56" alt=""><br>
      <b>Your own Muse</b><br>
      A consumer personal-agent app under your brand. Every user's agent remembers them, works while they're away and follows up on its own.
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/icons/use-concierge.svg" width="56" alt=""><br>
      <b>An agent for every customer</b><br>
      Give each customer of your bank, telco or store their own agent in your app or on WhatsApp, with their history and an approval step before anything that matters.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/icons/use-tutor.svg" width="56" alt=""><br>
      <b>A tutor for every student</b><br>
      A vertical agent product: memory of what each student knows, reminders to practise, a sandbox to run their code and your course material as a knowledge base.
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/icons/use-team.svg" width="56" alt=""><br>
      <b>An assistant for every employee</b><br>
      Roll out an agent to everyone in your company, with skills that call your internal APIs. Credentials are injected by the platform and never reach the model.
    </td>
  </tr>
</table>

## What's in the box

<table>
  <tr>
    <td width="33%" valign="top"><img src="docs/assets/icons/runtime.svg" width="32" alt=""><br><b>Agent runtime</b><br>Tool loop on OpenAI (Responses API), Azure OpenAI, Anthropic and OpenAI-compatible providers, with failover, streaming, deadlines and per-tool error isolation.</td>
    <td width="33%" valign="top"><img src="docs/assets/icons/memory.svg" width="32" alt=""><br><b>Memory</b><br>Long-term memories with hybrid vector and full-text search, episodes, session digests and compaction.</td>
    <td width="33%" valign="top"><img src="docs/assets/icons/schedule.svg" width="32" alt=""><br><b>Scheduled work</b><br>Reminders, recurring jobs and heartbeats on a sharded Durable Functions scheduler.</td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/assets/icons/approval.svg" width="32" alt=""><br><b>Human in the loop</b><br>Forms and approvals that pause a run and resume it later.</td>
    <td valign="top"><img src="docs/assets/icons/channels.svg" width="32" alt=""><br><b>Channels</b><br>Web and apps over Web PubSub, Telegram and WhatsApp, with identity linking and pairing.</td>
    <td valign="top"><img src="docs/assets/icons/sandbox.svg" width="32" alt=""><br><b>Skills and sandboxes</b><br>Per-user code sandboxes on Azure Container Apps. Credentials are injected at the egress proxy and never enter the sandbox.</td>
  </tr>
  <tr>
    <td valign="top"><img src="docs/assets/icons/knowledge.svg" width="32" alt=""><br><b>Knowledge</b><br>An optional Azure AI Search index for reference documents.</td>
    <td valign="top"><img src="docs/assets/icons/isolation.svg" width="32" alt=""><br><b>Multi-tenant safety</b><br>Tenant-scoped data, SSRF-safe fetching, rate limits, per-session run leases, managed identities, Key Vault secrets and pseudonymised logs.</td>
    <td valign="top"><img src="docs/assets/icons/infra.svg" width="32" alt=""><br><b>Infrastructure as code</b><br>One Pulumi program creates the whole stack.</td>
  </tr>
</table>

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    App[App / Web]
    TG[Telegram]
    WA[WhatsApp]
  end
  App -- "POST /api/chat → 202" --> HTTP
  App <-. "reply stream" .-> WPS[Web PubSub]
  TG --> HTTP
  WA --> HTTP
  subgraph Functions["Azure Functions (Flex Consumption)"]
    HTTP[HTTP handlers] --> Turn[ChatTurn orchestration]
    Turn --> Runner[Agent runner]
    Cron[Sharded scheduler] --> Runner
  end
  Runner --> LLM[(Model providers)]
  Runner --> Cosmos[(Cosmos DB)]
  Runner --> WPS
  Runner --> SBX[Container Apps Sandboxes]
  Runner --> Search[(AI Search)]

  classDef awake fill:#FFB23F,stroke:#D27400,color:#2A1700
  classDef store fill:#C9CEDC,stroke:#8F95AD,color:#151827
  class HTTP,Turn,Runner,Cron awake
  class Cosmos,Search store
```

A chat message is accepted in the HTTP request (auth, validation, rate limit) and handed to a Durable orchestration, so no turn is bound by the HTTP timeout and an instance recycled mid-turn doesn't lose it. The runner takes a short, renewed lease on the session so a conversation never runs two turns at once, and the reply streams to every device the user has connected.

More: [Architecture](docs/Architecture.md) · [Sessions](docs/Session-management.md) · [Scheduler](docs/Crons.md) · [Human in the loop](docs/HITL.md) · [Identity](docs/Identity.md) · [Channels](docs/Channel.md) · [Sandboxes](docs/Sandbox.md) · [Knowledge](docs/Knowledge.md)

## Quick start

> **Status: preview.** The architecture is load-tested, the security model reviewed and the code has 1,100+ tests, but it hasn't run in many production deployments yet. Read [SECURITY.md](SECURITY.md) before exposing it to users.

**Try it in one command.** Open the repo in GitHub Codespaces, which has every tool installed, and run the quickstart. It asks for an Azure sign-in (on a subscription where you can assign roles, as below) and an OpenAI API key, deploys a trial stack and prints a login for the [web chat sample](examples/web-chat/).

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/AgentForEach/AgentForEach)

```bash
./scripts/quickstart.sh
```

The trial signs users in with tokens the script makes; `pulumi destroy` removes everything. To deploy step by step, or for a stack with real sign-in:

You need Node 22, [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) 4, the Azure CLI, [Pulumi](https://www.pulumi.com/docs/install/), and an Azure subscription where you can assign roles (Owner, or Contributor plus User Access Administrator): the stack grants its own identities access to storage, Key Vault and Cosmos DB.

**1. Create the Azure resources**

```bash
npm ci && az login
cd infra && pulumi stack init dev
pulumi config set azure-native:location eastus
pulumi config set agentforeach:nameSuffix $(openssl rand -hex 3)
pulumi config set --secret agentforeach:openaiApiKey sk-...
pulumi up && cd ..
```

**2. Choose how your users sign in.** Set `auth.providers` in [`gateway/config/agentforeach.json`](gateway/config/agentforeach.json): App Service authentication, JWT, API keys or a trusted proxy. A fresh stack trusts no one, so every API call returns 401 until you do. The web chat sample sends a bearer token, so use JWT to try it ([a test token in two steps](docs/getting-started.md#try-it-with-a-test-token)); API keys suit server-to-server calls.

**3. Deploy the gateway.** The config file ships with the code, so run this again whenever you change it:

```bash
./scripts/deploy-gateway.sh dev
```

**4. Say hi.** Open the [web chat sample](examples/web-chat/) with your Function App URL and a token from the provider you chose.

[Getting started](docs/getting-started.md) covers running locally, Azure OpenAI, channels and every setting.

## FAQ

**Is AgentForEach a model?**
No. It runs the agents and calls a model you choose: OpenAI (Responses API), Azure OpenAI, Anthropic or any OpenAI-compatible provider, with failover between them.

**Does it include an app?**
It is the backend. Your app talks to its HTTP API and receives replies over Web PubSub; the [web chat sample](examples/web-chat/) shows the protocol in one HTML file. Telegram and WhatsApp work without an app.

**Which cloud does it run on?**
Azure today: Functions (Flex Consumption), Durable Functions, Cosmos DB, Web PubSub and Container Apps, created by one Pulumi program. AWS and Google Cloud are next. The design needs serverless functions, durable orchestration, a document database and a real-time messaging service, and both clouds have all four. Follow the [roadmap](ROADMAP.md) or say which one you need in [Discussions](https://github.com/agentforeach/agentforeach/discussions).

**What does it cost to run?**
Model tokens are most of it. The platform adds a small cost per turn, and an idle user costs only storage. See [What it costs](docs/costs.md) for the estimate at 10,000, 100,000 and 1,000,000 users.

**How are users kept apart?**
Every read and write is scoped to the signed-in user (partition keys and ownership checks), channel identities resolve only through pairing, and code runs in a per-user sandbox. The model and its limits are in [SECURITY.md](SECURITY.md).

**Can I run it just for myself?**
Yes, in [single-user mode](docs/Identity.md#deployment-scenarios). It is built for many users, though.

**Is it ready for production?**
It is in preview: load-tested and security-reviewed, but not yet run in many production deployments.

## Documentation

- **Start:** [Getting started](docs/getting-started.md) · [What it costs](docs/costs.md) · [Benchmarks](docs/Benchmarks.md) · [Upgrading](docs/UPGRADING.md)
- **How it works:** [Architecture](docs/Architecture.md) · [Sessions and messages](docs/Session-management.md) · [Identity](docs/Identity.md)
- **Features:** [Scheduler](docs/Crons.md) · [Human in the loop](docs/HITL.md) · [Channels](docs/Channel.md) · [Skills](docs/Skills_Architecture.md) · [Sandboxes](docs/Sandbox.md) · [Knowledge](docs/Knowledge.md)

The full index is in [docs/README.md](docs/README.md).

## Community

- **Questions and ideas:** [GitHub Discussions](https://github.com/agentforeach/agentforeach/discussions)
- **Bugs and deployment problems:** [open an issue](https://github.com/agentforeach/agentforeach/issues/new/choose)
- **Security issues:** report privately, never in public issues; see [SECURITY.md](SECURITY.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) · **What's next:** [ROADMAP.md](ROADMAP.md)

## License

[Apache-2.0](LICENSE). Copyright 2026 Mohit Garg and AgentForEach contributors. Third-party notices are in [NOTICE](NOTICE).

AgentForEach and the AgentForEach logo are trademarks of Mohit Garg. The license covers the code, not the name or logo (Apache-2.0, section 6): a fork or a product built on AgentForEach needs its own name.

Muse, Grok and Dots are products of Meta, xAI and OpenAI. AgentForEach is an independent project and is not affiliated with them.
