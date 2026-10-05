/**
 * The Worker host: serves the gateway's route and schedule table from a
 * Worker's `fetch` and `scheduled` handlers.
 *
 * Routing, CORS and the 500 for a handler that throws are the shared Fetch
 * host's (`createFetchHost` in @agentforeach/platform), as on Lambda. Every
 * invocation runs in its own scope. Its background work is kept alive with
 * `ctx.waitUntil` (at most 30 s after the response), and the scope is
 * settled there, so per-invocation resources (the database pool, MCP
 * connections) are closed after it.
 */

import {
  consoleContext,
  createFetchHost,
  openScope,
  type CorsPolicy,
  type RouteDef,
  type ScheduleDef,
} from "@agentforeach/platform";
import { toCloudflareCron } from "./cron.js";

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

export function createWorkerHandler<Env>(options: WorkerHostOptions<Env>) {
  let table: WorkerTable | undefined;
  const tableNow = () => (table ??= options.table());
  const http = createFetchHost({ routes: () => tableNow().routes, cors: options.cors });

  return {
    async fetch(request: Request, env: Env, ctx: WaitUntil): Promise<Response> {
      options.prepare?.(env);
      const intercepted = await options.intercept?.(request, env, ctx);
      if (intercepted) return intercepted;
      return http.dispatch(request, {
        invocationId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
        keepAlive: (work) => ctx.waitUntil(work),
        settle: (opened) => ctx.waitUntil(opened.settle()),
      });
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
            await opened.run(() => schedule.handler(consoleContext(invocationId)));
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
