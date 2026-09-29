# Upgrading

Behaviour changes an operator needs to know about, newest first. Most are security fixes that close a default that was unsafe for a multi-tenant deployment. Each says what changed, who is affected, and what to do.

## After 0.1.0

| Change | Who is affected | What to do |
|---|---|---|
| Telegram messages sent on behalf of a chat (anonymous group admins, channel posts, linked-channel forwards) are ignored: they all carry one shared placeholder sender, so they would act as one user | Groups whose admins post anonymously | An admin who wants to talk to the agent turns off "Remain anonymous" |
| A scheduled job due more than 7 days ahead (`cron.cosmos.dueIndexTtlSeconds`) was dropped from the scheduler's index before it ran; index rows now live until the run time | Every deployment with reminders or jobs set more than a week out | Once, as an admin, after deploying: `POST /cron/admin/backfill-due-index`, which re-indexes every enabled job |

## Security hardening (September 2026)

### Authentication

| Change | Who is affected | What to do |
|---|---|---|
| The `trusted-proxy` provider needs `sharedSecret` (default header `x-proxy-secret`); without it every request is refused. `trustedIps` was never enforced and is gone | Deployments behind a trusted proxy | Have the proxy send the secret; set `sharedSecret: "$TRUSTED_PROXY_SECRET"`. Never put `admin` in `defaultRoles` |
| With App Service authentication, a POST must have `Content-Type: application/json`, or it is refused (401): a cookie session would otherwise let another site post without a CORS preflight | Browser clients that POST without a body or content type (`/api/chat/abort`, `/api/token`, `/cron/jobs/{id}/run`) | Send `Content-Type: application/json` |
| The unimplemented `auth.rateLimit` (login lockout) settings were removed | Nobody; they had no effect | — |
| `x-user-id` / `?userId=` identity is off unless `AUTH_ALLOW_INSECURE_USER_ID_HEADER=true`, and always off on Azure | Local dev and scripts that send `x-user-id` | Set `AUTH_ALLOW_INSECURE_USER_ID_HEADER=true` in `local.settings.json` |
| Easy Auth principal headers are trusted only when App Service Authentication is on (`WEBSITE_AUTH_ENABLED`), or elsewhere with `AUTH_TRUST_EASY_AUTH_HEADERS=true` | Deployments behind a custom proxy that sets those headers | Set `AUTH_TRUST_EASY_AUTH_HEADERS=true` there |
| JWTs must carry `exp` (60 s leeway), and the header `alg` must match the configured algorithm | Issuers that mint tokens without `exp` | Set `requireExp: false` on the `jwt` provider only if you must |
| Operator actions need the admin role (`auth.settings.adminRole`, default `"admin"`) | Anyone calling `POST /api/identity/links`, `/cron/status`, `/cron/start` | Give operators the role: an Entra app role, `keys[].roles` on the `api-key` provider, or, on `trusted-proxy`, a proxy-set roles claim (`defaultRoles` applies to everyone the proxy lets through, so don't put `admin` there) |

### Channels and identity

| Change | Who is affected | What to do |
|---|---|---|
| Every wrong pairing code counts toward the sender's lockout, including from senders already linked | Linked users who send a message that looks like a code | Nothing; the lockout blocks only pairing, and expires |
| A channel refuses to register when strangers would act as the default user (no `authorizedSenders` and identity `fallbackMode: "config-default"`); the router also refuses such turns | Single-user Telegram/WhatsApp setups without an allowlist | Set `authorizedSenders` (numeric Telegram ids / E.164 numbers), or use `fallbackMode: "sender-passthrough"` with pairing |
| Webhooks without a configured secret are rejected (in the cloud the channel won't register) | Telegram without `TELEGRAM_WEBHOOK_SECRET`; WhatsApp without `appSecret` | Set the secret (Telegram: pass it as `secret_token` to `setWebhook`). Locally, `ALLOW_UNSIGNED_WEBHOOKS=true` accepts unsigned webhooks |
| Identity links are resolved through a channel-account index (`identity-channel-index`) | Deployments with links created before this version | Once, as an admin: `POST /api/identity/backfill-index` (see [Identity.md](Identity.md#lookup-cost)) |
| Pairing: attempts are limited per sender (10 per 15 min), at most 5 active codes per user (429), codes are deleted on use | Nobody in normal use | — |
| When the identity store is unavailable, channel turns are refused with `503` (providers redeliver) instead of running as the default user | Outages only | — |
| The shipped `agentforeach.json` has Telegram disabled and `defaultUserId: "owner"` | New deployments | Configure the channel explicitly |

### Sessions

| Change | Who is affected | What to do |
|---|---|---|
| Messages moved to `session-messages-v2`, scoped to their owner's session; group chat members have separate histories | Every existing deployment | Follow [Session-management.md → Upgrading](Session-management.md#upgrading-from-the-session-messages-container). Pre-upgrade messages don't appear in history (summaries survive) |
| On Azure with Web PubSub, chat turns run in the background (a `ChatTurn` orchestration): `POST /api/chat` returns **202** `{ runId, sessionId, status: "accepted" }` and the reply arrives over the socket (and in the session history); WebSocket `chat` messages are acknowledged at once. A retry with the same `idempotencyKey` joins the running turn instead of starting another. Turns may run up to 9 min (was cut at 230 s) | HTTP clients that read the reply from the `/api/chat` response | Listen on the socket (the reference app already does), or send `"wait": true` to get the old behaviour (215 s limit). `CHAT_ASYNC_TURNS=false` turns background turns off |
| Streaming `delta` events carry `delta` (new text, coalesced every 400 ms) and `offset` (where it starts in the reply) instead of `accumulated` (the whole reply so far, which made each reply O(n²) bytes). `final` still carries the full text | Clients that render `accumulated` | Append `delta`; if `offset` doesn't match your text length a frame was lost — keep appending and replace with `final.text` |
| Function App runs Node 22 (Node 20 reached end of life in April 2026) | Custom builds | Build with Node 22 |
| Durable Functions: 16 control-queue partitions (was the default 4), 2 s max queue polling, 64 concurrent activities per instance, a 1-minute work-item visibility timeout (a turn on an instance killed during scale-in is redelivered within about a minute; live activities keep renewing), and a running instance is never overwritten by a new start with the same id. Finished orchestrations are purged an hour after creation (`DurableHistoryPurge`, every 15 min), so chat inputs and attachments don't outlive the message TTL | Existing task hubs keep the partition count they were created with | To get 16 partitions on an existing deployment, set a new `durableTask.hubName` (in-flight orchestrations on the old hub are abandoned) |
| Clients sending another message while a reply is still running in the same session get `SESSION_BUSY` (HTTP 409, or an `error` event with `code: "session_busy"`); more than 20 messages a minute or 1000 a day per user get `RATE_LIMITED` (HTTP 429 with `Retry-After`). Channels reply with the explanation | Busy clients; very chatty users | Wait for the reply before sending; tune `rateLimit` in `agentforeach.json` |
| Client session ids must be 1–128 characters of letters, digits, `.`, `_`, `-` | Clients sending other characters | Use a UUID or similar |
| Message docs live 7 days (`messageTtlSeconds`, was effectively forever). A session still expires after 24 h without messages (`ttlSeconds`), after which its messages can't be read; the conversation carries on through digests and memory | Deployments that read old messages directly from Cosmos | Raise `messageTtlSeconds` (and `ttlSeconds` for longer-lived sessions) |

### Cron

| Change | Who is affected | What to do |
|---|---|---|
| Scheduled runs count against `rateLimit.scheduled` (default 6 a minute, 300 a day per user; over it the run is skipped and heartbeats retried later), force-runs against `rateLimit.forceRun` (2 a minute, 30 a day; 429). The default cap on jobs per user is 50 (was 500) | Users with many or frequent jobs | Raise the limits in config if your users need more |
| Delivery only goes to the owner's own accounts: push, a linked channel account, or the chat the job was created from. A job whose recipient is refused is **disabled before running**, and the owner gets a push notice | Jobs that deliver to a chat the owner hasn't linked, including group-chat jobs created before this version | Link the account by pairing, or recreate the job from that chat |
| `/cron/status` and `/cron/start` need the admin role; the scheduler is started by the `CronSchedulerHealthCheck` timer | Ops scripts and the bundled smoke tests (now expect 403 for non-admins) | Use an admin identity for ops |
| `PATCH /cron/jobs/{id}` ignores scheduler state and bookkeeping fields | Clients that set `state` | Don't |
| Force-run (`POST /cron/jobs/{id}/run`) respects `expiresAt` and `maxRuns` (409) | — | — |
| `cron.enabled: false` removes the `/cron/*` API | — | — |
| Cron runs 8 scheduler shards by default (was 1 in Pulumi, 4 in `agentforeach.json`), and the legacy cross-partition sweep is off | Deployments with jobs created before the due index | Once, as an admin: `POST /cron/admin/backfill-due-index`. Or `CRON_LEGACY_SWEEP=true` |

### Tools and models

| Change | Who is affected | What to do |
|---|---|---|
| Every fetch of a user- or LLM-controlled URL (web_fetch, link previews, `http_fetch`, cron webhooks) goes through an SSRF-safe fetch: internal addresses refused at connect time and on every redirect, request bodies never re-sent to another origin, responses capped while streaming | Skills that call internal services | Expose them publicly behind auth, or through an MCP server configured by the operator |
| `http_fetch` refuses credentials whose skill declares no `hosts` (`skills.requireCredentialHosts: true`) | Skills with credentials but no `hosts` | Add `hosts`/`header`/`format` to the credential in SKILL.md (see [Sandbox-Migration.md](Sandbox-Migration.md#declaring-credential-hosts)), or set the flag to `false` for skills you trust |
| Clients may only request a model that is priced in `usage.pricing` or is the provider's default; `llms.providers.<id>.allowedModels` narrows it further (400 otherwise) | Clients that pick models | Price the models you offer, or set `allowedModels` |
| HITL input responses must come from the request's owner | — | — |
| Product-specific HITL features removed: the `show_document` and silent document-lookup tools, the `contract_inputs` form type (and `select_party`/`select_review`/`select_document`), active-document prompt context, and `clientContext` on `/api/chat`. Deployments add their own form types with `hitl.customFormTypes`; the example forms moved to `examples/hitl-forms.json` | Clients that relied on those tools, events or `clientContext` | Define custom form types in config; pass context in the message |
| New: `DELETE /api/me/data` (the caller) and `DELETE /api/admin/users/{userId}/data` (admin) erase every stored document, sandbox and exported file for a user; both require `x-confirm-erase: yes` | — | Wire it into your account-deletion flow |
| The model can only call tools offered in that turn (`hiddenTools`, `toolChannels` and sub-agent limits are enforced at dispatch, not just hidden) | Nobody who relied on documented behaviour | — |
| Tools that need approval (HITL) return "approval required" where nobody can approve: Telegram, WhatsApp, cron, heartbeat. They used to run unapproved | Channel users of approval-gated tools | Use them from the web/app client, or drop the approval requirement for tools that are safe without it |

### Infrastructure (Pulumi)

| Change | Who is affected | What to do |
|---|---|---|
| Runtime secrets live in a Key Vault (random name `afe-kv-xxxxxxxx`) referenced from app settings by version, resolved by a user-assigned identity granted access before the app starts (`agentforeach:keyVaultEnabled`, default true) | Every stack on the next `pulumi up` | Nothing. A new secret value restarts the app onto it. Deleted vaults are soft-deleted for 7 days: `az keyvault purge --name <vault>` if you need the name back |
| The runtime gets a Search **query** key, not the admin key | Knowledge ingestion scripts that used the app setting | Use the admin key from the portal or `az search admin-key show` for ingestion |
| Web PubSub upstream calls must carry a valid `ce-signature` whenever the runtime has an access key (from `WEBPUBSUB_CONNECTION_STRING`, plus `WEBPUBSUB_SECONDARY_ACCESS_KEY` during rotation). The shared secret no longer substitutes for it, and is no longer put in the event handler URLs. Only key-less (identity-based) connections still use `WEBPUBSUB_UPSTREAM_SHARED_SECRET`, sent as a header | Anyone calling `/ws/*` with the shared secret; deployments whose hub is configured outside Pulumi with `?upstreamSecret=` URLs | Re-run `pulumi up` (handler URLs without secrets). `webPubSubUpstreamSharedSecret` is now optional; rotate it if it was ever in a URL |
| Only the message handler receives Web PubSub user events (handlers match in order; the connect handler used to be first with `userEventPattern: "*"`) | Hubs configured outside Pulumi | Match the Pulumi hub definition |
| No secret stack outputs (`cosmosPrimaryKey`, `webPubSubConnStr` removed) | Scripts reading them | Read keys from Key Vault or the portal |
| Storage disallows anonymous blob access | — | — |
| The Functions host, Durable Functions and file exports reach storage with a managed identity (`runtime-storage`: Blob Data Owner, Queue and Table Data Contributor, granted before the app starts). `AzureWebJobsStorage` is replaced by `AzureWebJobsStorage__accountName/__credential/__clientId`; export download links use user-delegation SAS (`agentforeach:storageManagedIdentity`, default true) | Anything reading `AzureWebJobsStorage` from app settings | Use the account name with Entra ID. The account key still exists for the knowledge indexer and scripts |
| Telemetry is sampled (20 items/s; requests and exceptions always kept) and Log Analytics has a daily cap (`agentforeach:logDailyCapGb`, default 5 GB; when reached, ingestion and log alerts stop until the next day). New alerts: errors (exceptions and error-level logs; Flex apps have no Http5xx metric), Web PubSub connection quota > 80%, Cosmos throttling, rate-limit bursts, turns timing out; emailed to `agentforeach:alertEmail` if set | Operators relying on unsampled traces | Raise the cap or turn sampling off in `host.json` while debugging |
| Web PubSub is `Standard_S1` (`agentforeach:webPubSubSku`, `agentforeach:webPubSubUnits`, default 1 unit = 1,000 connections, 1M messages a day). It was `Free_F1` (20 connections) | Every stack: each unit is a fixed daily charge (about $49 a month), the one cost that isn't pay-per-use | Size `webPubSubUnits` to peak concurrent connections / 1,000; `Free_F1` stays available for trials |
| Scale limits are stack settings: `agentforeach:functionMaxInstances` (default 100, was a fixed 40), `agentforeach:httpPerInstanceConcurrency` (16); Cosmos can be `agentforeach:cosmosCapacity: autoscale` with `cosmosAutoscaleMaxRu` (serverless stays the default; the mode is fixed when the account is created) | Deployments that relied on the 40-instance cap to bound cost | Set `functionMaxInstances` |
| The runtime reaches Cosmos DB with a managed identity (`cosmos-data`, granted Cosmos DB Built-in Data Contributor before the app starts; `COSMOS_IDENTITY_CLIENT_ID`), and the account's key auth is **disabled** (`agentforeach:cosmosManagedIdentity`, `agentforeach:cosmosDisableLocalAuth`, both default true). No Cosmos key is stored anywhere | Scripts and local runs against the cloud account with `COSMOS_KEY`; anything else using the account keys | Leave `COSMOS_KEY` empty and `az login`: the runtime then uses your Entra identity, which needs the data role: `az cosmosdb sql role assignment create -a <account> -g <rg> --role-definition-id 00000000-0000-0000-0000-000000000002 --scope / --principal-id <your object id>`. Or set `cosmosDisableLocalAuth: false` to keep keys |
| `LOG_REDACTION_KEY` (generated, in Key Vault) keys the hash that replaces user, session and chat ids in logs | Ops queries that search logs for a raw user id | Compute the token with `redactId()` from `utils/redact.ts` and the same key, or correlate by run id |
| New admin route `POST /api/identity/backfill-index` | Deployments with pre-upgrade identity links | See Channels and identity |
| Every Cosmos container is created by Pulumi, from `infra/cosmos-containers.json` (generated from the runtime's own definitions by `npm run db:catalog --workspace @agentforeach/gateway`). On Azure the runtime only references containers (`COSMOS_PROVISION_CONTAINERS=false`) and uses one Cosmos client per process | **Existing stacks:** the 8 containers Pulumi used to manage as separate resources are now part of one ARM deployment. Removing them from the program would make Pulumi **delete them, with their data** | Before `pulumi up`, drop them from state (Azure keeps them): `pulumi stack --show-urns \| grep SqlResourceSqlContainer`, then `pulumi state delete '<urn>'` for each. The deployment then updates them in place (same partition keys; `memories` gains its full-text policy, which the runtime always expected) and creates the 12 containers the runtime used to create itself |
| A container's definition changes (partition key, TTL, indexing) only through code: edit the store, run `npm run db:catalog`, commit the JSON. CI fails when the JSON is out of date | Contributors | — |

### Dependencies

| Change | Who is affected | What to do |
|---|---|---|
| `@agentforeach/gateway` depends on `undici` ^6 (SSRF-safe fetch); the Pulumi program on `@pulumi/random` | Custom builds | `npm ci` |

### Behaviour fixes

| Change | Who is affected | What to do |
|---|---|---|
| Memory search scores were inverted (Cosmos cosine `VectorDistance` is a similarity). Ranking, `memory_forget`, dedup and `deleteBySearch` now pick the closest memories | Everyone using memory; `minScore` thresholds tuned against the old scores | Re-check `minScore` |
| Compaction works with reasoning models (no `temperature` sent to them) and runs by size or age, not on every turn | — | — |
| `NO_REPLY` and other control tokens are stripped from channel replies | — | — |
| Onboarding completes when the model calls `prompt_update` with `completeOnboarding: true`, whatever document it names | — | — |
| A JWKS outage keeps serving cached keys; tokens without `kid` are checked against every RSA signing key. RS256 without `issuer`/`audience` logs a warning | Deployments using a shared JWKS (Entra `common`, Firebase) without `issuer`/`audience` | Set both |
