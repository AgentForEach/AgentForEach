# Channel Identity Registry — Architecture & Pairing Guide

> Maps channel-specific sender IDs (Telegram user 12345, Discord user abc) to canonical AgentForEach user IDs, enabling multi-channel identity unification and multi-user deployments.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Design Principles](#2-design-principles)
3. [Architecture Overview](#3-architecture-overview)
4. [Data Model](#4-data-model)
5. [Identity Resolution](#5-identity-resolution)
6. [Pairing Flow](#6-pairing-flow)
7. [Admin API](#7-admin-api)
8. [Integration Points](#8-integration-points)
9. [Configuration](#9-configuration)
10. [Backward Compatibility](#10-backward-compatibility)
11. [Source Files](#11-source-files)

---

## 1. Problem Statement

AgentForEach partitions all data (sessions, memories, prompt-docs, usage, cron-jobs) by `userId` in Cosmos DB. Without identity resolution:

- **Single-user only**: Telegram plugin hardcodes `userId: config.defaultUserId` for all messages — every sender shares one identity.
- **No cross-channel unification**: A user on Telegram and the same user on the WebSocket dashboard are treated as different people.
- **No multi-user support**: Adding a second user requires deploying a separate AgentForEach instance.

The Channel Identity Registry solves all three by mapping `(channel, channelSenderId)` to a canonical `userId` in the database.

---

## 2. Design Principles

| Principle | Rationale |
|-----------|-----------|
| **Database-only mappings** | `agentforeach.json` stays global/static deployment config. All user-specific identity data lives in Cosmos DB — never in config files. |
| **Stateless gateway** | The webhook/WebSocket handlers do a per-request DB lookup. No in-memory state beyond the cached store reference. |
| **Backward compatible** | With no identity links, a sender falls back to `config.defaultUserId`, but only if the channel has an `authorizedSenders` allowlist; without one the channel refuses to register (see [Backward Compatibility](#10-backward-compatibility)). |
| **Self-service pairing** | Users pair channels themselves via short-lived codes — no admin intervention needed for routine linking. |
| **Fails closed** | If identity is enabled but its store can't be initialized (e.g. Cosmos is unreachable), channel turns are refused and the bootstrap is retried after 30 s. Falling back would resolve every sender to the default user. |

---

## 3. Architecture Overview

```
                     ┌─────────────────────────────────────────────┐
                     │           AgentForEach Gateway                     │
                     │                                              │
  Telegram ──webhook──▶ channel-webhook.ts                         │
  Discord  ──webhook──▶   │                                        │
  LINE     ──webhook──▶   ├─ ensureIdentityStore()                 │
                     │    ├─ plugin.parseInbound()                  │
                     │    └─▶ processInbound()  ◀── router.ts      │
                     │         │                                    │
                     │         ├─ 1. tryPairChannel()               │
                     │         │     └─ consumePairingCode()        │
                     │         │     └─ upsertLink()                │
                     │         │                                    │
                     │         ├─ 2. resolveChannelIdentity()       │
                     │         │     └─ store.resolveByChannel()    │
                     │         │     └─ fallback (config / sender)  │
                     │         │                                    │
                     │         ├─ 3. AgentClient.send({            │
                     │         │       userId: resolvedUserId })     │
                     │         │                                    │
                     │         └─ 4. plugin.sendOutbound(reply)     │
                     │                                              │
  Web/Mobile ──WS──▶ ws-message.ts                                 │
                     │    userId from auth (ce-userId header)       │
                     │    └─▶ AgentClient.send()                  │
                     │         (no identity resolution needed)      │
                     │                                              │
  REST API ──HTTP──▶ api.ts                                        │
                     │    userId from auth (resolveAuthContext)     │
                     │    ├─ POST /api/identity/pair                │
                     │    ├─ GET  /api/identity/links               │
                     │    ├─ POST /api/identity/links               │
                     │    └─ DELETE /api/identity/links/{linkId}    │
                     └─────────────────────────────────────────────┘
                                        │
                          ┌─────────────┴──────────────┐
                          ▼                            ▼
                  ┌───────────────┐          ┌──────────────────┐
                  │ identity-links│          │ identity-pairing │
                  │   (Cosmos DB) │          │   (Cosmos DB)    │
                  │               │          │                  │
                  │ PK: /userId   │          │ PK: /code        │
                  │ ID: chan:uid  │          │ ID: code         │
                  │               │          │ TTL: 300s        │
                  └───────────────┘          └──────────────────┘
```

**Key insight**: WebSocket and REST API paths get `userId` from authentication (Easy Auth / JWT). Only channel webhooks need identity resolution — they receive an unauthenticated sender ID from the channel platform.

---

## 4. Data Model

### IdentityLink

Stored in the `identity-links` Cosmos DB container. Partition key: `/userId`.

```typescript
{
  id: "telegram:12345",        // {channel}:{channelUserId}
  userId: "alice",       // canonical AgentForEach user ID
  channel: "telegram",         // channel identifier (lowercase)
  channelUserId: "12345",      // channel-specific sender ID
  displayName: "Alice",  // informational (from channel profile)
  channelUsername: "@alice",   // informational (from channel profile)
  linkedVia: "pairing-code",   // "admin" | "pairing-code"
  linkedAt: "2026-02-24T..."   // ISO-8601 timestamp
}
```

**One AgentForEach user can have multiple links** (e.g., Telegram + Discord + WhatsApp). A `(channel, channelUserId)` pair maps to exactly one AgentForEach user.

### Channel index

Stored in the `identity-channel-index` container. Partition key: `/id`. One document per channel account, so ownership is unique by construction:

```typescript
{
  id: "telegram:12345",        // {channel}:{channelUserId}
  userId: "alice",       // current owner
  updatedAt: "2026-09-29T..."
}
```

The index is authoritative. Linking writes the index first, then the link doc in the owner's partition, and removes a previous owner's link doc.

### PairingCode

Stored in the `identity-pairing` Cosmos DB container. Partition key: `/code`. Auto-expires via Cosmos DB TTL.

```typescript
{
  id: "A3X9K2",               // the pairing code itself
  code: "A3X9K2",             // same as id (for query convenience)
  userId: "alice",      // who requested the code
  expiresAt: "2026-02-24T...",
  ttl: 300                    // 5 minutes (Cosmos DB auto-delete)
}
```

A code is consumed by **deleting** it, which is atomic: of two concurrent consumers, exactly one wins. The same container also holds a per-sender counter of failed attempts (id `attempts:{channel}:{senderId}`, TTL `pairingAttemptWindowSeconds`).

**Code alphabet**: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 chars — no `0/O` or `1/I` to avoid ambiguity). Default length: 6 characters (32^6 = ~1 billion combinations).

---

## 5. Identity Resolution

Every inbound channel message goes through a 3-tier resolution in `resolveChannelIdentity()`:

```
1. Database lookup ──▶ Found IdentityLink?
   │                    YES → return userId (source: "identity-link")
   │
2. Config fallback ──▶ fallbackMode = "config-default" AND channel has defaultUserId?
   │                    YES → return defaultUserId (source: "config-default")
   │
3. Sender passthrough ──▶ return "{channel}:{senderId}" (source: "sender-id-passthrough")
```

| Tier | Source | When Used | Example userId |
|------|--------|-----------|----------------|
| 1 | `identity-link` | IdentityLink exists in DB | `"alice"` |
| 2 | `config-default` | No link, `fallbackMode: "config-default"`, channel config has `defaultUserId` | `"owner"` (from the channel config) |
| 3 | `sender-id-passthrough` | No link, no config default (or `fallbackMode: "sender-passthrough"`) | `"telegram:12345"` |

**Priority**: Identity link always wins over config default. This ensures that once a user pairs a channel, the pairing takes precedence regardless of what `defaultUserId` is set to.

**Config-default needs an allowlist.** Tier 2 runs a stranger as the configured default user, so a channel refuses to register in that state unless it has `authorizedSenders`, and the router also refuses any such turn (defence in depth).

**Refused turns:**
- *Identity store unavailable* (identity enabled, e.g. Cosmos down): the webhook answers `503` so the provider redelivers. Bootstrap retries at most every 30 s.
- *Conflict* (only with `legacyLinkLookup`): legacy link docs disagree on the owner. An admin re-links the account with `POST /api/identity/links`.

### Lookup cost

Resolution is a point read on the channel index plus a point read on the owner's link doc (about 2 RU), whatever the number of users. Deployments with links created before the index should run the backfill once after upgrading, as an admin:

```bash
curl -X POST https://<app>/api/identity/backfill-index -H "Authorization: Bearer <admin token>"
# {"indexed":412,"alreadyIndexed":0,"conflicts":0}
```

It indexes every existing link in one cross-partition scan. Accounts whose link docs disagree on the owner are counted in `conflicts` and left unresolved until an admin re-links them. Running it again is safe.

Alternatively, `legacyLinkLookup: true` backfills lazily: an index miss falls back to a cross-partition query and indexes what it finds. A miss is remembered for 10 minutes per account, so unlinked senders don't cost a query per message. Prefer the backfill; the lazy path has no clear point at which it can be turned off.

---

## 6. Pairing Flow

Self-service pairing lets a user link their channel account to their AgentForEach identity without admin intervention.

### Step-by-Step

```
 User (browser/app)                AgentForEach API                  AgentForEach (Telegram)
      │                                │                              │
      │  POST /api/identity/pair       │                              │
      │  (authenticated)               │                              │
      ├───────────────────────────────▶│                              │
      │                                │ ┌──────────────────────┐     │
      │                                │ │ Generate code "A3X9K2"│     │
      │                                │ │ Store in Cosmos DB    │     │
      │                                │ │ TTL: 300 seconds      │     │
      │                                │ └──────────────────────┘     │
      │  { code: "A3X9K2",            │                              │
      │    expiresIn: 300 }            │                              │
      │◀───────────────────────────────┤                              │
      │                                │                              │
      │  User opens Telegram and                                      │
      │  sends "A3X9K2" to the bot     │                              │
      │                                │                              │
      │                                │  Telegram webhook fires      │
      │                                │◀─────────────────────────────┤
      │                                │                              │
      │                                │ ┌──────────────────────────┐ │
      │                                │ │ processInbound():        │ │
      │                                │ │  1. tryPairChannel()     │ │
      │                                │ │  2. Message is 6 chars,  │ │
      │                                │ │     alphanumeric → code? │ │
      │                                │ │  3. consumePairingCode() │ │
      │                                │ │     → userId       │ │
      │                                │ │  4. upsertLink({         │ │
      │                                │ │       telegram:12345 →   │ │
      │                                │ │       alice })           │ │
      │                                │ └──────────────────────────┘ │
      │                                │                              │
      │                                │  "Paired! Your Telegram      │
      │                                │   account is now linked..."  │
      │                                │──────────────────────────────▶│
      │                                │                              │
      │  All future Telegram messages                                 │
      │  from user 12345 now resolve                                  │
      │  to userId "alice"                                      │
```

### Code Detection Logic

In `tryPairChannel()`, a message is treated as a potential pairing code only if:
1. Message text length equals `pairingCodeLength` (default: 6)
2. After `.trim().toUpperCase()`, it uses only the code alphabet (no `0`, `O`, `1`, `I`)

If both conditions pass, the code is looked up in the pairing container. If valid (exists, not expired), it is deleted (consumed) and the link is created.

Short words made only of code-alphabet letters (e.g. "THANKS") are looked up too. For **unlinked** senders a miss counts as a failed attempt: after `pairingMaxFailedAttempts` (10) within `pairingAttemptWindowSeconds` (15 min) the sender can't pair until the window passes (logged as a warning). Linked senders chatting normally never accumulate failures.

---

## 7. Admin API

All endpoints require authentication via `resolveAuthContext()` (see `docs/EasyAuth.md` for providers).

### `POST /api/identity/pair`

Generate a pairing code for the authenticated user.

```bash
curl -X POST https://<host>/api/identity/pair \
  -H "Authorization: Bearer <token>"
```

Response:
```json
{
  "code": "A3X9K2",
  "expiresIn": 300,
  "expiresAt": "2026-02-24T10:05:00.000Z"
}
```

Returns `429` when the user already holds `maxActivePairingCodes` (5) unexpired codes.

### `GET /api/identity/links`

List all channel links for the authenticated user.

```bash
curl https://<host>/api/identity/links \
  -H "Authorization: Bearer <token>"
```

Response:
```json
{
  "links": [
    {
      "id": "telegram:12345",
      "userId": "alice",
      "channel": "telegram",
      "channelUserId": "12345",
      "displayName": "Alice",
      "linkedVia": "pairing-code",
      "linkedAt": "2026-02-24T10:00:00.000Z"
    }
  ]
}
```

### `POST /api/identity/links`

**Admin only.** Create an identity link directly, optionally for another user (`userId`, defaults to the caller). Everyone else links a channel account by pairing: the code sent from the channel proves the sender controls it. A non-admin gets `403`.

The admin role is `auth.settings.adminRole` (default `"admin"`) in the caller's `AuthContext.roles`, which providers fill from:
- **Easy Auth / JWT:** role claims (e.g. an Entra app role named `admin`);
- **API key:** `keys[].roles` in the `api-key` provider config;
- **Trusted proxy:** `defaultRoles`, which every user the proxy lets through gets, so never `admin`. The proxy must also send `sharedSecret` (`x-proxy-secret`), or the provider refuses every request.

```bash
curl -X POST https://<host>/api/identity/links \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "channel": "telegram", "channelUserId": "12345" }'
```

With explicit target user:
```json
{
  "channel": "discord",
  "channelUserId": "abc123",
  "userId": "another-user"
}
```

### `DELETE /api/identity/links/{linkId}`

Unlink a channel. `linkId` format: `{channel}:{channelUserId}`.

```bash
curl -X DELETE https://<host>/api/identity/links/telegram:12345 \
  -H "Authorization: Bearer <token>"
```

Response:
```json
{ "deleted": true }
```

---

## 8. Integration Points

### Channel Webhook Handler (`handlers/channel-webhook.ts`)

Calls `ensureIdentityStore()` before `processInbound()` to lazily bootstrap the identity store on first inbound message.

### Channel Router (`channels/router.ts`)

The single integration point. `processInbound()` was modified to:
1. Try pairing code detection (returns early with confirmation if matched)
2. Resolve channel identity via `resolveChannelIdentity()`
3. Override `userId` on the `SendRequest` with the resolved value

The resolved `userId` is placed after the `...partial` spread to ensure identity-link always takes precedence over the channel plugin's `defaultUserId`.

### AgentClient (`client/client.ts`)

Creates and initializes the `IdentityStore` in the client's `initialize()` method alongside other stores. Calls `setIdentityStore(store)` on the router after initialization.

### Identity Store Bootstrap (`channels/index.ts`)

Uses a **promise guard** (not a boolean flag) so concurrent webhook requests all await the same initialization rather than racing past a flag. Also checks if the client already initialized the store before creating a redundant instance.

### WebSocket Handler (`handlers/ws-message.ts`)

**No changes needed.** WebSocket connections already have an authenticated `userId` from the `ce-userId` header (set by Azure Web PubSub after token authentication). Identity resolution is purely a channel concern.

---

## 9. Configuration

Add to `agentforeach.json`:

```json
{
  "identity": {
    "enabled": true,
    "fallbackMode": "config-default"
  }
}
```

### All Options

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Enable/disable identity resolution |
| `fallbackMode` | `"config-default"` | What to do when no identity link exists. `"config-default"` = use channel's `defaultUserId`. `"sender-passthrough"` = use `{channel}:{senderId}` |
| `containerId` | `"identity-links"` | Cosmos DB container name for identity links |
| `pairingContainerId` | `"identity-pairing"` | Cosmos DB container name for pairing codes |
| `channelIndexContainerId` | `"identity-channel-index"` | Cosmos DB container for the channel-account owner index |
| `legacyLinkLookup` | `false` | On an index miss, look up pre-index links across partitions and backfill (prefer `POST /api/identity/backfill-index`) |
| `pairingCodeTtlSeconds` | `300` | Pairing code expiry (5 minutes) |
| `pairingCodeLength` | `6` | Length of generated pairing codes |
| `pairingMaxFailedAttempts` | `10` | Failed pairing attempts allowed per unlinked sender per window |
| `pairingAttemptWindowSeconds` | `900` | Window for failed attempts (15 minutes) |
| `maxActivePairingCodes` | `5` | Unexpired pairing codes one user may hold |

### Deployment Scenarios

**Single-user:**
```json
{
  "identity": {
    "enabled": true,
    "fallbackMode": "config-default"
  },
  "channels": { "telegram": { "authorizedSenders": ["<your numeric Telegram id>"] } }
}
```
Messages from your account run as the channel's `defaultUserId`. `authorizedSenders` is required: without it the channel refuses to start, because any stranger would run as you.

**Multi-user with pairing:**
```json
{
  "identity": {
    "enabled": true,
    "fallbackMode": "sender-passthrough"
  }
}
```
Users pair their channels via pairing codes. Unpaired senders get unique IDs like `telegram:12345` (isolated data, can pair later).

**Identity disabled:**
```json
{
  "identity": {
    "enabled": false
  }
}
```
Store is not initialized. Channel messages use `config.defaultUserId`, which again requires `authorizedSenders`.

---

## 10. Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| No `identity` section in agentforeach.json | Identity disabled; `fallbackMode` still resolves to `"config-default"`, so channels need `authorizedSenders` |
| `identity.enabled: false` | Store not initialized → config-default fallback (allowlist required) |
| Existing Telegram setup with `defaultUserId` and no `authorizedSenders` | **Refuses to register.** Set `authorizedSenders` (numeric ids), or switch to `sender-passthrough` and pair |
| Telegram/WhatsApp without a webhook secret | Rejected in the cloud; locally only with `ALLOW_UNSIGNED_WEBHOOKS=true` |
| Links created before the channel index | Set `legacyLinkLookup: true` until every linked account has messaged once |
| New multi-user deployment | Set `fallbackMode: "sender-passthrough"`, use pairing codes; admins can link via the API |
| Identity store initialization fails | Channel turns are refused with `503` (provider retries); bootstrap retries every 30 s |

---

## 11. Source Files

### Identity Module

| File | Purpose |
|------|---------|
| `identity/types.ts` | `IdentityLink`, `PairingCode`, `IdentityResolution`, `IdentityJsonConfig` |
| `identity/config.ts` | Config loader (defaults, caching, `loadIdentityConfig()`) |
| `identity/store.ts` | `IdentityStore` class — Cosmos DB operations for links + pairing codes |
| `identity/resolver.ts` | `resolveChannelIdentity()` — 3-tier resolution. `tryPairChannel()` — code detection |
| `identity/index.ts` | Barrel exports |
| `identity/identity.test.ts` | 27 unit tests (link CRUD, pairing codes, resolution, pairing flow) |

### Modified Files

| File | Change |
|------|--------|
| `channels/router.ts` | Added identity resolution to `processInbound()` + module-level store ref |
| `channels/index.ts` | Added `ensureIdentityStore()` with promise guard, bootstrap logic |
| `handlers/channel-webhook.ts` | Added `ensureIdentityStore()` call before processing |
| `handlers/api.ts` | Added 4 identity API endpoints (pair, list, create, delete) |
| `client/client.ts` | Initializes `IdentityStore` in `initialize()`, wires into router |
| `channels/router.test.ts` | 14 router integration tests for identity resolution + pairing |
| `tsconfig.json` | Added `identity/**/*.ts` to includes |
| `package.json` | Added `test:identity` script, updated main `test` script |

### Reference Files (unchanged)

| File | Relevance |
|------|-----------|
| `handlers/ws-message.ts` | WebSocket flow — uses `ce-userId` from auth, no changes needed |
| `channels/telegram/plugin.ts` | `toSendRequest()` returns `userId: config.defaultUserId` — becomes fallback |
| `sessions/store.ts` | Pattern reference for IdentityStore constructor/init |
| `database/client.ts` | Cosmos DB provider — used by IdentityStore |
