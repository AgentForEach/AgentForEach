/**
 * The Azure Functions host: registers the gateway's route and schedule table
 * with the Functions v4 programming model.
 *
 * Every route is `authLevel: "anonymous"` (the gateway authenticates each
 * request itself), and a route or schedule marked `durable` gets a Durable
 * Functions client input so its handler can start or signal orchestrations.
 *
 * Each invocation runs in its own scope (`@agentforeach/platform`'s
 * `openScope`). The Functions process outlives every invocation, so
 * background work keeps running as it always has: the scope is settled
 * (background work, then cleanups) without being awaited, off the response
 * path, and response timing doesn't change.
 */

import { app, type HttpHandler as AzureHttpHandler, type HttpMethod as AzureHttpMethod, type InvocationContext } from "@azure/functions";
import * as df from "durable-functions";
import {
  currentScope,
  openScope,
  scopeKey,
  type InvocationKind,
  type RouteDef,
  type ScheduleDef,
} from "@agentforeach/platform";

/** The subset of `@azure/functions`' `app` this module calls; swappable in tests. */
export interface FunctionsApp {
  http(name: string, options: Parameters<typeof app.http>[1]): void;
  timer(name: string, options: Parameters<typeof app.timer>[1]): void;
}

const INVOCATION_CONTEXT = scopeKey<InvocationContext>("azure.invocationContext");

/**
 * The Functions invocation context of the current invocation, for code that
 * needs Azure's own bindings (`df.getClient(context)` needs the invocation
 * that carries the durable client input). Undefined outside an invocation.
 * Background work started by the invocation sees it too.
 */
export function currentInvocationContext(): InvocationContext | undefined {
  const scope = currentScope();
  return scope ? scope.resource(INVOCATION_CONTEXT, () => undefined as unknown as InvocationContext) : undefined;
}

/**
 * Run one invocation in its scope; settle the scope after, without waiting
 * for it. Used for every Functions invocation this pack registers (HTTP,
 * timers, durable activities).
 */
export async function inScope<T>(context: InvocationContext, kind: InvocationKind, run: () => Promise<T>): Promise<T> {
  const opened = openScope({ invocationId: context.invocationId, kind });
  opened.scope.resource(INVOCATION_CONTEXT, () => context);
  try {
    return await opened.run(run);
  } finally {
    void opened.settle();
  }
}

export function registerFunctions(
  table: { routes: readonly RouteDef[]; schedules: readonly ScheduleDef[] },
  target: FunctionsApp = app,
): void {
  for (const route of table.routes) {
    // HttpRequest and InvocationContext satisfy the platform types, and
    // HttpResult is a subset of HttpResponseInit.
    const handler = route.handler as unknown as AzureHttpHandler;
    target.http(route.name, {
      methods: [...route.methods] as AzureHttpMethod[],
      authLevel: "anonymous",
      route: route.route,
      ...(route.durable ? { extraInputs: [df.input.durableClient()] } : {}),
      handler: (request, context) => inScope(context, "http", () => Promise.resolve(handler(request, context))),
    });
  }
  for (const schedule of table.schedules) {
    target.timer(schedule.name, {
      schedule: schedule.schedule,
      ...(schedule.durable ? { extraInputs: [df.input.durableClient()] } : {}),
      handler: (_timer, context) => inScope(context, "schedule", () => schedule.handler(context)),
    });
  }
}
