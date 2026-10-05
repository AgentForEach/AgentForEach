# Getting started

Deploy AgentForEach to Azure, let your users sign in, and talk to your first agent. Then run it locally for development.

On Cloudflare instead? See [Cloudflare](Cloudflare.md).

Prerequisites: Node 22, [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local) 4.15.2 or newer, the Azure CLI, [Pulumi](https://www.pulumi.com/docs/install/), and an Azure subscription where you can assign roles (Owner, or Contributor plus User Access Administrator). `pulumi up` creates role assignments that give the Function App's identities access to storage, Key Vault and Cosmos DB. With Contributor alone it fails with `AuthorizationFailed`.

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
```

One Pulumi program creates everything: the Function App (Flex Consumption), Cosmos DB, Web PubSub, Key Vault, storage and the optional sandbox and search resources. Every infrastructure setting is listed in [`infra/Pulumi.example.yaml`](../infra/Pulumi.example.yaml).

### Use Azure OpenAI instead of OpenAI

Set `llms.providers.openai.baseUrl` in [`gateway/config/agentforeach.json`](../gateway/config/agentforeach.json) to `https://<resource>.openai.azure.com/openai/v1/`, and use the deployment name as the model name.

### Use Amazon Bedrock

The `bedrock` provider calls models through the Bedrock Converse API. It has no API key: it signs requests with the AWS credentials the gateway runs with (an execution role, or the usual `AWS_*` environment variables), in `AWS_REGION`. Add `"bedrock": { "defaultModel": "amazon.nova-lite-v1:0" }` to `llms.providers` (and set `llms.defaultProvider` to `"bedrock"` to make it the default). The AWS SDK (`@aws-sdk/client-bedrock-runtime`) is a development dependency of the gateway, there for local runs and tests, and loaded only when Bedrock is used; to deploy with Bedrock, add it to the gateway's `dependencies`. For embeddings on Bedrock, set `llms.embedding` to `{ "provider": "bedrock", "model": "amazon.titan-embed-text-v2:0" }`: its vectors have 1,024 dimensions, so switching an existing deployment needs new memory and episode containers. Bedrock isn't available on Cloudflare Workers.

## Let users sign in

Configure `auth.providers` in `agentforeach.json`: App Service authentication ([Easy Auth](EasyAuth.md)), JWT, API keys or a trusted proxy. Providers are tried in order and the first match wins.

**Until you do, every API call returns 401.** A fresh stack trusts no one.

The web chat sample sends `Authorization: Bearer <token>`, which the JWT provider reads. The API-key provider reads `x-api-key`; use it for server-to-server calls.

### Try it with a test token

To try the web chat before wiring up a real identity provider, sign tokens yourself. In `agentforeach.json`, enable the `jwt` provider with a shared secret:

```json
{ "type": "jwt", "enabled": true, "algorithm": "HS256", "secret": "$TRIAL_JWT_SECRET",
  "issuer": "agentforeach-trial", "audience": "agentforeach", "userIdClaim": "sub" }
```

Give the Function App the secret, then mint a token for a test user (valid for a day):

```bash
export TRIAL_JWT_SECRET=$(openssl rand -hex 32)
(cd infra && pulumi config set --secret --path 'agentforeach:extraAppSettings.TRIAL_JWT_SECRET' "$TRIAL_JWT_SECRET" && pulumi up)
node -e 'const c=require("crypto"),b=o=>Buffer.from(JSON.stringify(o)).toString("base64url"),n=Math.floor(Date.now()/1e3);const t=b({alg:"HS256",typ:"JWT"})+"."+b({sub:"test-user",iss:"agentforeach-trial",aud:"agentforeach",iat:n,exp:n+86400});console.log(t+"."+c.createHmac("sha256",process.env.TRIAL_JWT_SECRET).update(t).digest("base64url"))'
```

Anyone with the secret can sign in as anyone, so replace this with a real identity provider before your real users arrive.

Then deploy the gateway. `agentforeach.json` is packaged with the code, so deploy again after every change to it:

```bash
./scripts/deploy-gateway.sh dev
```

## Talk to your agent

Open the [web chat sample](../examples/web-chat/) with your Function App URL and a bearer token from the provider you configured. If you restricted CORS, add the page's origin to `agentforeach:corsAllowedOrigins`.

## Add channels

Telegram and WhatsApp are off until you configure them. See [Channels](Channel.md) and [WhatsApp](Channel-WhatsApp.md). Your users link a channel to their account through [pairing](Identity.md).

## Run locally

Use Azure Functions Core Tools **4.15.2 or newer**. Older ones can't start any Durable Functions orchestration: 4.6.0 fails with `Could not load file or assembly 'Microsoft.AspNetCore.Mvc.WebApiCompatShim'`. 4.15.2 with extension bundle 4.38.1 works. Check with `func --version`.

Durable Functions needs a storage emulator, and the runtime needs a database: PostgreSQL with pgvector in Docker is the quickest, or a Cosmos DB account like production (the Cosmos emulator lacks vector search; a serverless account costs nothing while idle). See [Database](Database.md).

```bash
docker run -d -p 10000-10002:10000-10002 mcr.microsoft.com/azure-storage/azurite   # or: npx azurite
docker run -d -e POSTGRES_PASSWORD=pw -p 5432:5432 pgvector/pgvector:pg17
#   or Cosmos: az cosmosdb create -g <rg> -n <account> --capabilities EnableServerless EnableNoSQLVectorSearch

npm ci
cp gateway/local.settings.example.json gateway/local.settings.json
# set DATABASE_PROVIDER=postgres and DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres
#   (or, for Cosmos, COSMOS_ENDPOINT and COSMOS_KEY from az cosmosdb keys list -g <rg> -n <account>),
# OPENAI_API_KEY, and AUTH_ALLOW_INSECURE_USER_ID_HEADER=true
cd gateway
npm start                                   # builds, then starts the Functions host on :7071
curl -X POST localhost:7071/api/chat -H 'x-user-id: me' -H 'content-type: application/json' -d '{"message":"hi"}'
```

Locally, turns run inside the HTTP request, tables or containers are created on first use, and `x-user-id` identifies the user (never honoured on Azure). The [web chat sample](../examples/web-chat/) works against the local gateway too.

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
