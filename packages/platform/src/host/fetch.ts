/**
 * The route table served from Fetch API requests: the part every host that
 * receives raw requests shares (the Cloudflare Worker, Lambda behind API
 * Gateway). Each host only translates its own event to a `Request` and the
 * `Response` back, and says what keeps the invocation's background work
 * alive.
 *
 * - Routes match as on Azure (`matchRoute`): case-insensitive segments,
 *   `{name}` and `{*rest}`, the most specific route winning, and a 404 when
 *   nothing matches.
 * - Every request runs in its own invocation scope. The host's `settle`
 *   decides what happens to it once the handler has answered: a Worker hands
 *   it to `ctx.waitUntil`; Lambda awaits it, until the deadline.
 * - CORS: most routes answer preflights themselves. For a path whose routes
 *   don't accept OPTIONS, the host answers the preflight with the gateway's
 *   policy, as Azure's Functions host does. A browser response that carries
 *   no CORS headers gets them from the same policy.
 * - A handler that throws becomes a 500 with no body, as on Azure.
 */

import { corsHeaders, corsPolicy, type CorsPolicy } from "../cors.js";
import type { HandlerContext, HttpMethod, HttpRequestLike, HttpResult, RouteDef } from "../host.js";
import { matchRoute } from "../routing.js";
import { openScope, type OpenedScope } from "../scope.js";

export interface FetchHostOptions {
  /** The routes; called on each request, so the host can build its table on first use. */
  routes: () => readonly RouteDef[];
  /** CORS for routes that don't handle it themselves. Default: CORS_ALLOWED_ORIGINS. */
  cors?: () => CorsPolicy;
}

/** One request's invocation, as the host runs it. */
export interface FetchInvocation {
  invocationId: string;
  /** Sets `HandlerContext.deadlineAt`. */
  deadlineAt?: number;
  /** Each background promise as it is registered (`OpenScopeOptions.keepAlive`). */
  keepAlive?: (work: Promise<unknown>) => void;
  /**
   * The scope once the handler has answered (or thrown). The response is
   * sent when what this returns settles: return nothing to send it at once.
   */
  settle: (opened: OpenedScope, route: RouteDef) => void | Promise<void>;
}

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const DEFAULT_PREFLIGHT_HEADERS = "Content-Type, Authorization";
/** Statuses whose responses must have no body. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** A handler context that logs to the console, for hosts with no logger of their own. */
export function consoleContext(invocationId: string, deadlineAt?: number): HandlerContext {
  return {
    invocationId,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    trace: (...args) => console.debug(...args),
  };
}

function requestLike(request: Request, url: URL, params: Record<string, string>): HttpRequestLike {
  return {
    method: request.method.toUpperCase(),
    url: request.url,
    headers: request.headers,
    query: url.searchParams,
    params,
    json: () => request.json(),
    text: () => request.text(),
  };
}

function toResponse(result: HttpResult): Response {
  const status = result.status ?? 200;
  return new Response(NO_BODY.has(status) ? null : (result.body ?? null), { status, headers: result.headers });
}

export function createFetchHost(options: FetchHostOptions) {
  const policy = () => (options.cors ? options.cors() : corsPolicy(process.env.CORS_ALLOWED_ORIGINS));

  /** The preflight for a path no OPTIONS route accepts, or null when no route serves the path at all. */
  function preflight(request: Request, path: string): Response | null {
    const routes = options.routes();
    const methods = METHODS.filter((m) => matchRoute(routes, m, path));
    if (methods.length === 0) return null;
    return new Response(null, {
      status: 204,
      headers: corsHeaders(policy(), request.headers.get("origin"), {
        methods: [...methods, "OPTIONS"].join(","),
        headers: request.headers.get("access-control-request-headers") ?? DEFAULT_PREFLIGHT_HEADERS,
      }),
    });
  }

  /** Add the policy's origin headers to a browser response that set none. */
  function withCors(response: Response, request: Request): Response {
    const origin = request.headers.get("origin");
    if (!origin || response.headers.has("access-control-allow-origin")) return response;
    const cors = corsHeaders(policy(), origin, { methods: request.method, headers: DEFAULT_PREFLIGHT_HEADERS });
    const headers = new Headers(response.headers);
    for (const name of ["Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Vary"]) {
      if (cors[name]) headers.set(name, cors[name]);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  return {
    /** Route the request and run its handler in a scope; the response, with CORS added where needed. */
    async dispatch(request: Request, invocation: FetchInvocation): Promise<Response> {
      const url = new URL(request.url);
      const match = matchRoute(options.routes(), request.method, url.pathname);
      if (!match) {
        if (request.method.toUpperCase() === "OPTIONS") {
          const answer = preflight(request, url.pathname);
          if (answer) return answer;
        }
        return new Response(null, { status: 404 });
      }

      const { invocationId, deadlineAt } = invocation;
      const opened = openScope({ invocationId, kind: "http", keepAlive: invocation.keepAlive });
      let result: HttpResult;
      try {
        result = await opened.run(() =>
          match.route.handler(requestLike(request, url, match.params), consoleContext(invocationId, deadlineAt)),
        );
      } catch (err) {
        console.error(`[host] ${match.route.name} failed:`, err);
        result = { status: 500 };
      }
      await invocation.settle(opened, match.route);
      return withCors(toResponse(result), request);
    },
  };
}
