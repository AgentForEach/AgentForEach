# Roadmap

AgentForEach is in preview. This is what we plan to work on next, roughly in order. None of it has a date; open a [discussion](https://github.com/agentforeach/agentforeach/discussions) if something here matters to you, or if something missing should be here.

## Make it easier to start

Done: a [one-command quickstart](scripts/quickstart.sh) (with a Codespaces button in the README) and a demo of an agent at work. Next:

- Local development without an Azure account
- A starter app (web and mobile) that you can rebrand as your own product

## Run on more clouds

Done: the [platform layer](docs/Platforms.md). The gateway talks to six cloud-neutral contracts, each with a conformance suite, and a cloud is a pack that implements them. Azure was the first pack and [Cloudflare](docs/Cloudflare.md) is the second. Next:

- AWS and Google Cloud packs, each with its own deploy program ([Adding a cloud](docs/Platforms.md#adding-a-cloud))
- Production deployments on Cloudflare, and the fixes they turn up

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
- More for the [browser](docs/Browser.md): buttons inside frames (cookie banners, payment forms), and handing the browser to the user on Telegram and WhatsApp
- Gmail and Google Calendar connectors
