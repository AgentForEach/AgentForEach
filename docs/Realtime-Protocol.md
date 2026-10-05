# AgentForEach realtime protocol v1

This is how AgentForEach clients talk to the realtime service on every cloud. Protocol v1 is the part of Azure Web PubSub's [`json.webpubsub.azure.v1`](https://learn.microsoft.com/azure/azure-web-pubsub/reference-json-webpubsub-subprotocol) subprotocol that AgentForEach uses, so:

- On Azure, Web PubSub *is* the service.
- On other clouds, a provider implements the same frames, for example Durable Objects on Cloudflare.

The web-chat client, the browser live view (`viewer.ts`) and the sandbox's browser driver (`driver.mjs`) run unchanged everywhere.

The codec lives in `@agentforeach/platform` (`src/realtime/protocol.ts`). The conformance suite that every provider must pass is `@agentforeach/platform/realtime/conformance`.

## Connecting

1. Get a URL from the gateway.
   - Chat clients call `GET /negotiate` or `POST /api/token`.
   - The browser live view gets its URLs from the handoff.
   - The access token is in the URL's query string.
2. Open a WebSocket with the subprotocol `json.webpubsub.azure.v1`.
3. Every frame in either direction is one JSON text message.

The token is checked once, at connect. An open connection outlives its token.

To reconnect, get a new URL. On self-hosted providers (Cloudflare) a URL [connects only once](#tokens-on-self-hosted-providers); Web PubSub's can be reused until they expire, but clients shouldn't rely on that.

When the service closes a connection, the `disconnected` frame and the WebSocket close frame arrive at once. On Cloudflare (workerd) the TCP connection itself ends about 10 seconds after the close handshake, so a client that waits for its socket's `close` event sees it then. Presence (`isUserOnline`) is updated immediately.

Two kinds of hub:

| Hub | Who connects | What it does |
|---|---|---|
| **Client hub** | Chat clients, as the signed-in user | Server pushes (`sendToUser`) and inbound events to the gateway |
| **Relay hub** (e.g. `<hub>_browser`) | Two parties the gateway introduced, each with a token for one group | Group messages between them. It has no event handler, so nothing reaches gateway code. |

## Service → client

```jsonc
// Right after the connection opens
{ "type": "system", "event": "connected", "userId": "<id>", "connectionId": "<id>" }

// Just before the service closes the connection
{ "type": "system", "event": "disconnected", "message": "<reason>" }

// A push from the gateway, or the gateway's reply to an event
{ "type": "message", "from": "server", "dataType": "json", "data": <JSON> }

// A message another connection sent to a group this connection is in
{ "type": "message", "from": "group", "fromUserId": "<sender>", "group": "<group>",
  "dataType": "json" | "text", "data": <JSON or string> }

// The answer to a client frame that carried an ackId
{ "type": "ack", "ackId": <int>, "success": true }
{ "type": "ack", "ackId": <int>, "success": false,
  "error": { "name": "Forbidden" | "InternalServerError" | "Duplicate", "message": "<text>" } }
```

A `disconnected` frame's `message` contains the reason the server gave, but a provider may wrap it in its own text: Azure Web PubSub sends `Application server closed the connection. Reason: <reason>`. Clients must not match the whole string.

Gateway pushes always carry an event frame as `data`: `{ "type": "event", "event": "chat" | "cron" | "error", "payload": {...}, "seq": <n> }`.

## Client → service

```jsonc
{ "type": "joinGroup",   "group": "<group>", "ackId"?: <int> }
{ "type": "leaveGroup",  "group": "<group>", "ackId"?: <int> }
{ "type": "sendToGroup", "group": "<group>", "ackId"?: <int>, "noEcho"?: <bool>,
  "dataType": "json" | "text", "data": <JSON or string> }
{ "type": "event", "event": "message", "ackId"?: <int>, "dataType": "json", "data": <client message> }
```

On the client hub, the `data` of an `event` frame is a gateway client message:
- `{ "type": "chat", ... }`
- `{ "type": "input_response", ... }`
- `{ "type": "abort", ... }`
- `{ "type": "ping" }`

The gateway's reply comes back as a `from: "server"` message. `ping` is answered with `{ "type": "pong", "ts": <ms> }`.

A frame that is not one of these, or is malformed, is ignored.

## Rules

Every provider keeps these. The conformance suite checks them.

1. **`fromUserId` is the sender's token subject.** It is never anything the sender wrote. The browser driver and viewer accept input only from the user id they expect, so this is a security property.
2. **Frames from one connection take effect in order.** A `sendToGroup` sent straight after `joinGroup`, without waiting for the ack, reaches the group.
3. **`noEcho: true` leaves out the sending connection only.** Without it, the sender gets its own message too.
4. **Permissions come from the token's roles,** written as Web PubSub role strings:
   - `webpubsub.joinLeaveGroup[.<group>]`
   - `webpubsub.sendToGroup[.<group>]`

   Outside them, `joinGroup`, `leaveGroup` and `sendToGroup` fail with ack `Forbidden`, or are dropped silently when there is no `ackId`. Sending to a group does not require being in it.
5. **Each `ackId` is acted on once per connection.** A repeat gets `Duplicate` and changes nothing.
6. **Events reach the gateway only from the client hub.**
   - There, the reply (if any) is sent before the ack.
   - A handler failure acks `InternalServerError`.
   - A relay hub never passes an event to gateway code.
7. **A frame larger than 1 MiB is never delivered, and closes the sender's connection.** Self-hosted providers (Cloudflare) send a `disconnected` frame first; Azure Web PubSub closes it without one.
8. **Hubs are isolated.** The same group name on two hubs is two different groups.

## Tokens on self-hosted providers

Providers that run their own sockets issue sealed tokens: the claims below, encrypted with AES-256-GCM. Each token has its own key, derived with HKDF-SHA256 from a deployment secret and 16 random bytes of salt that the token carries: `v2.` + base64url of salt, IV, ciphertext and tag. A logged URL shows nothing about its user, and a changed token fails to open. Only the canonical base64url spelling is accepted, and tokens over 8,192 characters are refused unread. Earlier formats (`v1.`) are refused; tokens live for minutes, so none outlast an upgrade. The claims:

| Claim | Meaning |
|---|---|
| `sub` | User id |
| `aud` | The URL path, `/realtime/client` or `/realtime/relay` |
| `hub` | Hub name |
| `role` | Web PubSub role strings |
| `groups` | Optional; groups the connection starts in |
| `exp` | Expiry, in seconds |
| `jti` | Ticket id: the URL connects once |

**Each URL is a one-time ticket.** The token is in the URL's query string, because browsers can't set headers on a WebSocket, and request logs record URLs, so a token in a log must already be spent. The object that holds the connection redeems the `jti`:
- **A client URL connects once.** A second connection with it is refused (401), even after the first has closed. Clients get a new URL (`/negotiate`, `/api/token`) for each connection.
- **A relay URL has one connection at a time.** It may connect again only within 30 seconds after that connection closed, so the browser's live view survives a page reload.

The Worker passes the verified identity to the object in a header, and leaves the token out of the URL it forwards.

Web PubSub issues its own tokens, with the same role strings.
