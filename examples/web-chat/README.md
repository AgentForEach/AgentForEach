# Web chat sample

One HTML file, no build step: a minimal client for the gateway that shows the real protocol.

1. `GET /negotiate` returns a Web PubSub URL with a per-user token; the page opens a WebSocket to it.
2. `POST /api/chat` returns `202 { runId, sessionId }` on Azure (the turn runs in the background), or the whole reply when running locally.
3. The reply streams back as `chat` events: `delta` (with `offset`), then `final` with the full text.

## Run it

Serve the folder (any static server) and open it:

```bash
npx serve examples/web-chat        # or: python3 -m http.server -d examples/web-chat
```

- **Local gateway** (`npm start`, see [Run locally](../../docs/getting-started.md#run-locally)): URL `http://localhost:7071`, a dev user id, and `AUTH_ALLOW_INSECURE_USER_ID_HEADER=true` in `local.settings.json`. Without `WEBPUBSUB_CONNECTION_STRING` there is no live stream; replies arrive when complete.
- **Deployed gateway**: your Function App URL and a JWT from the JWT provider you configured. (The API-key provider reads `x-api-key`, which this page doesn't send.) Add the page's origin to `agentforeach:corsAllowedOrigins` if you restricted CORS.

Replies are rendered as plain text (`textContent`), never as HTML.
