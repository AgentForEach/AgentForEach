/**
 * @agentforeach/platform: the cloud-neutral ports.
 *
 * Each port is a small contract the gateway relies on. A platform pack
 * (`@agentforeach/platform-azure`, `@agentforeach/platform-cloudflare`, ...)
 * implements them for one cloud, and passes each port's conformance suite.
 */

export type {
  HttpRequestLike,
  HttpResult,
  HandlerContext,
  HttpHandler,
  HttpMethod,
  RouteDef,
  ScheduleDef,
  HostInfo,
  InvocationScope,
  InvocationKind,
  ScopeKey,
  OpenScopeOptions,
} from "./host.js";
export { effectiveDeadline } from "./host.js";
export { consoleContext, createFetchHost, type FetchHostOptions, type FetchInvocation } from "./host/fetch.js";
export { cronMatcher, minuteCron } from "./host/cron.js";
export { matchRoute, type RouteMatch } from "./routing.js";
export { background, currentScope, openScope, scopeKey, type OpenedScope, type SettleOutcome } from "./scope.js";
export { corsHeaders, corsPolicy, type CorsPolicy } from "./cors.js";
export { readBodyBytes, readBodyText, type ResponseWithBody } from "./http/body.js";

// Object store port and the memory and s3 providers.
export * from "./objects/index.js";

// Sandbox port.
export type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxPersistenceLimits,
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileWriteArgs,
  SandboxFileWriteResult,
  SandboxFileReadArgs,
  SandboxFileReadResult,
  SandboxFileReadBinaryResult,
  SandboxFileExportResult,
  SandboxFileInfo,
  EgressCredential,
} from "./sandbox/types.js";
export { SandboxPersistenceLimitError, SandboxUnsupportedError } from "./sandbox/types.js";
export {
  SandboxServerClient,
  SandboxServerError,
  execRequestTimeoutMs,
  type SandboxServerClientOptions,
  type SandboxServerTransport,
} from "./sandbox/server-client.js";

// Realtime port, protocol v1, the shared hub and the memory provider.
export * from "./realtime/index.js";
// Durable port: jobs, waits and alarms, and the in-memory implementation.
export * from "./durable/index.js";
export { encodeSandboxIdentifier, sandboxIdentifierOwner } from "./sandbox/identifier.js";
