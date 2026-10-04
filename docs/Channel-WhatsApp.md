# WhatsApp channel

A WhatsApp Cloud API channel built on the same plugin contract as Telegram (see [Channels](Channel.md) for the shared webhook, security model and identity resolution). Code: `gateway/channels/whatsapp/`. It calls the Graph API with native `fetch`; there is no SDK dependency.

## Setup

1. In Meta Business Manager, create a WhatsApp Business Account and phone number, and a **System User access token with expiry "Never"** (dashboard tokens expire after 24 hours).
2. Add the secrets as app settings (on Pulumi: `agentforeach:extraAppSettings`, which go to Key Vault), for example `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, and reference them from the config block below.
3. Add a `channels.whatsapp` block to `agentforeach.json`. The channel stays dormant until it has both an access token and a phone number id.
4. Either set `authorizedSenders` or set `identity.fallbackMode` to `"sender-passthrough"` and have users pair. A WhatsApp number is public, and the channel refuses to register if a stranger would act as the default user.
5. In the Meta app, set the callback URL to `https://<your-function-app>.azurewebsites.net/api/channels/whatsapp/webhook` with your verify token, and subscribe to `messages` (plus `user_preferences`, and ideally `account_alerts` and `phone_number_quality_update`).

### Fail-closed behaviour

- **No `appSecret` on Azure:** the channel refuses to register and logs why.
- **No `appSecret` elsewhere:** every POST is rejected unless `ALLOW_UNSIGNED_WEBHOOKS=true` (local development only; ignored on Azure).
- **No `webhookVerifyToken`:** the GET handshake always answers `403`; there is no bypass.
- Signatures are HMAC-SHA256 over the raw request body, compared in constant time with `X-Hub-Signature-256`.

## Configuration

```json
"channels": {
  "whatsapp": {
    "enabled": true,
    "accessToken": "$WHATSAPP_ACCESS_TOKEN",
    "phoneNumberId": "$WHATSAPP_PHONE_NUMBER_ID",
    "appSecret": "$WHATSAPP_APP_SECRET",
    "webhookVerifyToken": "$WHATSAPP_VERIFY_TOKEN",
    "authorizedSenders": ["+<country code><number>"],
    "templates": {
      "reengage": { "name": "<approved template name>", "language": "en", "bodyParams": ["{{text}}"] }
    }
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `accessToken`, `phoneNumberId` | None | Both required for the channel to register |
| `businessAccountId` | None | Optional |
| `appSecret` | None | Webhook signature key; required on Azure |
| `webhookVerifyToken` | None | Echo token for the GET handshake |
| `apiBase` | `https://graph.facebook.com` | |
| `apiVersion` | `v26.0` | Graph API versions are retired about two years after release; review yearly |
| `authorizedSenders` | `[]` | Phone numbers; compared as digits only, so `+`, spaces and dashes don't matter |
| `defaultUserId` | `"whatsapp-user"` | Used by the `config-default` identity fallback |
| `maxMessageLength` | `4096` | Longer replies are split |
| `markReadOnReceipt`, `typingIndicator` | `true`, `true` | Mark the message read and show typing when it arrives |
| `optOutKeywords`, `optInKeywords` | `["stop"]`, `["start"]` | Case-insensitive |
| `windowStore` | `"memory"` | Use `"cosmos"` when running more than one instance |
| `dedupeStore`, `mediaCacheStore` | `"cosmos"`, `"cosmos"` | |
| `acceptInboundMedia` | `["image"]` | Any of `image`, `document`, `audio`, `video` |
| `maxInboundMediaBytes` | 5 MB | Checked before anything is downloaded into memory |
| `templates` | `{}` | Approved templates by purpose; `reengage` is used when the service window has closed |

Values of the form `"$NAME"` are read from app settings. The `"cosmos"` stores share the `whatsapp-state` container (partition key `/scope`); opt-out state is always stored there.

## Inbound

WhatsApp is an `ackImmediately` channel: the webhook answers `200` once the payload is verified and parsed, and the agent turn runs as a `ChannelInboundTurn` durable job. Meta redelivers failed webhooks for up to seven days, so the parser, in order:

1. drops senders not on `authorizedSenders` (when set);
2. **claims the message id** with an atomic create in the dedupe store (8-day TTL); a redelivery that loses the claim is dropped;
3. records the message time, opening or extending the 24-hour service window;
4. handles consent: an opt-out keyword records the opt-out and replies with a fixed confirmation, an opt-in keyword reverses it, and any other message from an opted-out user is ignored;
5. ignores reactions and system messages;
6. marks the message read and shows the typing indicator (the indicator disappears after about 25 seconds or when the reply arrives);
7. renders the message as text.

Media is downloaded later, in `enrichInbound`, off the acknowledgement path. Downloads need the access token for both the metadata and the file URL.

| Message type | Text given to the agent |
|---|---|
| `text` | The body |
| `image`, `video`, `audio`, `document` | The caption, or a placeholder such as `[sent a voice note]`; accepted media is attached |
| `sticker` | `[sent a sticker]` |
| `location`, `contacts` | A one-line rendering of the location or contact |
| `interactive` (button or list reply) | The option's title; a completed Flow gives its response JSON |
| `button` (template quick reply) | The button text |
| `order` | The order text |
| `unsupported` (view-once, disappearing messages) | `[sent something this channel can't open]`, so the agent answers instead of staying silent |

Non-message webhook fields go to `handleEvent`: `user_preferences` opt-outs and opt-ins update the consent store, a `131050` delivery failure is recorded as an opt-out, and quality and account alerts are logged.

Business numbers can't take part in group chats through the Cloud API, so `isGroupChat` is always `false` and the chat id is the sender's number. The session id is therefore `whatsapp-<number>`.

## Outbound

Every send (replies and scheduled deliveries):

1. is refused if the recipient has opted out;
2. checks the 24-hour service window. If it has closed, free-form messages are not allowed, so the `reengage` template is sent instead (`{{text}}` in `bodyParams` is replaced with the message), or, with no template configured, the send fails with an error naming the missing template;
3. is split at `maxMessageLength` and posted to `/{apiVersion}/{phoneNumberId}/messages`, with buttons or a list when the agent offered a small set of choices.

Errors are classified (`errors.ts`). Rate limits (`130429`, `131056`, `131053`, `4`), the generic transient error `2`, and HTTP 429/5xx without an error body are retried with jittered exponential backoff from 1 s up to 60 s, 4 attempts in total. Everything else, including `131047` (window closed), `131050` (opted out) and `131026` (undeliverable), is terminal and surfaces as an error.

Outbound media is uploaded once and the returned media id reused; the cache key is a SHA-256 of the content and the entry lives 25 days, inside Meta's 30-day retention. A cached id that has expired anyway (`131052`) is dropped and the media re-uploaded once.

## Formatting

WhatsApp supports only `*bold*`, `_italic_`, `~strike~`, inline code, fenced monospace blocks, lists and `>` quotes. `format.ts` degrades everything else: headings become bold lines, tables become `key: value` lines, `[text](url)` becomes `text: url`, and code is left untouched. The channel also tells the model about these limits in its system-prompt context.
