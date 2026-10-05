import test from "node:test";
import assert from "node:assert/strict";
import { background, type RouteDef } from "@agentforeach/platform";
import { createLambdaHttpHandler, type HttpApiV2Event } from "./http.js";
import { lambdaHostInfo } from "./lambda.js";

const context = (remainingMs = 40_000) => ({ awsRequestId: "lambda-1", getRemainingTimeInMillis: () => remainingMs });
const event = (changes: Partial<HttpApiV2Event> = {}, method = "POST"): HttpApiV2Event => ({
  version: "2.0",
  rawPath: "/echo/a%20b",
  rawQueryString: "q=first&q=second",
  headers: {},
  requestContext: { requestId: "gateway-1", domainName: "api.example.test", http: { method } },
  ...changes,
});
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  status: 200,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const route = (handler: RouteDef["handler"], methods: RouteDef["methods"] = ["POST"]): RouteDef[] => [
  { name: "echo", route: "echo/{id}", methods, handler },
];

test("the raw body bytes, cookies, repeated query values and route params reach the handler; the origin is the API's, not a header's", async () => {
  const bytes = Buffer.from(' {"message":"café"} \n');
  const handler = createLambdaHttpHandler({
    routes: () =>
      route(async (request, ctx) =>
        json({
          body: await request.text(),
          cookie: request.headers.get("cookie"),
          id: request.params.id,
          q: request.query.getAll("q"),
          origin: new URL(request.url).origin,
          invocationId: ctx.invocationId,
        }),
      ),
  });
  const result = await handler(
    event({ body: bytes.toString("base64"), isBase64Encoded: true, cookies: ["a=1", "b=2"], headers: { host: "attacker.test" } }),
    context(),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.isBase64Encoded, false, "JSON goes back as text");
  assert.deepEqual(JSON.parse(result.body), {
    body: bytes.toString("utf8"),
    cookie: "a=1; b=2",
    id: "a b",
    q: ["first", "second"],
    origin: "https://api.example.test",
    invocationId: "lambda-1",
  });

  const configured = createLambdaHttpHandler({
    routes: () => route(async (request) => json({ origin: new URL(request.url).origin })),
    origin: "https://gateway.example.com/",
  });
  assert.deepEqual(JSON.parse((await configured(event(), context())).body), { origin: "https://gateway.example.com" });
  assert.throws(() => createLambdaHttpHandler({ routes: () => [], origin: "https://gateway.example.com/base" }), /scheme and host only/);
});

test("a plain-text body arrives as sent", async () => {
  const handler = createLambdaHttpHandler({ routes: () => route(async (request) => ({ body: await request.text() })) });
  const result = await handler(event({ body: "Grüße 👋", isBase64Encoded: false }), context());
  assert.equal(result.body, "Grüße 👋");
});

test("a non-text response goes back base64-encoded, and Set-Cookie moves to cookies", async () => {
  const handler = createLambdaHttpHandler({
    routes: () =>
      route(async () => ({
        status: 201,
        headers: { "Content-Type": "application/octet-stream", "Set-Cookie": "one=1; HttpOnly; Secure" },
        body: "ÿ\u0000",
      })),
  });
  const result = await handler(event(), context());
  assert.equal(result.statusCode, 201);
  assert.equal(result.isBase64Encoded, true);
  assert.deepEqual([...Buffer.from(result.body, "base64")], [...Buffer.from("ÿ\u0000", "utf8")]);
  assert.deepEqual(result.cookies, ["one=1; HttpOnly; Secure"]);
  assert.equal(result.headers["set-cookie"], undefined);
});

test("a HEAD response keeps its headers but sends no body", async () => {
  const handler = createLambdaHttpHandler({
    routes: () => route(async () => ({ headers: { "X-Test": "present", "Content-Type": "text/plain" }, body: "hidden" }), ["HEAD"]),
  });
  const result = await handler(event({}, "HEAD"), context());
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["x-test"], "present");
  assert.equal(result.body, "");
});

test("a base path is stripped, and a path that only shares its prefix is not served", async () => {
  const handler = createLambdaHttpHandler({ routes: () => route(async () => ({ body: "ok" })), basePath: "/prod/" });
  assert.equal((await handler(event({ rawPath: "/prod/echo/1" }), context())).statusCode, 200);
  assert.equal((await handler(event({ rawPath: "/production/echo/1" }), context())).statusCode, 404);
  assert.equal((await handler(event({ rawPath: "/echo/1" }), context())).statusCode, 404);
  assert.throws(() => createLambdaHttpHandler({ routes: () => [], basePath: "prod" }), /basePath/);
});

test("payload 1.0 events, paths that could change the origin, a missing domain and bodies on GET are refused", async () => {
  const handler = createLambdaHttpHandler({ routes: () => route(async () => ({ body: "ok" }), ["GET", "POST"]) });
  const v1 = await handler({ ...event(), version: "1.0" } as unknown as HttpApiV2Event, context());
  assert.equal(v1.statusCode, 400);
  assert.match(JSON.parse(v1.body).error, /payload format 2.0/);
  assert.equal((await handler(undefined as unknown as HttpApiV2Event, context())).statusCode, 400);
  for (const rawPath of ["//attacker.test/path", "echo/1", "/echo/1?x", "/echo\\1"]) {
    assert.equal((await handler(event({ rawPath }), context())).statusCode, 400, rawPath);
  }
  const noDomain = event({ requestContext: { requestId: "1", domainName: "", http: { method: "GET" } } });
  assert.equal((await handler(noDomain, context())).statusCode, 400);
  const userinfo = event({ requestContext: { requestId: "1", domainName: "evil.test@api.example.test", http: { method: "GET" } } });
  assert.equal((await handler(userinfo, context())).statusCode, 400);
  assert.equal((await handler(event({ rawPath: "/echo/1", body: "x" }, "GET"), context())).statusCode, 400);
  assert.equal((await handler(event({ rawPath: "/echo/1" }, "GET"), context())).statusCode, 200);
});

test("the request's deadline: 25 s by default, never later than the function allows, and the budget is capped under API Gateway's", async () => {
  const handler = createLambdaHttpHandler({ routes: () => route(async (_request, ctx) => json({ left: ctx.deadlineAt! - Date.now() })) });
  const roomy = JSON.parse((await handler(event(), context(40_000))).body).left;
  assert.ok(roomy > 24_000 && roomy <= 25_000, `left ${roomy}`);
  const tight = JSON.parse((await handler(event(), context(5_000))).body).left;
  assert.ok(tight > 3_000 && tight <= 4_000, `left ${tight}: a second is kept back to return`);
  assert.throws(() => createLambdaHttpHandler({ routes: () => [], requestTimeoutMs: 215_000 }), /requestTimeoutMs/);
  assert.throws(() => createLambdaHttpHandler({ routes: () => [], requestTimeoutMs: 0 }), /requestTimeoutMs/);
});

test("background work finishes before the result is returned", async () => {
  const done: string[] = [];
  const handler = createLambdaHttpHandler({
    routes: () =>
      route(async () => {
        background(new Promise((resolve) => setTimeout(resolve, 50)).then(() => done.push("background")));
        return { status: 202 };
      }),
  });
  const result = await handler(event(), context());
  assert.equal(result.statusCode, 202);
  assert.deepEqual(done, ["background"], "Lambda would freeze it otherwise");
});

test("background work still running at the deadline is cut off and logged, and the result still goes back", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => void warnings.push(message));
  const handler = createLambdaHttpHandler({
    routes: () =>
      route(async () => {
        background(new Promise(() => {}));
        return { status: 202 };
      }),
  });
  const started = Date.now();
  const result = await handler(event(), context(1_100)); // 100 ms before the deadline
  assert.equal(result.statusCode, 202);
  assert.ok(Date.now() - started < 1_000, "returned at the deadline");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /echo: cut off at the deadline with 1 background task\(s\) still running/);
});

test("a handler that throws becomes a 500 with no detail; an unknown path a 404", async (t) => {
  t.mock.method(console, "error", () => {});
  const handler = createLambdaHttpHandler({
    routes: () =>
      route(async () => {
        throw new Error("private connection details");
      }),
  });
  const failed = await handler(event(), context());
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body, "");
  assert.equal((await handler(event({ rawPath: "/nowhere" }), context())).statusCode, 404);
});

test("the Lambda host: persistent, nothing runs after the response, requests end at API Gateway's 30 s", () => {
  const info = lambdaHostInfo({ AWS_LAMBDA_FUNCTION_NAME: "afe-http", PUBLIC_BASE_URL: "https://api.example.com" });
  assert.deepEqual(
    { ...info, publicBaseUrl: info.publicBaseUrl, label: info.label },
    {
      platform: "aws",
      isProductionHost: true,
      publicBaseUrl: "https://api.example.com",
      label: "aws:afe-http",
      persistent: true,
      backgroundAfterResponse: false,
      maxRequestMs: 30_000,
    },
  );
});
