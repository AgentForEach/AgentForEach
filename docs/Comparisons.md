# How AgentForEach compares

There are three common ways to give each user of a product an AI agent. They solve different problems.

| | A machine per user (self-hosted personal agents) | An agent framework | AgentForEach |
|---|---|---|---|
| Built for | One person running their own agent | Developers writing agent logic | Companies running an agent for every user |
| Users per deployment | One owner | Up to your hosting | Any number, on one deployment |
| An idle user costs | A machine that stays on | Up to your hosting | Storage only |
| A million users means | A million machines to run, patch and monitor | Infrastructure you design | The same deployment, scaled out |
| Per-user memory, schedules and sandboxes | For the one owner | You build them | Built in, isolated per tenant in every data path |
| Always-on work (reminders, heartbeats) | A process per user | You build it | A sharded scheduler on Durable Functions |
| Channels and identity linking | The owner's own accounts | You build it | Web and apps, Telegram and WhatsApp, with pairing |
| Infrastructure | A machine or container each | Bring your own | One Pulumi program, fully serverless |

## Cloudflare Agents

[Cloudflare Agents](https://developers.cloudflare.com/agents/) gives each agent a Durable Object that hibernates when idle: the same economics as AgentForEach. It hands you strong primitives (state, schedules, WebSockets), and you build the product on them: long-term memory with recall, heartbeats, approvals, Telegram and WhatsApp with identity pairing, per-user sandboxes with credential injection. AgentForEach ships those as one working system that you configure. If your stack is already on Cloudflare, it's a good place to build.

## Letta

[Letta](https://github.com/letta-ai/letta) is an open-source server for stateful agents with a deep memory model. Its agents live in a Letta server backed by Postgres, which you run and scale, or you use Letta's cloud. AgentForEach is built around what a per-user product needs beyond memory (channels, identity linking, schedules, tenant isolation) on infrastructure that scales to zero.

## Agent frameworks

LangGraph, Mastra and the OpenAI Agents SDK define how an agent thinks. Where each user's state lives, what wakes their agent at 7pm and how a million of them share one deployment is left to you. That part is what AgentForEach is.
