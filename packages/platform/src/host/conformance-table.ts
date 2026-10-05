/**
 * The route table the host conformance suite runs against (conformance.ts).
 * Its own module, free of node:test, so a test Worker can serve it.
 */

import type { HttpResult, RouteDef, ScheduleDef } from "../host.js";
import { background, currentScope } from "../scope.js";

/** What background work the table's routes have started and finished, by key. */
const backgroundWork = new Map<string, "started" | "done">();

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

/** The routes every host serves for the suite, under /conformance. */
export function hostConformanceTable(): { routes: RouteDef[]; schedules: ScheduleDef[] } {
  return {
    routes: [
      {
        name: "conformanceEcho",
        route: "conformance/echo/{id}/{*rest}",
        methods: ["POST", "PUT", "GET"],
        handler: async (request) =>
          json(200, {
            method: request.method,
            id: request.params.id,
            rest: request.params.rest,
            q: request.query.getAll("q"),
            missing: request.query.get("missing"),
            header: request.headers.get("x-conformance"),
            text: request.method === "GET" ? null : await request.text(),
          }),
      },
      {
        name: "conformanceJson",
        route: "conformance/json",
        methods: ["POST"],
        handler: async (request) => json(200, { received: await request.json() }),
      },
      {
        name: "conformanceStatus",
        route: "conformance/status/{code}",
        methods: ["GET"],
        handler: async (request): Promise<HttpResult> => {
          const status = Number(request.params.code);
          if (status === 204) return { status, headers: { "X-Conformance": "empty" } };
          if (status === 302) return { status, headers: { Location: "https://example.com/next" } };
          return { status, headers: { "X-Conformance": "custom", "Content-Type": "text/plain" }, body: `status ${status}` };
        },
      },
      {
        name: "conformanceThrows",
        route: "conformance/throws",
        methods: ["GET"],
        handler: async () => {
          throw new Error("the handler failed");
        },
      },
      {
        name: "conformanceOwnCors",
        route: "conformance/own-cors",
        methods: ["GET", "OPTIONS"],
        handler: async (request) =>
          request.method === "OPTIONS"
            ? { status: 204, headers: { "Access-Control-Allow-Origin": "https://own.example", "Access-Control-Allow-Methods": "GET,OPTIONS" } }
            : { status: 200, body: "own" },
      },
      {
        name: "conformanceNoOptions",
        route: "conformance/no-options",
        methods: ["GET", "POST"],
        handler: async () => ({ status: 200, body: "ok" }),
      },
      {
        name: "conformanceScope",
        route: "conformance/scope",
        methods: ["GET"],
        handler: async (_request, context) => {
          const scope = currentScope();
          return json(200, { inScope: !!scope, kind: scope?.kind, sameId: scope?.invocationId === context.invocationId });
        },
      },
      {
        name: "conformanceDeadline",
        route: "conformance/deadline",
        methods: ["GET"],
        handler: async (_request, context) => json(200, { deadlineAt: context.deadlineAt ?? null }),
      },
      {
        name: "conformanceBackground",
        route: "conformance/background/{key}",
        methods: ["POST", "GET"],
        handler: async (request) => {
          const key = request.params.key;
          if (request.method === "POST") {
            backgroundWork.set(key, "started");
            background(new Promise((resolve) => setTimeout(resolve, 300)).then(() => backgroundWork.set(key, "done")));
            return json(202, { state: backgroundWork.get(key) });
          }
          return json(200, { state: backgroundWork.get(key) ?? "unknown" });
        },
      },
    ],
    schedules: [],
  };
}
