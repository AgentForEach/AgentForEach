import test from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { background, currentScope, scopeKey, type RouteDef, type ScheduleDef } from "@agentforeach/platform";
import { currentInvocationContext, registerFunctions, type FunctionsApp } from "./host.js";

type Registered = { name: string; options: Record<string, unknown> };

function capture(routes: RouteDef[], schedules: ScheduleDef[] = []) {
  const http: Registered[] = [];
  const timers: Registered[] = [];
  const target: FunctionsApp = {
    http: (name, options) => http.push({ name, options: options as unknown as Record<string, unknown> }),
    timer: (name, options) => timers.push({ name, options: options as unknown as Record<string, unknown> }),
  };
  registerFunctions({ routes, schedules }, target);
  return { http, timers };
}

const context = (invocationId: string) => ({ invocationId }) as unknown as InvocationContext;
const request = {} as HttpRequest;
const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an Azure handler returns before its background work finishes, which then still runs", async () => {
  let finished = false;
  const { http } = capture([
    {
      name: "slow",
      route: "slow",
      methods: ["POST"],
      handler: async () => {
        background(tick(50).then(() => (finished = true)));
        return { status: 202 };
      },
    },
  ]);
  const handler = http[0].options.handler as (r: HttpRequest, c: InvocationContext) => Promise<{ status: number }>;
  const started = Date.now();
  const response = await handler(request, context("inv-1"));
  assert.equal(response.status, 202);
  assert.equal(finished, false, "the response did not wait for background work");
  assert.ok(Date.now() - started < 40, "and was not delayed by it");
  await tick(80);
  assert.equal(finished, true, "the background work still ran to completion");
});

test("each route and schedule invocation runs in its own scope, with Azure's invocation id", async () => {
  const seen: string[] = [];
  const POOL = scopeKey<object>("pool");
  const cleaned: string[] = [];
  const { http, timers } = capture(
    [
      {
        name: "route",
        route: "r",
        methods: ["GET"],
        handler: async () => {
          const scope = currentScope()!;
          seen.push(`${scope.kind}:${scope.invocationId}`);
          scope.resource(POOL, () => (scope.onEnd(() => void cleaned.push(scope.invocationId)), {}));
          return {};
        },
      },
    ],
    [
      {
        name: "tick",
        schedule: "0 */5 * * * *",
        handler: async () => {
          seen.push(`${currentScope()!.kind}:${currentScope()!.invocationId}`);
        },
      },
    ],
  );
  const route = http[0].options.handler as (r: HttpRequest, c: InvocationContext) => Promise<unknown>;
  const timer = timers[0].options.handler as (t: unknown, c: InvocationContext) => Promise<void>;
  await Promise.all([route(request, context("a")), route(request, context("b")), timer({}, context("t"))]);
  assert.deepEqual(seen.sort(), ["http:a", "http:b", "schedule:t"]);
  await tick(5);
  assert.deepEqual(cleaned.sort(), ["a", "b"], "each scope's cleanups ran after its invocation");
  assert.equal(currentScope(), undefined);
});

test("a handler that throws still gets its scope settled, and the error reaches Azure unchanged", async () => {
  let cleaned = false;
  const { http } = capture([
    {
      name: "fails",
      route: "f",
      methods: ["GET"],
      handler: async () => {
        currentScope()!.onEnd(() => {
          cleaned = true;
        });
        throw new Error("handler failed");
      },
    },
  ]);
  const handler = http[0].options.handler as (r: HttpRequest, c: InvocationContext) => Promise<unknown>;
  await assert.rejects(handler(request, context("x")), /handler failed/);
  await tick(5);
  assert.equal(cleaned, true);
});

test("the invocation's Azure context is reachable below the handler and from its background work", async () => {
  let inHandler: unknown;
  let inBackground: unknown;
  const { http } = capture([
    {
      name: "durable",
      route: "d",
      methods: ["POST"],
      durable: true,
      handler: async () => {
        inHandler = currentInvocationContext()?.invocationId;
        background(tick(10).then(() => (inBackground = currentInvocationContext()?.invocationId)));
        return {};
      },
    },
  ]);
  const handler = http[0].options.handler as (r: HttpRequest, c: InvocationContext) => Promise<unknown>;
  await handler(request, context("inv-ctx"));
  await tick(30);
  assert.equal(inHandler, "inv-ctx");
  assert.equal(inBackground, "inv-ctx", "after the response, background work still has it");
  assert.equal(currentInvocationContext(), undefined, "outside an invocation there is none");
});

test("registration keeps the route, methods, anonymous auth and the durable client input", () => {
  const { http } = capture([
    { name: "plain", route: "api/x", methods: ["GET", "OPTIONS"], handler: async () => ({}) },
    { name: "durable", route: "api/y/{id}", methods: ["POST"], durable: true, handler: async () => ({}) },
  ]);
  assert.deepEqual(
    http.map(({ name, options }) => [name, options.route, options.methods, options.authLevel, Array.isArray(options.extraInputs)]),
    [
      ["plain", "api/x", ["GET", "OPTIONS"], "anonymous", false],
      ["durable", "api/y/{id}", ["POST"], "anonymous", true],
    ],
  );
});
