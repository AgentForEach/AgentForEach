/**
 * The Host port: how a cloud runs the gateway's HTTP routes and schedules.
 *
 * The gateway describes its routes and schedules as data (`RouteDef`,
 * `ScheduleDef`) and writes its handlers against `HttpRequestLike` and
 * `HandlerContext`. A platform pack serves that table: Azure registers each
 * entry with `app.http` / `app.timer`, Cloudflare routes it from a Worker's
 * `fetch` and `scheduled` handlers, and so on.
 *
 * The request and context types are the subset of the Fetch API and of the
 * Azure Functions context the gateway actually uses, so Azure's own
 * `HttpRequest` and `InvocationContext` satisfy them unchanged.
 */

// ============================================================================
// Requests and responses
// ============================================================================

/** The parts of an incoming HTTP request a handler may use. */
export interface HttpRequestLike {
  /** Upper-case HTTP method. */
  readonly method: string;
  /** The full request URL. */
  readonly url: string;
  readonly headers: Pick<Headers, "get" | "has" | "forEach">;
  readonly query: Pick<URLSearchParams, "get" | "getAll" | "has" | "forEach">;
  /** Values of the `{name}` segments in the matched route. */
  readonly params: Readonly<Record<string, string>>;
  /** The body parsed as JSON. Read the body once: `json()` or `text()`. */
  json(): Promise<unknown>;
  /** The raw body, e.g. for webhook signature checks. */
  text(): Promise<string>;
}

/**
 * A handler's response. The body is always a string; set `Content-Type`
 * yourself. Hosts send `headers` as given.
 */
export interface HttpResult {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Logging and identity for one invocation (an HTTP request or a schedule tick). */
export interface HandlerContext {
  /** Unique per invocation; used to correlate logs. */
  readonly invocationId: string;
  /**
   * When the host stops this invocation (epoch ms), if it imposes a limit a
   * handler must finish under: Lambda's remaining time, or the front door's
   * request timeout. Unset where the handler's own budget is the only limit.
   * Read it through `effectiveDeadline`.
   */
  readonly deadlineAt?: number;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}

/**
 * The deadline for work with its own budget of `ownMs` from now, cut short to
 * the invocation's `deadlineAt` when that comes first. Every budget a
 * handler sets (a chat turn's, a job step's) goes through here.
 */
export function effectiveDeadline(ownMs: number, context: Pick<HandlerContext, "deadlineAt">): number {
  return Math.min(Date.now() + ownMs, context.deadlineAt ?? Infinity);
}

export type HttpHandler = (request: HttpRequestLike, context: HandlerContext) => Promise<HttpResult>;

// ============================================================================
// The route and schedule table
// ============================================================================

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/**
 * One HTTP route. Routes have no auth at the platform level: the gateway
 * authenticates every request itself.
 */
export interface RouteDef {
  /** Stable function name (Azure uses it as the function's name). */
  name: string;
  /**
   * Path template without a leading slash: literal segments, `{name}` for
   * one segment, and `{*name}` for the rest of the path.
   */
  route: string;
  methods: readonly HttpMethod[];
  handler: HttpHandler;
  /**
   * The handler starts or signals durable work. Hosts that need to bind
   * something per invocation for that (Azure: a durable client input) do so.
   */
  durable?: boolean;
}

/** One recurring schedule. */
export interface ScheduleDef {
  name: string;
  /** Six-field cron expression with seconds: `sec min hour day month weekday`. */
  schedule: string;
  handler: (context: HandlerContext) => Promise<void>;
  /** As for `RouteDef.durable`. */
  durable?: boolean;
}

// ============================================================================
// Host information
// ============================================================================

/**
 * Facts about where the gateway is running. Values may be computed on each
 * read (from the environment, for example), so read them when needed rather
 * than caching them.
 */
export interface HostInfo {
  /** Platform id: "azure", "cloudflare", "local", ... */
  readonly platform: string;
  /**
   * True on a deployed production host. Checks that must fail closed in
   * production (unsigned webhooks, header-based identities) use this.
   */
  readonly isProductionHost: boolean;
  /** The gateway's own public origin, e.g. "https://example.com", when known. */
  readonly publicBaseUrl: string | undefined;
  /** A short label for run records and logs, e.g. "azure:my-func" or "local". */
  readonly label: string;
  /**
   * The process outlives invocations, so pools, sockets and module-level
   * timers can be kept between them (Azure, Node, Lambda). False on hosts
   * that run each invocation in a short-lived isolate (Cloudflare Workers),
   * where anything doing I/O must live in the invocation scope. Default true.
   */
  readonly persistent?: boolean;
  /**
   * Background work keeps running after the response is sent (Azure: the
   * process does; Cloudflare: `waitUntil`). False where the host freezes the
   * process as soon as the invocation returns (Lambda): there the host awaits
   * the scope's background work before it returns, bounded by `deadlineAt`.
   * Independent of `persistent`: a Lambda process is persistent (pools and
   * sockets survive between invocations) but runs nothing between them.
   * Default true.
   */
  readonly backgroundAfterResponse?: boolean;
  /**
   * The longest an HTTP request may take, in ms, when the front door cuts it
   * off sooner than a chat turn can run (API Gateway: 30 s). On such a host
   * chat always runs in the background, and `POST /api/chat` with
   * `"wait": true` is refused. Unset: no such limit.
   */
  readonly maxRequestMs?: number;
  /** Child processes can be spawned (MCP `stdio` servers need this). Default true. */
  readonly subprocesses?: boolean;
}

// ============================================================================
// Invocation scope (proposed by S2; implementation follows review)
// ============================================================================

/**
 * One invocation: an HTTP request, a schedule tick, a durable job step or an
 * alarm. The host opens it around the handler; code below the handler reaches
 * it with `currentScope()` (AsyncLocalStorage), so no signature changes.
 *
 * Module functions that go with it, in `scope.ts`:
 * - `currentScope(): InvocationScope | undefined`
 * - `background(work, onError?)`: `currentScope()?.background(work)`, or,
 *   with no scope, today's detached promise with its errors logged.
 * - `openScope(options): { run<T>(fn: () => Promise<T>): Promise<T>; settle(): Promise<void> }`
 *   for hosts. `settle()` awaits the background work, then runs `onEnd`
 *   cleanups.
 */
export interface InvocationScope {
  readonly invocationId: string;
  readonly kind: InvocationKind;
  /**
   * Work the handler starts but doesn't wait for (usage records, hook
   * posts, compaction). What keeps it alive depends on the host:
   * - Azure: nothing; the process does, as today.
   * - Cloudflare HTTP: `ctx.waitUntil` (at most 30 s after the response).
   * - Cloudflare durable job: the step awaits it before it returns.
   * - Lambda (`backgroundAfterResponse: false`): the host awaits it before
   *   the invocation returns, until `deadlineAt`.
   */
  background(work: Promise<unknown>): void;
  /**
   * A resource that lives for this invocation only, created on first use:
   * a database pool or MCP connections on a host that isn't `persistent`.
   */
  resource<T>(key: ScopeKey<T>, create: () => T): T;
  /** Runs when the invocation is over, after its background work settles. */
  onEnd(cleanup: () => void | Promise<void>): void;
}

export type InvocationKind = "http" | "schedule" | "job" | "alarm";

/** Names one kind of scoped resource; compare by identity. */
export interface ScopeKey<T> {
  readonly name: string;
  /** Carries `T` for type inference only. */
  readonly __type?: T;
}

/** How a host opens a scope. */
export interface OpenScopeOptions {
  invocationId: string;
  kind: InvocationKind;
  /**
   * Called with each background promise as it is registered, e.g.
   * Cloudflare's `ctx.waitUntil`. Omitted on Azure, where background work is
   * left to the process as today.
   */
  keepAlive?: (work: Promise<unknown>) => void;
}
