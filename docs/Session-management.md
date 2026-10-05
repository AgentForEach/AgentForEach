# Sessions and messages

How AgentForEach stores conversations, keeps each user's messages private, and compacts long histories.

Code: `gateway/sessions/`. Tests: `sessions/*.test.ts`.

## Data model

Two Cosmos DB containers:

| Container | Partition key | Holds | TTL |
|---|---|---|---|
| `sessions` | `/userId` | One doc per (user, session): `messageSeq`, compaction summary, conversation state, channel metadata, `instanceId` | `ttlSeconds` (24 h), refreshed on every message |
| `session-messages-v2` | `/pk` = `{userId}:{sessionId}:{instanceId}` | One doc per message | `messageTtlSeconds` per doc (7 days) |

- The session doc id is `{userId}:{sessionId}`, so two users with the same `sessionId` have two separate sessions.
- `instanceId` is a random id minted when a session doc is **created**. It's part of the message partition key, so a session that is deleted (`/new`) or expires and is then recreated with the same `sessionId` starts with an empty history and fresh message ids.
- Message doc id: `{instanceId}:{seq}`.

## Isolation

Messages are only reachable through their owner's session. `SessionStore.getMessages(userId, sessionId)`, `getAllMessages`, `findByIdempotencyKey`, `getProviderHistory`, `delete` and compaction all load the session for the authenticated user first and build the partition key from it (`messagePartitionKey(session)`). There's no API that reads messages by `sessionId` alone, and no cross-partition query on the messages container.

Client-supplied session ids (API, WebSocket, cron) must be 1–128 characters of letters, digits, `.`, `_` or `-` (`sessions/ids.ts`). Channel sessions use `{channel}-{chatId}` and are built by the server.

Writes carry the instance they were meant for. A reply or compaction that finishes after the user ran `/new` is refused (`SessionReplacedError`), rather than landing in the new conversation.

## Group chats

In a Telegram or WhatsApp group, each linked member has their **own** session, keyed `{userId}:{channel}-{chatId}`. The bot sees each member's own conversation with it, not the other members' messages, and `/new` resets only the caller's history. Members who resolve to the channel's default user share that user's session.

## Compaction

Long histories are summarised by the LLM, and the summary lives on the session doc:
- **By count:** when the messages since the last compaction reach `compactionThreshold` (60). Only messages beyond `compactionRetainCount` (20) are summarised and then deleted.
- **By age:** when there's anything beyond the retain window and the last compaction (or the session's start) is older than half of `messageTtlSeconds`. This guarantees messages are summarised before they expire.

If the range to compact is empty (for example, a session from before the current container), the marker still advances, so the empty range isn't queried on every turn.

## Configuration (`sessions` in agentforeach.json)

| Setting | Default | Meaning |
|---|---|---|
| `containerId` | `sessions` | Session docs |
| `messagesContainerId` | `session-messages-v2` | Message docs; must be partitioned on `/pk` |
| `ttlSeconds` | `86400` | Session inactivity TTL |
| `messageTtlSeconds` | `604800` | Message doc TTL. Messages of an expired session can't be read again, so this bounds what they cost; active sessions are compacted by age at half this value. `0` = never |
| `runStatusTtlSeconds` | `604800` | How long a chat turn's status record (`GET /api/chat/runs/{runId}`, container `chat-runs`) lives after its last change. `0` = never |
| `maxHistoryMessages` | `100` | Recent messages loaded into the LLM context |
| `compactionThreshold` | `60` | Messages since the last compaction that trigger it |
| `compactionRetainCount` | `20` | Recent messages kept verbatim after compaction |

## Upgrading from the `session-messages` container

Earlier versions stored messages in `session-messages`, partitioned on `/sessionId`. That layout let one user read another user's chat by reusing their session id, so it was replaced rather than migrated.

1. **Config:** if your agentforeach.json sets `"messagesContainerId": "session-messages"`, change it to `"session-messages-v2"` (or remove it). Startup fails with a clear error if the configured container isn't partitioned on `/pk`.
2. **IaC:** `pulumi up` creates `session-messages-v2`. If the runtime created it first, import it into the stack (`pulumi import`).
3. **What users see at cutover:** conversations keep their compaction summary and response chain, but messages from before the upgrade no longer appear in the message list or the LLM's recent history. Sessions created after the upgrade are unaffected.
4. **Rolling deploys:** instances still on the old version keep writing to the old container until they're replaced, so for a short time a user's recent history may be split.
5. **Clean up:** nothing reads `session-messages` any more. Delete it once the deploy has finished; it still contains every pre-upgrade message.
