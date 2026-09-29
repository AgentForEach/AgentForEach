# Roadmap

AgentForEach is in preview. This is what we plan to work on next, roughly in order. None of it has a date; open a [discussion](https://github.com/agentforeach/agentforeach/discussions) if something here matters to you, or if something missing should be here.

## Measure more of the platform

The [benchmarks](docs/Benchmarks.md) cover chat, memory and reminders at 1,000 users. Next:

- Sandboxes under load
- Telegram and WhatsApp channels under load
- Thousands of users active at the same time, not only arriving over a few minutes
- Multi-region deployments

## Harden for production

- More production deployments and the fixes they turn up
- Upgrade notes for every behaviour change ([UPGRADING.md](docs/UPGRADING.md))

## Under consideration

- An [AG-UI](https://github.com/ag-ui-protocol/ag-ui) endpoint, so AG-UI clients can talk to the platform directly
- A browser tool for the agent
- Gmail and Google Calendar connectors
- A one-click deploy
