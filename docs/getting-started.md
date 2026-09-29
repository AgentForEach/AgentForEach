# Getting started

Deploy AgentForEach to Azure, let users sign in, and talk to your first agent. Then run it locally for development.

Prerequisites: Node 22, [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) 4, the Azure CLI, and [Pulumi](https://www.pulumi.com/docs/install/).

## Deploy to Azure

```bash
npm ci
az login
cd infra
pulumi stack init dev
pulumi config set azure-native:location eastus
pulumi config set agentforeach:nameSuffix $(openssl rand -hex 3)   # makes the global resource names yours
pulumi config set --secret agentforeach:openaiApiKey sk-...     # or an Azure OpenAI key; see below
pulumi up                                                 # see Pulumi.example.yaml for every setting
cd ..
./scripts/deploy-gateway.sh dev
```

One Pulumi program creates everything: the Function App (Flex Consumption), Cosmos DB, Web PubSub, Key Vault, storage and the optional sandbox and search resources. Every infrastructure setting is listed in [`infra/Pulumi.example.yaml`](../infra/Pulumi.example.yaml).

### Use Azure OpenAI instead of OpenAI

Set `llms.providers.openai.baseUrl` in [`gateway/config/agentforeach.json`](../gateway/config/agentforeach.json) to `https://<resource>.openai.azure.com/openai/v1/`, and use the deployment name as the model name.

## Let users sign in

Configure `auth.providers` in `agentforeach.json`: App Service authentication ([Easy Auth](EasyAuth.md)), JWT, API keys or a trusted proxy. Providers are tried in order and the first match wins.

**Until you do, every API call returns 401.** A fresh stack trusts no one.

## Talk to your agent

Open the [web chat sample](../examples/web-chat/) with your Function App URL and a bearer token from the provider you configured. If you restricted CORS, add the page's origin to `agentforeach:corsAllowedOrigins`.

## Add channels

Telegram and WhatsApp are off until configured. See [Channels](Channel.md) and [WhatsApp](Channel-WhatsApp.md); users link a channel to their account through [pairing](Identity.md).

## Run locally

Durable Functions needs a storage emulator, and the runtime needs a Cosmos DB account (the Cosmos emulator lacks vector search). A serverless account costs nothing while idle:

```bash
docker run -d -p 10000-10002:10000-10002 mcr.microsoft.com/azure-storage/azurite   # or: npx azurite
az cosmosdb create -g <rg> -n <account> --capabilities EnableServerless EnableNoSQLVectorSearch

npm ci
cp gateway/local.settings.example.json gateway/local.settings.json
# set COSMOS_ENDPOINT and COSMOS_KEY (az cosmosdb keys list -g <rg> -n <account>),
# OPENAI_API_KEY, and AUTH_ALLOW_INSECURE_USER_ID_HEADER=true
cd gateway
npm start                                   # builds, then starts the Functions host on :7071
curl -X POST localhost:7071/api/chat -H 'x-user-id: me' -H 'content-type: application/json' -d '{"message":"hi"}'
```

Locally, turns run inside the HTTP request, containers are created on first use, and `x-user-id` identifies the user (never honoured on Azure). The [web chat sample](../examples/web-chat/) works against the local gateway too.

## Tests

```bash
npm test --workspace @agentforeach/gateway          # unit and integration tests
# load test against a deployed stack: see Benchmarks.md
```

## Configuration

Runtime behaviour lives in [`gateway/config/agentforeach.json`](../gateway/config/agentforeach.json): models, memory, prompts, channels, rate limits, cron and sandboxes. Secrets come from app settings, which the Pulumi program stores in Key Vault. Infrastructure settings are in [`infra/Pulumi.example.yaml`](../infra/Pulumi.example.yaml).

## Next

- [Architecture](Architecture.md): how a turn flows through the platform
- [Benchmarks](Benchmarks.md): load-test your own stack
- [Upgrading](UPGRADING.md): behaviour changes between versions
