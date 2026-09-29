# Roadmap

AgentForEach is in preview. This is what we plan to work on next, roughly in order. None of it has a date; open a [discussion](https://github.com/agentforeach/agentforeach/discussions) if something here matters to you, or if something missing should be here.

## Make it easier to start

- A short demo of an agent at work
- A one-click deploy to Azure
- Local development without an Azure account
- A starter app (web and mobile) that you can rebrand as your own product

## Run on AWS and Google Cloud

AgentForEach started on Azure. The same design (stateless turns, per-user data, durable orchestration, a real-time reply stream) comes to AWS and Google Cloud next, each created by its own infrastructure program.

## Measure more of the platform

The [benchmarks](docs/Benchmarks.md) cover chat, memory and reminders at 1,000 users. Next:

- Sandboxes under load
- Telegram and WhatsApp channels under load
- 10,000 users and more, with thousands active at the same time
- Multi-region deployments

## Harden for production

- More production deployments and the fixes they turn up
- Upgrade notes for every behaviour change ([UPGRADING.md](docs/UPGRADING.md))

## Under consideration

- An [AG-UI](https://github.com/ag-ui-protocol/ag-ui) endpoint, so AG-UI clients can talk to the platform directly
- A browser tool for the agent
- Gmail and Google Calendar connectors
