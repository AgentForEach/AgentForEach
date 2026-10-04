# Test fixtures

Servers that end-to-end tests run beside a gateway (Azure Functions locally, or a Worker under `wrangler dev`). None of them is used in production.

- [`mcp-gated-tool.mjs`](mcp-gated-tool.mjs): an MCP server with one tool, `send_note`, over Streamable HTTP. With a HITL policy that gates `fixture_send_note`, a call suspends the run until the user answers the form or it times out, which exercises the durable wait end to end. Its header has the gateway config to use. `GET /calls` lists the calls the tool received. Answer a gated call with a realtime `input_response` (`{"type":"input_response","requestId":"<id>","data":{...}}`): on Azure, `POST /ws/message` with the Web PubSub CloudEvent headers, which exists only when a realtime provider is configured. `hitlInputResponse` on `/api/chat` answers direct forms only, not gated tools.
- [`cloudflare-sandbox-worker/`](cloudflare-sandbox-worker/README.md): a test Worker with the real Cloudflare sandbox backend behind a bearer-protected `/rpc`, for `scripts/test-sandbox-conformance-live.mjs cloudflare-containers`. Deploy it only for a live run, and delete it afterwards.
