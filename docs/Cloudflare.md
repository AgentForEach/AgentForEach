# Cloudflare

Deploy AgentForEach on Cloudflare Workers, with your own PostgreSQL behind Hyperdrive and R2 for files. The gateway's code is the same as on Azure; only the platform pack and the entry point change ([Platforms](Platforms.md)).

Prerequisites:
- Node 22.
- A Cloudflare account on the **Workers Paid** plan. The Worker raises its CPU limit to 5 minutes, which the Free plan doesn't allow, and Containers need Paid too.
- A **PostgreSQL** 13+ server with [pgvector](https://github.com/pgvector/pgvector), reachable from the internet. To keep everything on Cloudflare, create a PlanetScale Postgres database from the Cloudflare dashboard (Workers & Pages → Hyperdrive → Create → PlanetScale): it is billed to your Cloudflare account, the smallest node is $5 a month, and its default `postgres` role can create the `vector` extension. Use its direct connection string (port 5432), not the PgBouncer one: Hyperdrive pools connections itself. Neon, Supabase, RDS, Cloud SQL, Azure Database for PostgreSQL or your own server work too. See [Database](Database.md#postgresql).
- A model provider key: OpenAI, Anthropic, or Azure OpenAI.

Two scripts do the work, with `wrangler` (which `npm ci` installs). [By hand](#by-hand) lists what they run, step by step.

## What runs where

| Piece | On Cloudflare | Instead of (Azure) |
|---|---|---|
| The gateway's routes | One Worker, `deploy/cloudflare/worker.ts`, serving the same route table as Azure Functions, at the same paths | Function App |
| Schedules | Cron Triggers (`*/5 * * * *`): the cron scheduler's health check and the database sweep | Timer triggers |
| Chat turns, channel turns, HITL waits, cron runs and scheduler shards | `DurableInstance`: one Durable Object per instance, driven by its alarm | Durable Functions |
| WebSockets to clients | `UserSocket`: one Durable Object per user, with hibernating sockets. Clients connect to `wss://<worker>/realtime/client` | Web PubSub |
| The browser's live view | `Relay`: one Durable Object per handoff, at `wss://<worker>/realtime/relay` | Web PubSub (relay hub) |
| Database | Your PostgreSQL, through Hyperdrive (pooled, one small pool per invocation) | Cosmos DB or PostgreSQL |
| Skill files and sandbox exports | R2 buckets `skills` and `user-exports`, through R2's S3 API (signed download links need it) | Blob Storage |
| Sandboxes | Cloudflare Containers ([below](#sandboxes-on-cloudflare-containers)) | ACA Sandboxes |

Clients don't change. Both clouds speak the same [realtime protocol](Realtime-Protocol.md), so the web chat sample and the browser's live view work unchanged on either. `/negotiate` and `/api/token` return a URL on the Worker's own host.

## Deploy

### Try it: the quickstart

```bash
./scripts/quickstart-cloudflare.sh
```

It asks for a PostgreSQL connection string (PlanetScale through Cloudflare, or a free Neon or Supabase database), your OpenAI key and an R2 API token (below), deploys a trial, and prints the Worker's URL and a login for the [web chat sample](../examples/web-chat/). The trial signs users in with tokens the script makes, and has sandboxes off, so it deploys without the sandbox container (any deploy whose `agentforeach.json` turns sandboxes off does the same). `./scripts/quickstart-cloudflare.sh --token` prints a fresh login later. It is the Cloudflare twin of the Azure quickstart, with the same trial sign-in.

### Deploy your own configuration

```bash
DATABASE_URL='postgres://user:pass@host:5432/agentforeach?sslmode=require' \
  ./scripts/deploy-cloudflare.sh --config path/to/agentforeach.json
```

What it does:
1. Checks that `wrangler` is logged in (or logs in).
2. Builds and runs the bundle check.
3. Creates the Hyperdrive config and the R2 buckets `skills` and `user-exports` if they don't exist. An existing Hyperdrive config is pointed at `DATABASE_URL` (or `HYPERDRIVE_DATABASE_URL`) every time, so the Worker uses the database the schema goes to. If that moves it to another database, the script asks first, unless `DEPLOY_YES` is set. Hyperdrive takes one host, so a multi-host or socket URL needs a single-host `HYPERDRIVE_DATABASE_URL`.
4. Applies `infra/postgres-schema.sql` to `DATABASE_URL`. The password, from the URL's userinfo or its `?password=`, reaches `psql` in a private pgpass file or its environment, never its command line. Encode an `@` in the user name or password as `%40`.
5. Writes `deploy/cloudflare/wrangler.generated.jsonc` (git-ignored) with this deployment's values.
6. Uploads the secrets the Worker doesn't have yet.
7. Deploys, then checks `/api/health`.

It is safe to run again, and that is how you upgrade: it keeps what exists, re-applies the schema and redeploys.

| Variable | What it does |
|---|---|
| `DATABASE_URL` | Required. Your PostgreSQL with pgvector. The schema is applied with it, so its role must be able to create tables (and, the first time, the `vector` extension) |
| `HYPERDRIVE_DATABASE_URL` | What Hyperdrive connects with, if not `DATABASE_URL`: ideally a role that only reads and writes rows |
| `CLOUDFLARE_ACCOUNT_ID` | Needed when your login sees more than one account |
| `PUBLIC_BASE_URL` | The Worker's own https origin, if not `https://<name>.<your subdomain>.workers.dev` |
| `R2_BUCKET_PREFIX` | Prefix for the two buckets, to keep several deployments in one account apart |
| `SKIP_SCHEMA=1` | You manage the schema yourself |
| `DEPLOY_YES=1` | Don't ask: neither before creating anything, nor before moving an existing Hyperdrive config to the database `DATABASE_URL` names (a wrong URL would then move the live Worker) |

Options: `--name <worker>` (default `agentforeach`), `--config <agentforeach.json>`, `--update-secrets` (below), `--dry-run` (build and bundle only; no account needed).

**Secrets.** By default the Worker gets only the secrets it doesn't have yet:
- `REALTIME_SIGNING_KEY` is generated.
- The R2 API token's keys, `OBJECT_STORE_S3_ACCESS_KEY_ID` and `OBJECT_STORE_S3_SECRET_ACCESS_KEY`, are asked for. Create the token in the dashboard first: R2, Manage API tokens, **Object Read & Write** on the two buckets.
- Every `$NAME` your `agentforeach.json` refers to (e.g. `OPENAI_API_KEY`) is uploaded if it is set in your shell. The script lists the ones that aren't set, which is fine for features you have off.

**To change a secret** (a rotated key, a corrected value), set it in your shell and run with `--update-secrets`. Every secret set in your shell then replaces the Worker's, since the Worker's values can't be read back to compare. Without the flag, the script lists the ones it kept. The quickstart always uses it. One secret by hand: `npx wrangler secret put <NAME> --config deploy/cloudflare/wrangler.generated.jsonc`.

If your configuration turns sandboxes on and `CLOUDFLARE_IMAGES_API_TOKEN` isn't set, the script warns that erased users' sandbox snapshots stay for up to 30 days ([Sandboxes](#sandboxes-on-cloudflare-containers)).

### By hand

The same steps without the scripts.

#### 1. Build and check

```bash
npm ci
npm run build:platform && npm run build --workspace @agentforeach/gateway
npm run check:bundle      # fails if any Azure- or AWS-only code would end up in the Worker
npx wrangler deploy --config deploy/cloudflare/wrangler.jsonc --dry-run --outdir /tmp/agentforeach-worker
```

The dry run builds the real bundle (about 7.4 MB, 1.6 MB gzipped) without touching your account.

#### 2. Create the database schema

The Worker never runs DDL in production: `DATABASE_PROVISION` defaults to `false` there. Apply the schema once, and again after every upgrade, before deploying:

```bash
psql "postgres://user:pass@host:5432/agentforeach?sslmode=require" -v ON_ERROR_STOP=1 -f infra/postgres-schema.sql
```

Use a role allowed to create extensions and tables, or have an administrator run `CREATE EXTENSION vector` first ([Database](Database.md#production)). To use a schema other than `public`, set `DATABASE_SCHEMA`.

#### 3. Create Hyperdrive and the R2 buckets

```bash
npx wrangler login
npx wrangler hyperdrive create agentforeach --caching-disabled --connection-string="postgres://user:pass@host:5432/agentforeach?sslmode=require"
npx wrangler r2 bucket create skills
npx wrangler r2 bucket create user-exports
```

Hyperdrive's query cache stays off (`--caching-disabled`; the deploy script sets it too). It would cache nothing of the gateway's today, since every read filters on `now()`, and a cached read could otherwise return rows for up to a minute after they were deleted, including after an account erasure.

Then create an R2 API token in the dashboard: R2, Manage API tokens, with **Object Read & Write** on the two buckets. Keep its **Access Key ID** and **Secret Access Key**: the gateway uses R2's S3 API with them.

#### 4. Write this deployment's wrangler config

The checked-in `deploy/cloudflare/wrangler.jsonc` holds what every deployment shares. Your deployment's own values go into `deploy/cloudflare/wrangler.generated.jsonc`, which is git-ignored:

```bash
node scripts/cloudflare-config.mjs --name agentforeach \
  --hyperdrive-id <the id wrangler hyperdrive create printed> \
  --config-file path/to/agentforeach.json \
  --var OBJECT_STORE_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
  --var PUBLIC_BASE_URL=https://agentforeach.<subdomain>.workers.dev
```

| Value | What it is |
|---|---|
| `--hyperdrive-id` | The Hyperdrive config the Worker reaches your database through |
| `--config-file` | Your `agentforeach.json`. It is bundled into the Worker, so deploy again after every change to it. Default: `gateway/config/agentforeach.json` |
| `OBJECT_STORE_S3_ENDPOINT` | R2's S3 endpoint for your account. The region is `auto` for R2 endpoints |
| `PUBLIC_BASE_URL` | The Worker's https origin, or your custom domain. Links and the realtime URLs are built from it |

The vars every deployment shares, from `wrangler.jsonc`:

| Var | Value |
|---|---|
| `DATABASE_PROVIDER` | `postgres` |
| `DATABASE_SERVER_TIMEOUTS` | `false` (Hyperdrive, like PgBouncer, refuses timeouts as startup parameters) |
| `WEBSOCKET_PROVIDER` | `cloudflare` |
| `OBJECT_STORE_PROVIDER` | `s3` |

To give the buckets other names, add `--var 'OBJECT_STORE_S3_BUCKETS={"skills":"acme-skills","user-exports":"acme-exports"}'`.

#### 5. Set the secrets

```bash
C=deploy/cloudflare/wrangler.generated.jsonc
openssl rand -hex 32 | npx wrangler secret put REALTIME_SIGNING_KEY --config $C   # signs WebSocket tokens
npx wrangler secret put OBJECT_STORE_S3_ACCESS_KEY_ID --config $C                   # the R2 token's Access Key ID
npx wrangler secret put OBJECT_STORE_S3_SECRET_ACCESS_KEY --config $C               # and its Secret Access Key
npx wrangler secret put OPENAI_API_KEY --config $C                                  # each key your agentforeach.json refers to
```

Secrets and vars reach the gateway as environment variables, so `$NAME` references in `agentforeach.json` work as on Azure. The database URL isn't a secret here: the Worker takes it from the Hyperdrive binding.

#### 6. Deploy

```bash
npx wrangler deploy --config deploy/cloudflare/wrangler.generated.jsonc
curl https://<your-worker>/api/health
```

The first deploy creates the Durable Object classes (`DurableInstance`, `UserSocket`, `Relay`, `ContainerSandbox`) and the Cron Trigger. The first trigger, within five minutes, starts the cron scheduler.

## Let users sign in

As on Azure, configure `auth.providers` in `agentforeach.json`, and **until you do, every API call returns 401**. [Getting started](getting-started.md#let-users-sign-in) shows the `jwt` provider with a test token; it works the same here, with the secret set by `wrangler secret put TRIAL_JWT_SECRET`.

- **JWT** (`jwt`) is the usual choice: tokens from your identity provider, checked against its JWKS (`RS256`), or a shared secret (`HS256`).
- **Cloudflare Access** is optional, in front of the Worker. The `jwt` provider can check the token Access adds to each request:

  ```json
  { "type": "jwt", "enabled": true, "headerName": "cf-access-jwt-assertion", "algorithm": "RS256",
    "jwksUri": "https://<team>.cloudflareaccess.com/cdn-cgi/access/certs",
    "issuer": "https://<team>.cloudflareaccess.com", "audience": "<your Access application's AUD tag>",
    "userIdClaim": "email" }
  ```

  Access must let through what has its own auth: channel webhooks (`/api/channels/*/webhook`, which verify their own signatures), and `/realtime/*` (the WebSocket token is the auth).

  Access adds that header from the browser's `CF_Authorization` cookie, so a page on another site could make a signed-in user's browser send it. The gateway therefore treats it as cookie sign-in, as it does App Service authentication: a POST must be JSON (`Content-Type: application/json`), which a cross-site form can't send without a CORS preflight, and CORS (`allowedOrigins`) decides the rest. Reading `cf-access-jwt-assertion` turns this on; any other provider whose credential a proxy derives from a cookie can turn it on with `"cookieBacked": true`.
- **API keys** (`api-key`) and a **trusted proxy** (`trusted-proxy`) work as on Azure.
- **Easy Auth is never trusted off Azure.** Its headers are refused on any other platform, because only Azure's front end strips client-sent copies.
- `x-user-id` (`AUTH_ALLOW_INSECURE_USER_ID_HEADER`) is refused on Cloudflare, including under `wrangler dev`.

## Limits and differences from Azure

| | Cloudflare | What it means |
|---|---|---|
| Memory | 128 MB per isolate | Large attachments and big tool outputs count against it |
| CPU | 5 minutes per request, alarm or trigger (`limits.cpu_ms: 300000`) | Model calls are waiting, not CPU; a turn rarely gets close |
| Turns | Run in a `DurableInstance` alarm: up to 15 minutes of wall time. The turn deadline (9 minutes) fits | The HTTP request only hands the turn off; the reply arrives over the WebSocket |
| A deploy during a turn | Cloudflare restarts a Durable Object's alarm from the beginning when a deploy or restart cuts it off | A chat turn, or a turn resumed after a form, that is cut off this way isn't run again (the model and its tools already ran part-way): the user gets a note in the conversation and an "interrupted" event asking them to send the message again, and the session is free for it at once. A channel turn (Telegram, WhatsApp) runs again, which can send a reply twice; a cron run is protected by its claim |
| Work after a response | `waitUntil`: at most 30 s after the response | Usage records and audit writes finish within it, and turns themselves don't depend on it (compaction runs inside the turn's job). The one exception: a channel turn whose job can't be started at all falls back to running in the request's `waitUntil`, where a long turn can be cut off |
| WebSocket URLs | Each URL from `/negotiate` or `/api/token` connects once: get a new one to reconnect. A browser live-view link survives a page reload within 30 s. On Web PubSub, a URL can be reused until it expires | A URL in Workers Logs (which record request URLs) is already spent, so it can't be replayed ([Realtime protocol](Realtime-Protocol.md#tokens-on-self-hosted-providers)) |
| Closing a socket | After `disconnectUser`, clients get the `disconnected` frame and the close frame at once, but the TCP connection ends about 10 s later | Presence (`isUserOnline`) is right immediately |
| Database | PostgreSQL only. **Cosmos DB isn't supported** | Its adapter isn't bundled; selecting it fails with a clear error |
| MCP | **`stdio` servers are refused**, because a Worker can't start processes. HTTP (Streamable HTTP and SSE) servers work, connected per turn | Run stdio servers somewhere else, behind an HTTP transport |
| Easy Auth | Never trusted | Use JWT, optionally with Cloudflare Access |
| Knowledge (Azure AI Search) | Works, with the search service's API key | The library stays on Azure AI Search, called over HTTPS |

Each Azure-only module is replaced in the Worker bundle by a stub that throws a clear error ([`deploy/cloudflare/azure-only.ts`](../deploy/cloudflare/azure-only.ts)), and so is the AWS SDK behind the `bedrock` model provider ([`aws-only.ts`](../deploy/cloudflare/aws-only.ts)). `npm run check:bundle` fails if any other path reaches Azure or AWS code.

The port suites run against the Cloudflare pack in CI ([where each suite runs](Platforms.md#where-each-suite-runs)), on the Workers runtime itself, locally:

```bash
node packages/platform-cloudflare/conformance/durable/run.mjs     # 23 checks, plus a 15 MB input through Durable Object storage
node packages/platform-cloudflare/conformance/realtime/run.mjs    # 25 checks: pushes, presence, relay, acks, limits, one-time URLs
node packages/platform-cloudflare/conformance/host/run.mjs        # 11 checks: routing, bodies, CORS, scopes, background work
```

## Sandboxes on Cloudflare Containers

Each user's sandbox is a Cloudflare Container run by its own Durable Object (`ContainerSandbox`), from the [shared sandbox image](Sandbox.md#the-shared-image), with the same tools as on Azure. See [Sandboxes](Sandbox.md) for what sandboxes do. `wrangler.jsonc` already selects the backend (`SANDBOX_PROVIDER=cloudflare-containers`), so turn sandboxes on in `agentforeach.json`:

```json
"skills": { "sandbox": { "enabled": true,
  "containers": { "instance": "standard-2", "autoSuspendSec": 300, "egressAllowHosts": ["pypi.org"] } } }
```

`containers` also takes:
- `browser: true` for the [browser](Browser.md): the deploy script then builds the sandbox image with Chromium and its driver (the Dockerfile's `SANDBOX_IMAGE_BROWSER=1`, passed as a wrangler build variable);
- `defaultTimeoutSec` (120) and `maxTimeoutSec` (200) for commands.

`networkAccess` works as on Azure.

- **Sleep and wake.**
  - After `autoSuspendSec` without use (default 5 minutes), the sandbox's whole disk is snapshotted and the container stops.
  - The next call restores it. Files and environment survive; memory and running processes don't, as with ACA Sandboxes' disk mode.
  - Env vars, credentials included, live only in the sandbox server's memory and in the Durable Object, which applies them again after each start. They never reach a snapshot.
  - Measured on 2026-10-02: a snapshot and stop takes 5.4 to 6.7 s, and a restore to a working sandbox takes 2.2 to 2.9 s.
- **Egress.** Denied by default.
  - All HTTP(S) goes through the Worker's `SandboxEgress` handler. It allows the entries on the allowlist: an exact host, `*.domain`, or `host/path` for paths under `/path` on that host.
  - **Ports 80 and 443 only**, unless `networkAccess` is `"enabled"`. A package mirror on a custom port won't work.
  - **Credentials** are injected outside the sandbox, only over `https://` or `wss://` to port 443, for the hosts a skill declares; a credential opens its own hosts, as on Azure.
  - Raw TCP and outside DNS are blocked.
  - WebSockets are relayed. With the browser's handoff on, the sandbox may reach `<worker host>/realtime/relay` and no other path on the gateway. With a `PUBLIC_BASE_URL` that has a port (local development), that entry never matches, and the relay is refused.
- **Image upgrades.** A snapshot is tied to its image. After you deploy a new image:
  - new sandboxes get the new image;
  - a sleeping sandbox is moved to the new image on its next start. Its snapshot restores the old image, `/mnt/data` is copied to a fresh container on the new one, and a new snapshot chain starts. If the copy fails, the sandbox stays on its old image and the upgrade is tried again a day later ([what survives](Sandbox.md));
  - a running sandbox keeps the old Worker code until its container stops.
- **Erasure.** Deleting a user's data stops their sandboxes and drops their snapshot references. Snapshots are manifests in the application's registry repository, each tagged `rootfs-snapshot-*` and `rootfs-set-*`.
  - **Opt in to deleting them:** set the Worker secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_IMAGES_API_TOKEN` (an account API token with Containers write permission). The backend then deletes a user's snapshots from the registry when their sandboxes are deleted (account erasure). Each snapshot has two tags, `rootfs-snapshot-<sha256 of the snapshot id>` and `rootfs-set-<sha256 of its snapshot_set_id>`, the set id being in the snapshot's config. The backend reads the config, deletes both tags (the registry honours deletes by tag; a delete by digest does nothing), then asks for a layer garbage collection, as `wrangler containers images delete` does (verified live). The deploy script uploads both when `CLOUDFLARE_IMAGES_API_TOKEN` is set in your shell.
  - **A sandbox's snapshots are a chain, and it grows.** Each snapshot is a delta on the one before (its parent), so none is deleted while the sandbox lives: deleting a parent would break the next restore. Every sleep adds one, until the user's data is erased or Cloudflare expires them. Cloudflare keeps a snapshot 30 days from its creation or most recent restore. It documents nothing about chains, compaction or chain length, nor whether a parent that is never restored itself can expire while its child is still in use.
  - **Without it, snapshots stay for up to 30 days unused**, with the user's files, and the erasure report says so under `skipped`. With it, a snapshot the registry won't delete fails the erasure and stays listed, so erasing again retries it. Snapshots from before env vars moved into memory (commit 3ae0ae1) also hold `~/.agentforeach/env.json`, with the values of credentials without hosts.
  - `wrangler containers images delete` removes one by hand.

**Start reliability is reported, not gated.** AgentForEach doesn't refuse Cloudflare Containers because of it. Here are the numbers we know of; whether they are good enough for your users is your call.

- **Our measurement**, on 2026-10-01 ([Cloudflare evaluation](Cloudflare_Evaluation.md)). In the controlled run, 7 of 9 fresh starts became ready: six in 2.5 to 4.1 s and one after 65 s. Two hung past 130 s.
- **Through the AgentForEach backend**, on 2026-10-02. Fresh starts became ready in 4.3, 4.5 and 5.9 s; once in 15.6 s, cold right after an image push; and in 33.1 s for the first start of a newly pushed image. Of about 12 starts, 3 failed: all on the first sandbox right after the first image push, each ending after 54 to 90 s with "The container connection is temporarily unavailable". The same sandbox started in 4.5 s a few minutes later, and every later start succeeded. These are observations, not a benchmark.
- **With the browser image**, on 2026-10-02: the first fresh start of each sandbox spent 20 to 25 s applying its egress rules (the `intercepted` phase, now logged with `interceptMs`), and was ready after 22 to 28 s. Later fresh starts on the same deployment took 0.3 s for that phase and about 2.5 s in all, and a restore 1 s and 2.8 s. A rerun after a redeploy saw 18.8 and 18.6 s on later fresh starts too, and 0.5 s on another. So the wait is a start landing on a machine that doesn't have the larger image yet (pulling and booting it), which can happen to any fresh start, not only the first after a deploy. `interceptOutboundHttps` waits for the container's network to come up; nothing else in the start waits.
- **Cloudflare's figures**, from its post of 30 September 2026, [Cloudflare Containers, rebuilt to scale agent sandboxes](https://blog.cloudflare.com/faster-agent-sandboxes/). On ComputeSDK's Burst TTI benchmark, which launches 100 sandboxes at once, the rebuilt scheduler starts a sandbox in **648 ms** at the median and **910 ms** at p95. That is a different image and benchmark from ours.

## Run locally

`wrangler dev` runs the Worker and its Durable Objects on your machine, against a local PostgreSQL. It needs no Cloudflare account.

```bash
docker run -d --name agentforeach-pg -e POSTGRES_PASSWORD=pw -p 5432:5432 pgvector/pgvector:pg17
psql postgres://postgres:pw@localhost:5432/postgres -f infra/postgres-schema.sql   # or set DATABASE_PROVISION=true below
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://postgres:pw@localhost:5432/postgres

cat > deploy/cloudflare/.dev.vars <<'EOF'
REALTIME_SIGNING_KEY=local-only
OPENAI_API_KEY=sk-...
TRIAL_JWT_SECRET=local-only-secret
PUBLIC_BASE_URL=http://localhost:8787
EOF

npm ci && npm run build:platform && npm run build --workspace @agentforeach/gateway
npx wrangler dev --config deploy/cloudflare/wrangler.jsonc --test-scheduled
curl localhost:8787/api/health
curl 'localhost:8787/__scheduled?cron=*/5+*+*+*+*'   # Cron Triggers don't fire on their own locally
```

- **Secrets.** `.dev.vars` holds the local secrets and is git-ignored. Any var can also be overridden per run with `--var KEY:VALUE`.
- **Signing in.** The Worker counts as a production host even locally, so `x-user-id` is refused. Sign in with a [test token](getting-started.md#try-it-with-a-test-token) minted with `TRIAL_JWT_SECRET`.
- **Files.** Without R2 keys, skills and sandbox exports are off. To try them locally, point the `OBJECT_STORE_S3_*` vars at MinIO (any S3-compatible server works).
- **WebSockets.** Locally the realtime URLs are `ws://` on port 8787. The browser's live view only connects to `wss://`, so try it on a deployed Worker.

## Troubleshooting

`npx wrangler tail --config deploy/cloudflare/wrangler.generated.jsonc` streams the Worker's logs.

| Symptom | Cause |
|---|---|
| Every API call returns 401 | No auth provider in `agentforeach.json` trusts the caller yet ([Let users sign in](#let-users-sign-in)) |
| `relation "…" does not exist` (first seen in the cron tick) | The schema wasn't applied: the Worker never runs DDL. Apply `infra/postgres-schema.sql`, or rerun the deploy script |
| `[objects] … object storage is off`, then `[skills] no storage account configured` | `OBJECT_STORE_S3_ACCESS_KEY_ID` or `OBJECT_STORE_S3_SECRET_ACCESS_KEY` isn't set. Skills and sandboxes stay off until both are |
| `… is Azure-only and isn't available on Cloudflare Workers` | `agentforeach.json` selects an Azure-only provider, such as Cosmos DB or an ACA sandbox. See [Limits and differences](#limits-and-differences-from-azure) |
| `… is AWS-only and isn't available on Cloudflare Workers` | `agentforeach.json` selects the `bedrock` model provider or Bedrock embeddings. Use a provider with an API key |
| `MCP server "…" uses the stdio transport, which runs a local process` | A Worker can't start processes. Use an MCP server over streamable HTTP (or SSE) |

## Next

- [Platforms](Platforms.md): the ports, and how the Azure and Cloudflare packs implement them
- [Database](Database.md): PostgreSQL settings, pooling and what differs from Cosmos DB
- [Realtime protocol](Realtime-Protocol.md): what clients send and receive
