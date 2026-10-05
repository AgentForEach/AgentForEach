import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage } from "@agentforeach/storage";
import type { Durable, DurableContext, HttpRequestLike } from "@agentforeach/platform";
import {
  backgroundTurnsEnabled,
  chatTurnIds,
  chatTurnJob,
  executeChatTurn,
  MAX_QUEUE_WAIT_MS,
  setChatTurnDepsForTests,
  waitUnavailable,
  type ChatTurnRequest,
} from "./chat-turn.js";
import { routes as apiRoutes } from "./api.js";
import { AbortStore } from "../client/abort-store.js";
import type { AgentClient } from "../client/index.js";
import { ChatRunStore, chatRunFingerprint } from "../sessions/chat-runs.js";
import { setDurableForTests } from "../runtime/durable.js";
import { installHost, resetHostForTests } from "../runtime/host.js";
import { isValidSessionId } from "../sessions/ids.js";
import { createHash } from "node:crypto";
import { setAgentClientForTests } from "../shared.js";
import { hitlState, storeWith } from "../hitl/testing.js";

test("a retried request maps onto the same run, orchestration and session", () => {
  const a = chatTurnIds("u1", "key-123");
  const b = chatTurnIds("u1", "key-123");
  assert.deepEqual(a, b);
  assert.match(a.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isValidSessionId(a.newSessionId), true);
  assert.notDeepEqual(chatTurnIds("u2", "key-123"), a, "keys are per user");
  const x = chatTurnIds("u1");
  const y = chatTurnIds("u1");
  assert.notEqual(x.runId, y.runId, "no key: a fresh run each time");
  assert.notEqual(x.newSessionId, y.newSessionId);
  assert.equal(isValidSessionId(x.newSessionId), true);
});

test("a user id with a newline can't share a run with another user's key", () => {
  // "a\nb" + "c" and "a" + "b\nc" would hash the same text if joined with "\n".
  assert.notDeepEqual(chatTurnIds("a\nb", "c"), chatTurnIds("a", "b\nc"));
  // Ordinary ids keep the exact ids they had before (in-flight retries still match).
  const h = createHash("sha256").update("u1\nkey-123").digest("hex");
  assert.equal(chatTurnIds("u1", "key-123").instanceId, `chat-${h.slice(0, 32)}`);
});

test("background turns: on in the cloud with a real-time provider, overridable", () => {
  const keys = ["CHAT_ASYNC_TURNS", "WEBSITE_SITE_NAME", "WEBSOCKET_PROVIDER"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(backgroundTurnsEnabled(), false, "local dev runs turns in the request");

    process.env.WEBSITE_SITE_NAME = "agentforeach-func";
    process.env.WEBSOCKET_PROVIDER = "azure-webpubsub";
    assert.equal(backgroundTurnsEnabled(), true);

    process.env.WEBSOCKET_PROVIDER = "noop";
    assert.equal(backgroundTurnsEnabled(), false, "no socket to deliver the reply");

    process.env.CHAT_ASYNC_TURNS = "true";
    assert.equal(backgroundTurnsEnabled(), true);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("a host with maxRequestMs always runs turns in the background and refuses wait, warning once if config says otherwise", (t) => {
  const saved = process.env.CHAT_ASYNC_TURNS;
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => void warnings.push(message));
  try {
    assert.equal(waitUnavailable(), undefined, "no limit: wait is served");
    installHost({ platform: "aws", isProductionHost: true, publicBaseUrl: undefined, label: "aws:test", maxRequestMs: 30_000 });
    process.env.CHAT_ASYNC_TURNS = "true";
    assert.equal(backgroundTurnsEnabled(), true);
    assert.equal(warnings.length, 0);

    process.env.CHAT_ASYNC_TURNS = "false";
    assert.equal(backgroundTurnsEnabled(), true, "the setting can't turn it off");
    assert.equal(backgroundTurnsEnabled(), true);
    assert.equal(warnings.length, 1, "one warning");
    assert.match(warnings[0], /CHAT_ASYNC_TURNS=false is ignored on aws/);
    assert.match(waitUnavailable() ?? "", /"wait": true isn't available on this host: requests end after 30 s/);
  } finally {
    resetHostForTests();
    if (saved === undefined) delete process.env.CHAT_ASYNC_TURNS;
    else process.env.CHAT_ASYNC_TURNS = saved;
  }
});

// ============================================================================
// Run status and turn guards
// ============================================================================

afterEach(() => {
  setChatTurnDepsForTests();
  setDurableForTests(undefined);
});

const quiet = { invocationId: "i", log() {}, warn() {}, error() {}, trace() {} };

/** A store, pushed events, and a client whose send() is counted. */
async function harness(send?: (request: unknown) => Promise<unknown>) {
  const runs = new ChatRunStore(new InMemoryStorage());
  const abortStore = new AbortStore(new InMemoryStorage());
  await abortStore.initialize();
  const pushed: Array<Record<string, unknown>> = [];
  const sent: unknown[] = [];
  const client = {
    _abortStore: abortStore,
    async send(request: unknown) {
      sent.push(request);
      return (send ?? (async () => ({ status: "completed", sessionId: "s-1", text: "hi" })))(request);
    },
  } as unknown as AgentClient;
  setChatTurnDepsForTests({ runs: () => runs, client: async () => client, push: async (_u, data) => void pushed.push(data) });
  return { runs, abortStore, pushed, sent };
}

function turn(overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  return { runId: "r-1", userId: "u1", message: "hi", sessionId: "s-1", ...overrides } as ChatTurnRequest;
}

const jobContext = (attempt = 1): DurableContext => ({ ...quiet, instanceId: "chat-1", attempt });

test("a background turn: accepted, running, completed", async () => {
  const { runs, sent } = await harness();
  const request = turn({ acceptedAtMs: Date.now() });
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: chatRunFingerprint(request), instanceId: "chat-1" });
  await chatTurnJob.run(request, jobContext());
  assert.equal(sent.length, 1);
  const run = await runs.get("u1", "r-1");
  assert.equal(run?.status, "completed");
  assert.ok(run?.startedAt && run.finishedAt);
});

test("a turn that failed records its code; a thrown failure records a classified one", async () => {
  const refused = await harness(async () => ({ status: "failed", error: "RATE_LIMITED", text: "Slow down", sessionId: "s-1" }));
  await refused.runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f" });
  await chatTurnJob.run(turn({ acceptedAtMs: Date.now() }), jobContext());
  const run = await refused.runs.get("u1", "r-1");
  assert.deepEqual([run?.status, run?.error, run?.retryable], ["failed", "rate_limited", true]);
  assert.equal(refused.pushed[0]?.code, "rate_limited", "the refusal is pushed to the user");

  const thrown = await harness(async () => {
    throw Object.assign(new Error("upstream"), { status: 503 });
  });
  await thrown.runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f" });
  await assert.rejects(chatTurnJob.run(turn({ acceptedAtMs: Date.now() }), jobContext()));
  const failed = await thrown.runs.get("u1", "r-1");
  assert.deepEqual([failed?.status, failed?.error, failed?.retryable], ["failed", "provider_unavailable", true]);
});

test("a turn that waited in the queue more than 5 minutes is refused, not run", async () => {
  const { runs, pushed, sent } = await harness();
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f", instanceId: "chat-1" });
  await chatTurnJob.run(turn({ acceptedAtMs: Date.now() - MAX_QUEUE_WAIT_MS - 1000 }), jobContext());
  assert.equal(sent.length, 0, "the model is never called");
  assert.equal(pushed.length, 1);
  assert.deepEqual(
    { state: pushed[0].state, code: pushed[0].code, retryable: pushed[0].retryable, runId: pushed[0].runId },
    { state: "error", code: "queued_too_long", retryable: true, runId: "r-1" },
  );
  const run = await runs.get("u1", "r-1");
  assert.deepEqual([run?.status, run?.error, run?.retryable], ["failed", "queued_too_long", true]);

  // Just under the limit, it runs.
  await chatTurnJob.run(turn({ acceptedAtMs: Date.now() - MAX_QUEUE_WAIT_MS + 5000 }), jobContext());
  assert.equal(sent.length, 1);
});

test("a Stop pressed while the turn waited stops it before the model is called", async () => {
  const { runs, abortStore, sent } = await harness();
  const acceptedAtMs = Date.now() - 30_000;
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f", instanceId: "chat-1" });
  await abortStore.requestAbort("u1");
  assert.equal(await executeChatTurn(quiet, turn({ acceptedAtMs }), Date.now() + 60_000), undefined);
  assert.equal(sent.length, 0, "the model is never called");
  assert.equal((await runs.get("u1", "r-1"))?.status, "aborted");
  assert.equal(await abortStore.consumePendingAbort("u1", new Date(0)), false, "the marker was consumed");
});

test("a Stop from before the turn was accepted doesn't stop it", async () => {
  const { runs, abortStore, sent } = await harness();
  await abortStore.requestAbort("u1");
  await new Promise((r) => setTimeout(r, 5));
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f" });
  const response = await executeChatTurn(quiet, turn({ acceptedAtMs: Date.now() }), Date.now() + 60_000);
  assert.equal(response?.status, "completed");
  assert.equal(sent.length, 1);
  assert.equal((await runs.get("u1", "r-1"))?.status, "completed");
});

// -- The HTTP API ---------------------------------------------------------------

function apiRequest(
  method: string,
  url: string,
  userId: string | undefined,
  params: Record<string, string> = {},
  body?: unknown,
): HttpRequestLike {
  const headers = new Headers({ "content-type": "application/json" });
  if (userId) {
    headers.set("x-ms-client-principal", Buffer.from(JSON.stringify({ userId })).toString("base64"));
    headers.set("x-ms-client-principal-id", userId);
  }
  return {
    method,
    url,
    headers,
    query: new URL(url).searchParams,
    params,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as HttpRequestLike;
}

async function withEasyAuth<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.AUTH_TRUST_EASY_AUTH_HEADERS;
  process.env.AUTH_TRUST_EASY_AUTH_HEADERS = "true";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.AUTH_TRUST_EASY_AUTH_HEADERS;
    else process.env.AUTH_TRUST_EASY_AUTH_HEADERS = saved;
  }
}

const statusRoute = apiRoutes.find((r) => r.name === "apiChatRunStatus")!;
const chatRoute = apiRoutes.find((r) => r.name === "apiChat")!;

test("GET /api/chat/runs/{runId}: the owner sees the run; anyone else gets 404", async () => {
  const { runs } = await harness();
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f", sessionId: "s-1", instanceId: "chat-1" });
  const get = (userId: string | undefined, runId = "r-1") =>
    withEasyAuth(() => statusRoute.handler(apiRequest("GET", `https://gw.example/api/chat/runs/${runId}`, userId, { runId }), quiet));

  assert.equal(statusRoute.route, "api/chat/runs/{runId}");
  const own = await get("u1");
  assert.equal(own.status, 200);
  const body = JSON.parse(String(own.body));
  assert.deepEqual([body.runId, body.status, body.sessionId], ["r-1", "accepted", "s-1"]);
  assert.equal("fingerprint" in body || "instanceId" in body || "userId" in body, false);

  assert.equal((await get("u2")).status, 404, "another user's run");
  assert.equal((await get("u1", "nope")).status, 404);
  assert.equal((await get("u1", "../x")).status, 400);
  assert.equal((await get(undefined)).status, 401);
  const preflight = await statusRoute.handler(apiRequest("OPTIONS", "https://gw.example/api/chat/runs/r-1", undefined, { runId: "r-1" }), quiet);
  assert.equal(preflight.status, 204);
});

test("GET /api/chat/runs/{runId}: a run stuck in progress is reported from its durable job", async () => {
  const { runs } = await harness();
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f", instanceId: "chat-1", acceptedAtMs: Date.now() - 10 * 60_000 });
  const asked: string[] = [];
  let status: string | null = "running";
  setDurableForTests({
    status: async (id: string) => (asked.push(id), status ? { status } : null),
  } as unknown as Durable);
  const get = async () =>
    JSON.parse(
      String(
        (await withEasyAuth(() => statusRoute.handler(apiRequest("GET", "https://gw.example/api/chat/runs/r-1", "u1", { runId: "r-1" }), quiet)))
          .body,
      ),
    );

  assert.equal((await get()).status, "accepted", "still running");
  assert.deepEqual(asked, ["chat-1"]);
  status = "failed";
  assert.deepEqual([(await get()).status, (await get()).error], ["failed", "execution_failed"]);
  status = null;
  assert.equal((await get()).status, "interrupted", "the job is gone");
  // Reported, not written: the record is unchanged.
  assert.equal((await runs.get("u1", "r-1"))?.status, "accepted");
});

test("POST /api/chat: an idempotency key reused for another message is refused (409)", async () => {
  const { runs, sent } = await harness();
  const { runId } = chatTurnIds("u1", "key-1");
  await runs.prepare({ runId, userId: "u1", fingerprint: chatRunFingerprint({ message: "first message" }) });
  const post = (message: string) =>
    withEasyAuth(() => chatRoute.handler(apiRequest("POST", "https://gw.example/api/chat", "u1", {}, { message, idempotencyKey: "key-1", wait: true }), quiet));

  const conflict = await post("a different message");
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(String(conflict.body)).code, "idempotency_conflict");
  assert.equal(sent.length, 0);

  // The same message again is the same turn: it runs (and replays).
  const same = await post("first message");
  assert.equal(same.status, 200);
  assert.equal(sent.length, 1);
  assert.equal((await runs.get("u1", runId))?.status, "completed");
});


test("POST /api/chat refuses an unknown, closed or another user's input request before starting a turn", async (t) => {
  const { sent } = await harness();
  const { store } = await storeWith(hitlState("theirs"), hitlState("closed", { status: "responded" }));
  setAgentClientForTests({ _hitlStore: store } as unknown as AgentClient);
  t.after(() => setAgentClientForTests(null));
  for (const [userId, requestId] of [["u2", "theirs"], ["u1", "missing"], ["u1", "closed"]]) {
    const result = await withEasyAuth(() => chatRoute.handler(apiRequest("POST", "https://gw.example/api/chat", userId, {}, {
      message: "Answer this form", hitlInputResponse: { requestId, data: {} }, wait: true,
    }), quiet));
    assert.equal(result.status, 404, requestId);
  }
  setAgentClientForTests({} as AgentClient);
  const unavailable = await withEasyAuth(() => chatRoute.handler(apiRequest("POST", "https://gw.example/api/chat", "u1", {}, {
    message: "Answer this form", hitlInputResponse: { requestId: "missing" }, wait: true,
  }), quiet));
  assert.equal(unavailable.status, 503, "an unavailable store cannot accept an answer");
  assert.equal(sent.length, 0, "a refused answer starts no model turn");
});
