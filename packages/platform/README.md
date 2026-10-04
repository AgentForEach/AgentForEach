# @agentforeach/platform

The cloud-neutral ports behind AgentForEach. The gateway is written against these contracts. Each cloud plugs in as a **platform pack** (`@agentforeach/platform-azure`, `@agentforeach/platform-cloudflare`, ...) that implements them and passes each port's conformance suite.

| Port | What the gateway needs | Status |
|---|---|---|
| **Host** | Serve the route and schedule table; request and context types; host information | In this package (`host.ts`, `routing.ts`) |
| **Durable** | Jobs, waits and alarms for background turns, approvals and the cron scheduler | In progress |
| **Database** | The `@agentforeach/storage` contract | Done: `packages/storage` |
| **Object store** | Skills and file exports | In progress |
| **Realtime** | Pushing events to users and relaying the browser live view | In progress |
| **Sandbox** | Per-user sandboxes | In progress |

## Host

The gateway describes every HTTP route and schedule as data (`RouteDef`, `ScheduleDef`) in `gateway/routes.ts`. Its handlers take `HttpRequestLike` and `HandlerContext` and return `HttpResult`. These are the parts of the Fetch API and of the Azure Functions context that the gateway uses, so Azure's own request and context objects satisfy them unchanged.

A host serves the table:

- **Azure** registers each entry with `app.http` / `app.timer` (`registerFunctions` in `@agentforeach/platform-azure`).
- **Hosts that receive raw requests** (a Worker, a Node server, a Lambda function URL) pick the route with `matchRoute`. It follows Azure's rules: segment-wise and case-insensitive matching, `{name}` and `{*rest}` parameters, and the most specific route wins.

A platform's entry point installs its `HostInfo` (platform id, whether it is a production host, its public URL, and a label) so that checks which must fail closed in production work on every cloud.

It has no runtime dependencies.
