# Channels

Messaging channels let users reach their agent from outside the app. AgentForEach ships two: **Telegram** and **WhatsApp** (Cloud API). The app and web clients don't use this path; they talk to `POST /api/chat` and receive replies over Web PubSub (see [Architecture](Architecture.md)).

Code: `packages/gateway/channels/` (framework, `telegram/`, `whatsapp/`) and `packages/gateway/handlers/channel-webhook.ts`. WhatsApp specifics are in [Channel-WhatsApp](Channel-WhatsApp.md); identity linking and pairing in [Identity](Identity.md).

## One webhook for every channel

Every channel uses the same two anonymous HTTP routes; the channel id in the path picks the plugin:

| Route | Purpose |
|---|---|
| `POST /api/channels/{channelId}/webhook` | Messages and events |
| `GET /api/channels/{channelId}/webhook` | Provider verification handshake (WhatsApp's `hub.challenge`); `404` for channels without one |

The routes are `authLevel: "anonymous"` because providers can't authenticate to Azure Functions. Authenticity is the plugin's job (`verifyWebhook`, below). An unknown channel, or one that didn't register, gets `404`.

### What happens to a POST

1. Look up the plugin; `404` if it isn't registered.
2. Parse the JSON body and **verify** it against the raw bytes (`401` on failure).
3. Bootstrap the identity store if this is the first channel message on the instance.
4. `parseInbound` turns the payload into a normalised `InboundMessage`. Payloads that aren't messages (delivery receipts, account alerts, messages from senders not on the allowlist) return `200 { skipped: true }`; if the plugin has `handleEvent`, the payload is passed to it without waiting.
5. Run the turn (`processInbound` in `channels/router.ts`):
   - a message that looks like a **pairing code** is consumed and answered with a confirmation, and no turn runs;
   - `enrichInbound` (if any) downloads media;
   - the sender is resolved to a AgentForEach user (below);
   - the turn runs through the same client pipeline as the app, with session id `{channelId}-{chatId}` (for example `telegram-12345`), so each chat is one continuing conversation;
   - the reply is formatted for the channel (`formatReply`) and sent (`sendOutbound`), with buttons or a list when the agent offered a small set of choices and the channel supports them (WhatsApp).

How step 5 is scheduled depends on the plugin:

- **`ackImmediately` plugins (WhatsApp)** get their `200` straight away, and the turn runs in the **`ChannelInboundTurn`** Durable orchestration (one `ProcessChannelInboundTurn` activity). A slow turn therefore can't trigger a provider redelivery, and an instance recycled mid-turn doesn't lose it; the cost is that a crash after the reply was sent can send it twice. Such plugins must deduplicate inbound message ids durably. If no durable client is available the turn falls back to running detached.
- **Other plugins (Telegram)** run the turn inside the webhook request. The handler answers `503` when the failure is temporary (for example, the identity store is unavailable) so the provider redelivers, and `200` otherwise so a turn that already ran isn't retried.

## Security

### Webhooks fail closed

| | Telegram | WhatsApp |
|---|---|---|
| Secret | `channels.telegram.webhookSecretToken`, compared (constant time) with the `X-Telegram-Bot-Api-Secret-Token` header | `channels.whatsapp.appSecret`, HMAC-SHA256 over the raw body compared with `X-Hub-Signature-256` |
| Secret missing, on Azure | The channel **refuses to register** and logs why; its webhook returns `404` | Same |
| Secret missing, elsewhere | Every webhook is rejected (`401`) unless `ALLOW_UNSIGNED_WEBHOOKS=true` | Same |

"On Azure" means `WEBSITE_SITE_NAME` is set; `ALLOW_UNSIGNED_WEBHOOKS` is ignored there. It exists for local development against a tunnel, and nothing else.

WhatsApp's GET handshake has no bypass: without `webhookVerifyToken` it answers `403`.

### Who a sender is

A channel sender becomes a AgentForEach user in one of three ways (`identity/resolver.ts`):

1. **An identity link.** Links are made only by **pairing** (a signed-in user calls `POST /api/identity/pair`, gets a short-lived code and sends it from the channel) or by an **admin** (`POST /api/identity/links`, which returns `403` to anyone else). Nothing links accounts automatically by phone number, username or email.
2. **`identity.fallbackMode: "config-default"`** (the default): an unlinked sender acts as the channel's `defaultUserId`.
3. **`identity.fallbackMode: "sender-passthrough"`**: an unlinked sender gets their own isolated user id, `{channel}:{senderId}`.

Because option 2 would let any stranger act as the default user, a channel **refuses to register** when the fallback is `config-default` and its `authorizedSenders` allowlist is empty. The check uses the resolved identity config, so a deployment with no `identity` section at all counts as `config-default`. The router checks the same thing again before every turn.

With `authorizedSenders` set, messages from anyone else are dropped at parse time, before pairing or the agent. If identity is enabled but its store can't be reached, channel turns are refused rather than resolved to the default user.

Pairing codes are 6 characters from an alphabet without look-alike characters, expire after 5 minutes, and a sender is locked out after 10 failed attempts, for 15 minutes after the last one (`identity.*` settings in `agentforeach.json`).

## Configuration

Channels are configured under `channels` in `packages/gateway/config/agentforeach.json`. A channel registers only when its block exists, `enabled` isn't `false`, and its required credentials resolve. Values of the form `"$NAME"` are read from the app setting `NAME`; keep secrets there, never literally in the config file.

```json
"channels": {
  "telegram": {
    "enabled": true,
    "botToken": "$TELEGRAM_BOT_TOKEN",
    "webhookSecretToken": "$TELEGRAM_WEBHOOK_SECRET",
    "authorizedSenders": ["<numeric Telegram user id>"],
    "defaultUserId": "owner",
    "maxMessageLength": 4096
  }
}
```

| Telegram key | Default | Notes |
|---|---|---|
| `enabled` | `true` if the block exists | Also requires a `botToken` |
| `botToken` | — | From BotFather |
| `webhookSecretToken` | — | Required on Azure |
| `authorizedSenders` | `[]` | Numeric Telegram user ids; required unless `fallbackMode` is `sender-passthrough` |
| `defaultUserId` | `"telegram-user"` | Used by the `config-default` fallback |
| `maxMessageLength` | `4096` | Longer replies are split |

The WhatsApp keys are listed in [Channel-WhatsApp](Channel-WhatsApp.md#configuration).

On a Pulumi deployment, put the secret app settings in `agentforeach:extraAppSettings` (they go to Key Vault):

```bash
pulumi config set --secret --path 'agentforeach:extraAppSettings.TELEGRAM_BOT_TOKEN' '<bot token>'
pulumi config set --secret --path 'agentforeach:extraAppSettings.TELEGRAM_WEBHOOK_SECRET' '<random string>'
```

### Setting up Telegram

1. Create a bot with BotFather and set the token and a random webhook secret as above.
2. Enable the `channels.telegram` block, and either list `authorizedSenders` or set `identity.fallbackMode` to `"sender-passthrough"` and have users pair.
3. Deploy, then point the bot at the webhook. The script reads the token from `TELEGRAM_BOT_TOKEN` (or `agentforeach.json`) and passes `TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token`:

   ```bash
   TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret> \
     node scripts/setup-telegram-webhook.mjs https://<your-function-app>.azurewebsites.net
   node scripts/setup-telegram-webhook.mjs --info     # check it
   node scripts/setup-telegram-webhook.mjs --delete   # remove it
   ```

Telegram passes text, photos and image documents (up to 20 MB) to the agent; replies are converted from Markdown to Telegram HTML. Group chats are supported and the group name is given to the model.

## Scheduled delivery

Each channel registers a delivery adapter, so a scheduled job can deliver its result to a Telegram or WhatsApp chat (`delivery.channelId`). The special value `"last"` delivers to the channel and chat the user most recently wrote from, found from recent session metadata. See [Crons](Crons.md).

## The plugin contract

A channel is an object implementing `ChannelPlugin` (`channels/types.ts`):

| Member | Required | Purpose |
|---|---|---|
| `id`, `displayName`, `enabled` | yes | `id` is the `{channelId}` in the route and the prefix of session ids |
| `verifyWebhook(headers, rawBody)` | yes | Authenticate a POST |
| `parseInbound(body)` | yes | Payload → `InboundMessage`, or `undefined` to skip |
| `sendOutbound(context)` | yes | Send text, or an `OutboundPayload` (buttons, list) |
| `toSendRequest(message)` | yes | Channel-specific request fields: `defaultUserId`, extra system-prompt context |
| `authorizedSenders` | | Allowlist the router checks before using the `config-default` fallback |
| `formatReply(text)`, `parseMode` | | Convert the model's Markdown to the channel's dialect |
| `verifyChallenge(query)` | | Answer a GET verification handshake |
| `handleEvent(body)` | | Non-message payloads; fire-and-forget |
| `ackImmediately` | | Acknowledge first and run the turn in `ChannelInboundTurn` |
| `enrichInbound(message)` | | Slow work (media downloads) kept off the acknowledgement path |
| `hitlWidgets` | | Whether the channel can render app forms; if not, the agent collects input in conversation |
| `getDeliveryAdapter()` | | Scheduled-job delivery |

### Adding a channel

1. Create `channels/<name>/` with the plugin (see `telegram/` for the smallest example) and an `index.ts` that registers it with `registerChannel()` only when it is configured and safe.
2. In that registration, refuse to start when `identityFallbackIsUnsafe(authorizedSenders)` is true or, on Azure (`isCloudRuntime()`), when there is no webhook secret. Verification must reject unsigned requests unless `allowUnsignedWebhooks()` is true.
3. Add its config type to `ChannelsJsonConfig` and a side-effect import to `channels/index.ts`.
4. If the provider redelivers aggressively, set `ackImmediately` and deduplicate message ids durably.

The webhook handler, router and registry need no changes.
