import test from "node:test";
import assert from "node:assert/strict";
import { background, corsPolicy, currentScope, scopeKey, type RouteDef, type ScheduleDef } from "@agentforeach/platform";
import { createWorkerHandler } from "./worker.js";
import { cronTriggers, toCloudflareCron } from "./cron.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake ExecutionContext that records what it is asked to keep alive. */
function executionContext() {
  const kept: Promise<unknown>[] = [];
  return { kept, ctx: { waitUntil: (p: Promise<unknown>) => void kept.push(p) }, drain: () => Promise.all(kept) };
}

const routes: RouteDef[] = [
  {
    name: "echo",
    route: "api/items/{id}",
    methods: ["POST"],
    handler: async (req) => ({
      status: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: req.params.id, q: req.query.get("q"), raw: await req.text(), method: req.method }),
    }),
  },
  { name: "rest", route: "files/{*path}", methods: ["GET"], handler: async (req) => ({ body: req.params.path }) },
  {
    name: "own-cors",
    route: "api/chat",
    methods: ["GET", "OPTIONS"],
    handler: async (req) =>
      req.method === "OPTIONS"
        ? { status: 204, headers: { "Access-Control-Allow-Origin": "https://own.example" }, body: "ignored" }
        : { body: "chat" },
  },
  { name: "cron-api", route: "api/cron/jobs", methods: ["GET", "POST"], handler: async () => ({ body: "[]" }) },
  {
    name: "boom",
    route: "api/boom",
    methods: ["GET"],
    handler: async () => {
      throw new Error("handler failed");
    },
  },
];

const worker = (more: Partial<Parameters<typeof createWorkerHandler>[0]> = {}) =>
  createWorkerHandler({ table: () => ({ routes, schedules: [] }), cors: () => corsPolicy(undefined), ...more });

test("routes match as on Azure: params, query, the raw body, case-insensitive paths", async () => {
  const { ctx } = executionContext();
  const res = await worker().fetch(
    new Request("https://gw.example/API/Items/a%20b?q=1", { method: "post", body: '{"x":1}' }),
    {},
    ctx,
  );
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { id: "a b", q: "1", raw: '{"x":1}', method: "POST" });
  assert.equal(await (await worker().fetch(new Request("https://gw.example/files/a/b.txt"), {}, ctx)).text(), "a/b.txt");
});

test("no route, or a method no route accepts, is a 404", async () => {
  const { ctx } = executionContext();
  assert.equal((await worker().fetch(new Request("https://gw.example/nope"), {}, ctx)).status, 404);
  assert.equal((await worker().fetch(new Request("https://gw.example/api/items/1"), {}, ctx)).status, 404, "GET on a POST route");
});

test("every request runs in its own scope; background work and cleanup are kept alive with waitUntil", async () => {
  const POOL = scopeKey<object>("pool");
  let finished = false;
  let cleaned = false;
  const { ctx, kept, drain } = executionContext();
  const host = worker({
    table: () => ({
      routes: [
        {
          name: "slow",
          route: "slow",
          methods: ["GET"],
          handler: async () => {
            const scope = currentScope()!;
            assert.equal(scope.kind, "http");
            assert.equal(scope.invocationId, "ray-1", "the cf-ray header names the invocation");
            scope.resource(POOL, () => (scope.onEnd(() => void (cleaned = true)), {}));
            background(tick(30).then(() => (finished = true)));
            return { body: "ok" };
          },
        },
      ],
      schedules: [],
    }),
  });
  const res = await host.fetch(new Request("https://gw.example/slow", { headers: { "cf-ray": "ray-1" } }), {}, ctx);
  assert.equal(await res.text(), "ok");
  assert.equal(finished, false, "the response did not wait for background work");
  assert.ok(kept.length >= 2, "the background work and the scope's settling were handed to waitUntil");
  await drain();
  assert.equal(finished, true);
  assert.equal(cleaned, true, "the invocation's resources were closed after its background work");
});

test("a handler that throws is a 500 with no body, as on Azure", async () => {
  const { ctx } = executionContext();
  const original = console.error;
  console.error = () => {};
  try {
    const res = await worker().fetch(new Request("https://gw.example/api/boom"), {}, ctx);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), "");
  } finally {
    console.error = original;
  }
});

test("a preflight for routes without OPTIONS is answered with the gateway's CORS policy", async () => {
  const { ctx } = executionContext();
  const preflight = (host: ReturnType<typeof worker>) =>
    host.fetch(
      new Request("https://gw.example/api/cron/jobs", {
        method: "OPTIONS",
        headers: { origin: "https://app.example", "access-control-request-headers": "authorization, content-type" },
      }),
      {},
      ctx,
    );
  let res = await preflight(worker());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
  assert.equal(res.headers.get("access-control-allow-headers"), "authorization, content-type");

  res = await preflight(worker({ cors: () => corsPolicy("https://app.example") }));
  assert.equal(res.headers.get("access-control-allow-origin"), "https://app.example");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");

  const unknown = await worker().fetch(new Request("https://gw.example/nope", { method: "OPTIONS" }), {}, ctx);
  assert.equal(unknown.status, 404, "no route serves the path at all");
});

test("a route that handles OPTIONS answers its own preflight; a 204 carries no body", async () => {
  const { ctx } = executionContext();
  const res = await worker().fetch(
    new Request("https://gw.example/api/chat", { method: "OPTIONS", headers: { origin: "https://app.example" } }),
    {},
    ctx,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://own.example", "the handler's own headers");
  assert.equal(await res.text(), "");
});

test("a browser response with no CORS headers gets the policy's origin; one with them is left alone", async () => {
  const { ctx } = executionContext();
  const host = worker({ cors: () => corsPolicy("https://app.example") });
  const fromBrowser = await host.fetch(new Request("https://gw.example/api/cron/jobs", { headers: { origin: "https://app.example" } }), {}, ctx);
  assert.equal(fromBrowser.headers.get("access-control-allow-origin"), "https://app.example");
  assert.equal(fromBrowser.headers.get("access-control-allow-credentials"), "true");
  assert.equal(await fromBrowser.text(), "[]");

  const notBrowser = await host.fetch(new Request("https://gw.example/api/cron/jobs"), {}, ctx);
  assert.equal(notBrowser.headers.get("access-control-allow-origin"), null);
});

test("intercept serves a request outside the route table first; undefined goes on to the routes", async () => {
  const { ctx } = executionContext();
  const host = worker({
    intercept: async (request) =>
      new URL(request.url).pathname === "/realtime/client" ? new Response("upgraded") : undefined,
  });
  const upgraded = await host.fetch(new Request("https://gw.example/realtime/client", { headers: { origin: "https://app.example" } }), {}, ctx);
  assert.equal(await upgraded.text(), "upgraded");
  assert.equal(upgraded.headers.get("access-control-allow-origin"), null, "no CORS added to an intercepted response");
  assert.equal(await (await host.fetch(new Request("https://gw.example/files/x"), {}, ctx)).text(), "x");
});

test("scheduled runs every schedule on the trigger's cron, each in its own scope", async () => {
  const ran: string[] = [];
  const schedules: ScheduleDef[] = [
    { name: "health", schedule: "0 */5 * * * *", handler: async () => void ran.push(`health:${currentScope()!.kind}`) },
    { name: "sweep", schedule: "0 */5 * * * *", handler: async () => void ran.push("sweep") },
    { name: "purge", schedule: "0 */15 * * * *", handler: async () => void ran.push("purge") },
  ];
  const prepared: unknown[] = [];
  const host = createWorkerHandler<{ tag: string }>({ table: () => ({ routes: [], schedules }), prepare: (env) => prepared.push(env.tag) });
  const { ctx, drain } = executionContext();
  await host.scheduled({ cron: "*/5 * * * *", scheduledTime: 1 }, { tag: "env-1" }, ctx);
  await drain();
  assert.deepEqual(ran.sort(), ["health:schedule", "sweep"]);
  assert.deepEqual(prepared, ["env-1"], "prepare saw the bindings first");
});

test("schedules convert to Cloudflare cron only when the meaning carries over exactly", () => {
  assert.equal(toCloudflareCron("0 */15 * * * *"), "*/15 * * * *");
  assert.equal(toCloudflareCron("0 30 9 * * MON-FRI"), "30 9 * * MON-FRI");
  assert.throws(() => toCloudflareCron("30 * * * * *"), /second 30; Cloudflare cron triggers fire on whole minutes/);
  assert.throws(() => toCloudflareCron("0 0 9 * * 1-5"), /use day names/);
  assert.throws(() => toCloudflareCron("*/5 * * * *"), /six fields/);
  assert.deepEqual(cronTriggers([{ schedule: "0 */5 * * * *" }, { schedule: "0 */15 * * * *" }, { schedule: "0 */5 * * * *" }]), [
    "*/5 * * * *",
    "*/15 * * * *",
  ]);
});
