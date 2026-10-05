import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { matchRoute, type HandlerContext, type HttpRequestLike } from "@agentforeach/platform";
import { buildRouteTable } from "../routes.js";
import { setAgentClientForTests } from "../shared.js";
import { resetProviderChain } from "../auth/index.js";
import { inputRequestStatus, pendingInputRequests } from "./recovery.js";
import { hitlState, storeWith } from "./testing.js";
import type { InputRequestPayload } from "./types.js";

afterEach(() => setAgentClientForTests(null));

const form = (requestId: string): InputRequestPayload => ({
  requestId,
  runId: `run-${requestId}`,
  sessionId: "s1",
  toolName: "fixture_send_note",
  toolCallId: "c1",
  intent: "Send a note",
  formType: "confirmation",
  proposedArgs: { to: "Ada" },
  schema: { type: "object" },
  timeoutSeconds: 300,
});

const answered = { data: {}, cancelled: false, answeredAt: "2026-10-05T10:00:00.000Z" };

async function fixtures() {
  const now = Date.now();
  return storeWith(
    hitlState("waiting", { inputRequest: form("waiting"), createdAt: now - 1000 }),
    hitlState("newer", { inputRequest: form("newer"), tool: "request_user_input", createdAt: now }),
    hitlState("answered", { inputRequest: form("answered"), answer: answered }),
    hitlState("done", { inputRequest: form("done"), status: "responded", answer: answered, resumedRunId: "run-next" }),
    hitlState("late", { inputRequest: form("late"), createdAt: now - 301_000 }),
    hitlState("timed-out", { inputRequest: form("timed-out"), status: "timed_out" }),
    hitlState("older", {}), // saved before forms were recorded with requests
    hitlState("theirs", { inputRequest: form("theirs"), userId: "u2" }),
  );
}

test("the pending list is the user's unanswered forms, as the input_request events that showed them", async () => {
  const { source } = await fixtures();
  const requests = await pendingInputRequests("u1", source);
  assert.deepEqual(requests?.map((r) => r.requestId).sort(), ["newer", "waiting"]);
  const waiting = requests!.find((r) => r.requestId === "waiting");
  assert.equal(waiting!.state, "input_request");
  assert.deepEqual({ ...waiting, expiresAt: undefined, state: undefined }, { ...form("waiting"), expiresAt: undefined, state: undefined });
  assert.ok(Math.abs(Date.parse(waiting!.expiresAt) - (Date.now() - 1000 + 300_000)) < 5000);

  assert.deepEqual((await pendingInputRequests("u2", source))?.map((r) => r.requestId), ["theirs"]);
  assert.deepEqual(await pendingInputRequests("u3", source), []);
  assert.equal(await pendingInputRequests("u1", async () => undefined), undefined);
});

test("a request's status is the owner's to see", async () => {
  const { source } = await fixtures();
  assert.deepEqual(await inputRequestStatus("u1", "waiting", source), {
    requestId: "waiting", status: "pending", sessionId: "s1", runId: "run-waiting",
  });
  assert.deepEqual(await inputRequestStatus("u1", "done", source), {
    requestId: "done", status: "responded", sessionId: "s1", runId: "run-done",
    answeredAt: answered.answeredAt, resumedRunId: "run-next",
  });
  assert.equal((await inputRequestStatus("u1", "answered", source))?.status, "pending");
  assert.equal((await inputRequestStatus("u1", "late", source))?.status, "expired");
  assert.equal((await inputRequestStatus("u1", "timed-out", source))?.status, "expired");
  assert.equal(await inputRequestStatus("u1", "theirs", source), null, "another user's");
  assert.equal(await inputRequestStatus("u1", "nope", source), null);
});

// ── Over HTTP ──

test("api/hitl/pending is matched before api/hitl/{id}", () => {
  const routes = buildRouteTable().routes;
  assert.equal(matchRoute(routes, "GET", "/api/hitl/pending")?.route.name, "apiHitlPending");
  const status = matchRoute(routes, "GET", "/api/hitl/r-1");
  assert.equal(status?.route.name, "apiHitlStatus");
  assert.deepEqual(status?.params, { id: "r-1" });
  assert.equal(matchRoute(routes, "OPTIONS", "/api/hitl/pending")?.route.name, "apiHitlPending");
});

const context = { invocationId: "i", log() {}, warn() {}, error() {}, trace() {} } as unknown as HandlerContext;

async function get(path: string, userId: string): Promise<{ status: number; body: any; headers: Record<string, string> }> {
  const match = matchRoute(buildRouteTable().routes, "GET", path)!;
  const url = new URL(path, "https://gateway.test");
  const request: HttpRequestLike = {
    method: "GET",
    url: url.href,
    headers: new Headers({ "x-user-id": userId }),
    query: url.searchParams,
    params: match.params,
    json: async () => ({}),
    text: async () => "",
  };
  const result = await match.route.handler(request, context);
  return { status: result.status ?? 200, body: result.body ? JSON.parse(result.body) : undefined, headers: result.headers ?? {} };
}

test("the routes answer for the signed-in user only", async (t) => {
  const before = process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER;
  process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER = "true";
  resetProviderChain();
  t.after(() => {
    if (before === undefined) delete process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER;
    else process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER = before;
    resetProviderChain();
  });
  const { store } = await fixtures();
  setAgentClientForTests({ _hitlStore: store } as never);

  const pending = await get("/api/hitl/pending", "u1");
  assert.equal(pending.status, 200);
  assert.equal(pending.headers["Cache-Control"], "no-store");
  assert.deepEqual(pending.body.requests.map((r: { requestId: string }) => r.requestId).sort(), ["newer", "waiting"]);

  const done = await get("/api/hitl/done", "u1");
  assert.equal(done.status, 200);
  assert.equal(done.body.resumedRunId, "run-next");

  assert.equal((await get("/api/hitl/theirs", "u1")).status, 404);
  assert.equal((await get("/api/hitl/theirs", "u2")).status, 200);
  assert.deepEqual((await get("/api/hitl/pending", "u2")).body.requests.map((r: { requestId: string }) => r.requestId), ["theirs"]);
});
