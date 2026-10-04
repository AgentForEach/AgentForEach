/**
 * The Worker host: serves the gateway's route and schedule table from a
 * Worker's `fetch` and `scheduled` handlers.
 *
 * - Routes match as on Azure (`matchRoute`): case-insensitive segments,
 *   `{name}` and `{*rest}`, the most specific route winning, and a 404 when
 *   nothing matches.
 * - Every invocation runs in its own scope. Its background work is kept alive
 *   with `ctx.waitUntil` (at most 30 s after the response), and the scope is
 *   settled there, so per-invocation resources (the database pool, MCP
 *   connections) are closed after it.
 * - CORS: most routes answer preflights themselves. For a path whose routes
 *   don't accept OPTIONS, this host answers the preflight with the gateway's
 *   policy, as Azure's Functions host did. A browser response that carries
 *   no CORS headers gets them from the same policy.
 * - A handler that throws becomes a 500 with no body, as on Azure.
 */

import {
  corsHeaders,
  corsPolicy,
  matchRoute,
  openScope,
  type CorsPolicy,
  type HandlerContext,
  type HttpMethod,
  type HttpRequestLike,
  type HttpResult,
  type RouteDef,
  type ScheduleDef,
} from "@agentforeach/platform";
import { toCloudflareCron } from "./cron.js";

// Present under nodejs_compat, where vars and secrets are also in process.env.
declare const process: { env: Record<string, string | undefined> };

export interface WorkerTable {
  routes: readonly RouteDef[];
  schedules: readonly ScheduleDef[];
}

export interface WorkerHostOptions<Env> {
  /** The table, built once on first use (after `prepare` has run). */
  table: () => WorkerTable;
  /**
   * Runs before every invocation with the Worker's bindings, e.g. to map a
   * Hyperdrive binding to DATABASE_URL. Keep it idempotent.
   */
  prepare?: (env: Env) => void;
  /**
   * Requests a pack serves outside the route table (the realtime WebSocket
   * upgrades), asked first: a Response is returned as it is, with no CORS
   * added and no scope opened; undefined goes on to the routes.
   */
  intercept?: (request: Request, env: Env, ctx: WaitUntil) => Promise<Response | undefined>;
  /** CORS for routes that don't handle it themselves. Default: CORS_ALLOWED_ORIGINS. */
  cors?: () => CorsPolicy;
}

/** What `fetch` and `scheduled` need from Cloudflare's ExecutionContext. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const DEFAULT_PREFLIGHT_HEADERS = "Content-Type, Authorization";
/** Statuses whose responses must have no body. */
const NO_BODY = new Set([101, 204, 205, 304]);

function contextFor(invocationId: string): HandlerContext {
  return {
    invocationId,
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

export function createWorkerHandler<Env>(options: WorkerHostOptions<Env>) {
  let table: WorkerTable | undefined;
  const tableNow = () => (table ??= options.table());
  const policy = () => (options.cors ? options.cors() : corsPolicy(process.env.CORS_ALLOWED_ORIGINS));

  /** The preflight for a path no OPTIONS route accepts, or null when no route serves the path at all. */
  function preflight(request: Request, path: string): Response | null {
    const methods = METHODS.filter((m) => matchRoute(tableNow().routes, m, path));
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
    async fetch(request: Request, env: Env, ctx: WaitUntil): Promise<Response> {
      options.prepare?.(env);
      const intercepted = await options.intercept?.(request, env, ctx);
      if (intercepted) return intercepted;
      const url = new URL(request.url);
      const match = matchRoute(tableNow().routes, request.method, url.pathname);
      if (!match) {
        if (request.method.toUpperCase() === "OPTIONS") {
          const answer = preflight(request, url.pathname);
          if (answer) return answer;
        }
        return new Response(null, { status: 404 });
      }

      const invocationId = request.headers.get("cf-ray") ?? crypto.randomUUID();
      const opened = openScope({ invocationId, kind: "http", keepAlive: (work) => ctx.waitUntil(work) });
      let result: HttpResult;
      try {
        result = await opened.run(() =>
          match.route.handler(requestLike(request, url, match.params), contextFor(invocationId)),
        );
      } catch (err) {
        console.error(`[host] ${match.route.name} failed:`, err);
        result = { status: 500 };
      } finally {
        ctx.waitUntil(opened.settle());
      }
      return withCors(toResponse(result), request);
    },

    async scheduled(controller: { cron: string; scheduledTime: number }, env: Env, ctx: WaitUntil): Promise<void> {
      options.prepare?.(env);
      const due = tableNow().schedules.filter((s) => toCloudflareCron(s.schedule) === controller.cron);
      if (due.length === 0) console.warn(`[host] no schedule runs on cron "${controller.cron}"`);
      await Promise.all(
        due.map(async (schedule) => {
          const invocationId = `${schedule.name}-${controller.scheduledTime}`;
          const opened = openScope({ invocationId, kind: "schedule", keepAlive: (work) => ctx.waitUntil(work) });
          try {
            await opened.run(() => schedule.handler(contextFor(invocationId)));
          } catch (err) {
            console.error(`[host] schedule ${schedule.name} failed:`, err);
          } finally {
            ctx.waitUntil(opened.settle());
          }
        }),
      );
    },
  };
}
