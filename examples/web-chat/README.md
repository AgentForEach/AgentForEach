# Web chat sample

One HTML file, no build step: a minimal client for the gateway that shows the real protocol.

1. `GET /negotiate` returns a URL with a per-user token (and, where the realtime service isn't protocol v1, such as AWS AppSync Events, a connection `descriptor`). The page connects with the portable realtime client, `realtime-client.js` (a generated copy of `packages/platform/src/realtime/client`; refresh it with `node scripts/sync-realtime-client.mjs`), which reconnects with a fresh token, after a jittered backoff, when the connection drops.
2. `POST /api/chat` returns `202 { runId, sessionId }` on Azure (the turn runs in the background), or the whole reply when running locally.
3. The reply streams back as `chat` events: `delta` (with `offset`), then `final` with the full text.

## Run it

Serve the folder (any static server) and open it:

```bash
npx serve examples/web-chat        # or: python3 -m http.server -d examples/web-chat
```

- **Local gateway** (`npm start`, see [Run locally](../../docs/getting-started.md#run-locally)): URL `http://localhost:7071`, a dev user id, and `AUTH_ALLOW_INSECURE_USER_ID_HEADER=true` in `local.settings.json`. Without `WEBPUBSUB_CONNECTION_STRING` there is no live stream; replies arrive when complete.
- **Deployed gateway**: your Function App URL and a JWT from the JWT provider you configured. (The API-key provider reads `x-api-key`, which this page doesn't send.) Add the page's origin to `agentforeach:corsAllowedOrigins` if you restricted CORS.

The agent's portrait in the header is drawn from the signed-in user's id (the JWT's `sub`, or the dev user id): dim while the agent is asleep, lit while a turn runs. It's the Notionists style by Zoish (CC0), rendered by DiceBear from jsDelivr; offline, the page works without it.

Replies are rendered as plain text (`textContent`), never as HTML.

The page can also recover what live delivery drops, on a gateway that serves the routes for it. After a turn is accepted it polls `GET /api/chat/runs/{runId}`, and once the run completed it shows the saved reply from `GET /api/sessions/{id}`, matched by run id (a reply shows once, live or recovered). On connect it restores unanswered forms from `GET /api/hitl/pending`, and an accepted answer (`resumed`, or `approvalAccepted`) is followed through `GET /api/hitl/{requestId}` until it names the run that continued (`resumedRunId`), whose reply it shows. Every cloud's gateway serves the two form routes ([HITL](../../docs/HITL.md#75-recovering-forms-after-a-reconnect)); a gateway without a route (the run-status route, on today's Azure and Cloudflare gateways) answers 404, and the page works as before. Connecting as another user, or to another gateway, starts a new conversation. The tests (`recovery.test.mjs`) run with `npm test`.
