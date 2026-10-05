# FAQ

**Is AgentForEach a model?**
No. It runs the agents and calls a model you choose: OpenAI (Responses API), Azure OpenAI, Anthropic, Amazon Bedrock or any OpenAI-compatible provider, with failover between them.

**Does it include an app?**
It is the backend. Your app talks to its HTTP API and receives replies over Web PubSub; the [web chat sample](../examples/web-chat/) shows the protocol in one HTML file. Telegram and WhatsApp work without an app.

**Which cloud does it run on?**
Azure by default: Functions (Flex Consumption), Durable Functions, Cosmos DB, Web PubSub and Container Apps, created by one Pulumi program. [Cloudflare](Cloudflare.md) as well: Workers, Durable Objects, your PostgreSQL through Hyperdrive, R2 and Containers. And [AWS](AWS.md), in preview and to be validated live on a fresh deployment: Lambda, Lambda durable functions, AppSync Events, S3, Bedrock AgentCore and your PostgreSQL, created by one Pulumi program. Google Cloud is next: the design needs serverless functions, durable orchestration, a database and a real-time messaging service, and it has all four ([Platforms](Platforms.md)). Follow the [roadmap](../ROADMAP.md) or say what you need in [Discussions](https://github.com/agentforeach/agentforeach/discussions).

**How far does it scale?**
As far as the Azure services underneath it. Nothing in the design is per user or global, so every ceiling is a limit Microsoft publishes or a setting in this repo. The limits, the settings and what to change first are in [Architecture: Scaling](Architecture.md#scaling); what has been measured is in [Benchmarks](Benchmarks.md).

**What does it cost to run?**
Model tokens are most of it. The platform adds a small cost per turn, and an idle user costs only storage. See [What it costs](costs.md) for the estimate at 10,000, 100,000 and 1,000,000 users.

**How are users kept apart?**
Every read and write is scoped to the signed-in user (partition keys and ownership checks), channel identities resolve only through pairing, and code runs in a per-user sandbox. The model and its limits are in [SECURITY.md](../SECURITY.md).

**Can I run it just for myself?**
Yes, in [single-user mode](Identity.md#deployment-scenarios). It is built for many users, though.

**Is it ready for production?**
It is in preview: load-tested and security-reviewed, but not yet run in many production deployments.
