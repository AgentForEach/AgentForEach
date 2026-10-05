/**
 * The gateway's route table behind the Lambda HTTP host (as deploy/aws/lambda.ts
 * serves it): API Gateway payload 2.0 events in, results out, on the AWS host.
 * The run status route is what clients poll there, since "wait": true is refused.
 */

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorage } from "@agentforeach/storage";
import { createLambdaHttpHandler, lambdaHostInfo, type HttpApiV2Event } from "@agentforeach/platform-aws";
import { buildRouteTable } from "../routes.js";
import { setChatTurnDepsForTests } from "../handlers/chat-turn.js";
import { ChatRunStore } from "../sessions/chat-runs.js";
import { installHost, resetHostForTests } from "./host.js";

const saved = process.env.AUTH_TRUST_EASY_AUTH_HEADERS;

afterEach(() => {
  setChatTurnDepsForTests();
  resetHostForTests();
  if (saved === undefined) delete process.env.AUTH_TRUST_EASY_AUTH_HEADERS;
  else process.env.AUTH_TRUST_EASY_AUTH_HEADERS = saved;
});

const context = { awsRequestId: "lambda-1", getRemainingTimeInMillis: () => 60_000 };

function event(method: string, rawPath: string, userId: string, body?: unknown): HttpApiV2Event {
  return {
    version: "2.0",
    rawPath,
    rawQueryString: "",
    headers: {
      "content-type": "application/json",
      "x-ms-client-principal": Buffer.from(JSON.stringify({ userId })).toString("base64"),
      "x-ms-client-principal-id": userId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: { requestId: "api-1", domainName: "api.example.test", http: { method } },
  };
}

test("the Lambda host routes GET /api/chat/runs/{runId} to the run status, with no Azure binding", async () => {
  // Header identities are for local runs only.
  process.env.AUTH_TRUST_EASY_AUTH_HEADERS = "true";
  const runs = new ChatRunStore(new InMemoryStorage());
  setChatTurnDepsForTests({ runs: () => runs });
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f", sessionId: "s-1", instanceId: "chat-1" });
  const { routes } = buildRouteTable();
  assert.ok(routes.find((r) => r.name === "apiChatRunStatus")?.durable, "a durable route: only Azure binds anything for it");
  const http = createLambdaHttpHandler({ routes: () => routes });

  const own = await http(event("GET", "/api/chat/runs/r-1", "u1"), context);
  assert.equal(own.statusCode, 200);
  assert.deepEqual(
    (({ runId, status, sessionId }) => ({ runId, status, sessionId }))(JSON.parse(own.body)),
    { runId: "r-1", status: "accepted", sessionId: "s-1" },
  );
  assert.equal((await http(event("GET", "/api/chat/runs/r-1", "u2"), context)).statusCode, 404, "another user's run");
});

test("on the Lambda host, POST /api/chat with \"wait\": true is refused", async () => {
  process.env.AUTH_TRUST_EASY_AUTH_HEADERS = "true";
  const { routes } = buildRouteTable();
  const http = createLambdaHttpHandler({ routes: () => routes });
  // The AWS host, but not counted as production, so this test's header identity is still accepted.
  installHost({ ...lambdaHostInfo({ AWS_LAMBDA_FUNCTION_NAME: "afe-http" }), isProductionHost: false });
  const refused = await http(event("POST", "/api/chat", "u1", { message: "hi", wait: true }), context);
  assert.equal(refused.statusCode, 400);
  assert.match(JSON.parse(refused.body).error, /"wait": true isn't available on this host/);
});
