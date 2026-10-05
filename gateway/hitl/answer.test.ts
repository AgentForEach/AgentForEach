import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { matchRoute, type Durable, type HandlerContext, type HttpRequestLike } from "@agentforeach/platform";
import { resetProviderChain } from "../auth/index.js";
import { handleClientEvent } from "../handlers/client-events.js";
import { buildRouteTable } from "../routes.js";
import { setDurableForTests } from "../runtime/durable.js";
import { InMemoryStorage } from "@agentforeach/storage";
import { setChatTurnDepsForTests } from "../handlers/chat-turn.js";
import { ChatRunStore } from "../sessions/chat-runs.js";
import { setAgentClientForTests } from "../shared.js";
import { answerInputRequest } from "./answer.js";
import { hitlWait } from "./orchestrator.js";
import type { HitlStore } from "./store.js";
import { hitlState, storeWith } from "./testing.js";
import { HITL_INPUT_EVENT, type HitlRunState } from "./types.js";

afterEach(() => {
  setDurableForTests(undefined);
  setAgentClientForTests(null);
  setChatTurnDepsForTests();
});

const context = { invocationId: "i", log() {}, warn() {}, error() {}, trace() {} } as unknown as HandlerContext;

/** Record the signals; `waitStatus` is the wait's status (null: no such wait). */
function recordSignals(delivered: boolean | ((payload: unknown) => Promise<boolean>) = true, waitStatus: string | null = null) {
  const signals: Array<{ id: string; event: string; payload: unknown }> = [];
  setDurableForTests({
    signal: async (id: string, event: string, payload: unknown) => {
      signals.push({ id, event, payload });
      return typeof delivered === "function" ? delivered(payload) : delivered;
    },
    status: async () => (waitStatus ? { status: waitStatus } : null),
  } as unknown as Durable);
  return signals;
}

test("a gated tool's form is answered by signalling its wait, from any client path", async () => {
  const signals = recordSignals();
  const { source } = await storeWith(hitlState("r1"));
  const outcome = await answerInputRequest("u1", { requestId: "r1", data: { confirmed: true } }, context, source);
  assert.equal(outcome, "resumed");
  assert.deepEqual(signals, [
    { id: "hitl-r1", event: HITL_INPUT_EVENT, payload: { requestId: "r1", data: { confirmed: true }, cancelled: false } },
  ]);
});

test("the answer is saved on the request before the wait is signalled", async () => {
  const { store, source } = await storeWith(hitlState("r1"));
  let savedAtSignal: HitlRunState["answer"];
  recordSignals(async () => {
    savedAtSignal = (await store.get("r1", "u1"))?.answer;
    return true;
  });
  await answerInputRequest("u1", { requestId: "r1", data: { to: "Ada" } }, context, source);
  assert.deepEqual(savedAtSignal && { data: savedAtSignal.data, cancelled: savedAtSignal.cancelled }, { data: { to: "Ada" }, cancelled: false });
  assert.ok(!Number.isNaN(Date.parse(savedAtSignal!.answeredAt)));
  assert.equal((await store.get("r1", "u1"))?.status, "pending", "the resume, not the answer, moves it on");
});

test("the same answer again is accepted, and isn't delivered again once the wait took it", async () => {
  const signals = recordSignals();
  const { store, source } = await storeWith(hitlState("r1"));
  const first = { requestId: "r1", data: { to: "Ada", cc: ["Bob"] } };
  assert.equal(await answerInputRequest("u1", first, context, source), "resumed");
  const answeredAt = (await store.get("r1", "u1"))?.answer?.answeredAt;

  // A retry before the wait took it (keys in another order): delivered again, harmlessly.
  const retry = { requestId: "r1", data: { cc: ["Bob"], to: "Ada" }, cancelled: false };
  assert.equal(await answerInputRequest("u1", retry, context, source), "resumed");
  assert.equal(signals.length, 2);

  // After the resume: the same outcome, and no signal.
  await store.updateStatus("r1", "u1", "responded");
  assert.equal(await answerInputRequest("u1", first, context, source), "resumed");
  assert.equal(signals.length, 2);
  assert.equal((await store.get("r1", "u1"))?.answer?.answeredAt, answeredAt, "the first answer stands");
});

test("a retry finds the wait just finished with the first delivery", async () => {
  const { store, source } = await storeWith(hitlState("r1"));
  recordSignals();
  await answerInputRequest("u1", { requestId: "r1", data: { a: 1 } }, context, source);
  recordSignals(async () => {
    await store.updateStatus("r1", "u1", "responded");
    return false;
  });
  assert.equal(await answerInputRequest("u1", { requestId: "r1", data: { a: 1 } }, context, source), "resumed");
});

test("a different answer to an answered request is a conflict, and never delivered", async () => {
  const signals = recordSignals();
  const { store, source } = await storeWith(hitlState("r1"), hitlState("r2", { tool: "request_user_input" }));
  await answerInputRequest("u1", { requestId: "r1", data: { to: "Ada" } }, context, source);
  assert.equal(await answerInputRequest("u1", { requestId: "r1", data: { to: "Eve" } }, context, source), "conflict");
  assert.equal(await answerInputRequest("u1", { requestId: "r1", data: { to: "Ada" }, cancelled: true }, context, source), "conflict");
  await store.updateStatus("r1", "u1", "responded");
  assert.equal(await answerInputRequest("u1", { requestId: "r1", cancelled: true }, context, source), "conflict");
  assert.equal(signals.length, 1);
  assert.deepEqual((await store.get("r1", "u1"))?.answer?.data, { to: "Ada" });

  // A form the model raised, too.
  assert.equal(await answerInputRequest("u1", { requestId: "r2", data: { city: "Pune" } }, context, source), "direct");
  assert.equal(await answerInputRequest("u1", { requestId: "r2", data: { city: "Pune" } }, context, source), "direct");
  assert.equal(await answerInputRequest("u1", { requestId: "r2", data: { city: "Goa" } }, context, source), "conflict");
});

test("a form the model raised itself is left to the chat turn that carries the answer", async () => {
  const signals = recordSignals();
  const { store, source } = await storeWith(
    hitlState("r2", { tool: "request_user_input" }),
    hitlState("r3", { tool: "browser", args: { action: "handoff" } }),
  );
  assert.equal(await answerInputRequest("u1", { requestId: "r2" }, context, source), "direct");
  assert.equal(await answerInputRequest("u1", { requestId: "r3" }, context, source), "direct");
  assert.deepEqual(signals, []);
  // Saved for GET /api/hitl/{id}; the runner still resolves it.
  assert.equal((await store.get("r2", "u1"))?.status, "pending");
  assert.deepEqual((await store.get("r2", "u1"))?.answer?.data, {});
});

test("only the owner of a pending request may answer it", async () => {
  const signals = recordSignals();
  const { store, source } = await storeWith(hitlState("r4"), hitlState("r5", { status: "responded" }));
  assert.equal(await answerInputRequest("u2", { requestId: "r4" }, context, source), "not_found", "another user's");
  assert.equal(await answerInputRequest("u1", { requestId: "r5" }, context, source), "not_found", "already resolved");
  assert.equal(await answerInputRequest("u1", { requestId: "nope" }, context, source), "not_found");
  assert.deepEqual(signals, []);
  assert.equal((await store.get("r4", "u1"))?.answer, undefined, "another user's answer isn't saved");
});

test("a wait that is gone (timed out, failed, ended) is not found; no store is unavailable", async () => {
  for (const waitStatus of [null, "completed", "failed", "terminated"]) {
    recordSignals(false, waitStatus);
    const { source } = await storeWith(hitlState("r6"));
    assert.equal(await answerInputRequest("u1", { requestId: "r6" }, context, source), "not_found", String(waitStatus));
  }
  const { source } = await storeWith(hitlState("r6"));
  assert.equal(await answerInputRequest("u1", { requestId: "r6" }, context, async () => undefined), "unavailable");
});

test("an answer refused while the wait is still running (firing its timeout) is resumed", async () => {
  const signals = recordSignals(false, "running");
  const { store, source } = await storeWith(hitlState("r7"));
  assert.equal(await answerInputRequest("u1", { requestId: "r7", data: { to: "Ada" } }, context, source), "resumed");
  assert.equal(signals.length, 1);
  assert.deepEqual((await store.get("r7", "u1"))?.answer?.data, { to: "Ada" }, "saved for the timeout to resume with");
});

// ── The wait's resume acts on the saved answer ──

function fakeClient(store: HitlStore) {
  const appended: string[] = [];
  const sends: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  setAgentClientForTests({
    _hitlStore: store,
    _mcpManager: {
      async callTool(name: string, args: Record<string, unknown>) {
        toolCalls.push({ name, args });
        return { content: "sent", isError: false };
      },
    },
    _sessionStore: {
      async appendMessages(_userId: string, _sessionId: string, messages: Array<{ content: string }>) {
        appended.push(...messages.map((m) => m.content));
      },
    },
    async send(request: Record<string, unknown>) {
      sends.push(request);
      // As the client does: the run id given, or one of its own.
      return { status: "completed", runId: (request.runId as string) ?? "continuation-1", text: "ok" };
    },
  } as never);
  return { appended, sends, toolCalls };
}

const waitContext = { ...context, instanceId: "hitl-r1", attempt: 1 } as never;

test("the wait resumes with the saved answer, not the event that delivered it", async () => {
  const saved = { data: {}, cancelled: true, answeredAt: new Date().toISOString() };
  const { store } = await storeWith(hitlState("r1", { answer: saved }));
  const { appended, sends } = fakeClient(store);

  await hitlWait.onEvent!(
    { requestId: "r1", userId: "u1" },
    { requestId: "r1", data: { to: "Eve" }, cancelled: false },
    waitContext,
  );

  assert.deepEqual(appended, ["[fixture_send_note] User cancelled this action."]);
  assert.equal(sends.length, 1);
  const state = await store.get("r1", "u1");
  assert.equal(state?.status, "cancelled");
  assert.equal(state?.resumedRunId, sends[0]!.runId);
});

test("the saved answer's data is what the resumed call gets", async () => {
  const saved = { data: { city: "Pune" }, cancelled: false, answeredAt: new Date().toISOString() };
  const { store } = await storeWith(hitlState("r1", { tool: "request_user_input", answer: saved }));
  const { appended } = fakeClient(store);

  await hitlWait.onEvent!({ requestId: "r1", userId: "u1" }, { requestId: "r1", data: { city: "Goa" }, cancelled: false }, waitContext);

  assert.deepEqual(appended, [`[request_user_input] ${JSON.stringify({ ok: true, userInput: { city: "Pune" } })}`]);
  assert.equal((await store.get("r1", "u1"))?.status, "responded");
});

test("a second delivery of the answer doesn't resume the run again", async () => {
  const { store } = await storeWith(hitlState("r1"));
  const { sends } = fakeClient(store);
  const event = { requestId: "r1", data: {}, cancelled: true };
  await hitlWait.onEvent!({ requestId: "r1", userId: "u1" }, event, waitContext);
  await hitlWait.onEvent!({ requestId: "r1", userId: "u1" }, event, waitContext);
  assert.equal(sends.length, 1);
});

test("a timeout that arrives after the resume changes nothing", async () => {
  const { store } = await storeWith(hitlState("r1"));
  const { appended } = fakeClient(store);
  await hitlWait.onEvent!({ requestId: "r1", userId: "u1" }, { requestId: "r1", data: {}, cancelled: true }, waitContext);
  await hitlWait.onTimeout!({ requestId: "r1", userId: "u1" }, waitContext);
  assert.equal((await store.get("r1", "u1"))?.status, "cancelled");
  assert.equal(appended.length, 1, "no timeout note");
});

test("an answer saved before the deadline wins, even if the timeout fires first", async () => {
  recordSignals(false, "running");
  const { store, source } = await storeWith(hitlState("r1", { args: { body: "hi" } }));
  const { appended, sends, toolCalls } = fakeClient(store);
  // The answer is saved, but the signal is refused: the wait is firing its timeout.
  assert.equal(await answerInputRequest("u1", { requestId: "r1", data: { to: "Ada" } }, context, source), "resumed");

  const deadlineAt = Date.now() + 60_000;
  await hitlWait.onTimeout!({ requestId: "r1", userId: "u1" }, { ...context, instanceId: "hitl-r1", attempt: 1, deadlineAt });
  await hitlWait.onTimeout!({ requestId: "r1", userId: "u1" }, waitContext); // a redelivered timeout

  assert.deepEqual(toolCalls, [{ name: "fixture_send_note", args: { body: "hi", to: "Ada" } }], "the tool runs once");
  assert.deepEqual(appended, ["[fixture_send_note] sent"], "no timeout note");
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.deadlineAt, deadlineAt, "the timeout continuation keeps the invocation budget");
  const state = await store.get("r1", "u1");
  assert.equal(state?.status, "responded");
  assert.equal(state?.resumedRunId, sends[0]!.runId);
});

test("a timeout with no answer still expires the request", async () => {
  const { store } = await storeWith(hitlState("r1"));
  const { appended, sends } = fakeClient(store);
  await hitlWait.onTimeout!({ requestId: "r1", userId: "u1" }, waitContext);
  assert.equal((await store.get("r1", "u1"))?.status, "timed_out");
  assert.equal(appended.length, 1);
  assert.match(appended[0]!, /timed out/);
  assert.equal(sends.length, 0);
});

test("a continuation that fails is recorded as failed", async () => {
  const { store } = await storeWith(hitlState("r1"));
  setAgentClientForTests({
    _hitlStore: store,
    async send() {
      return { status: "failed", runId: "continuation-1", text: "" };
    },
  } as never);
  await hitlWait.onEvent!({ requestId: "r1", userId: "u1" }, { requestId: "r1", data: {}, cancelled: true }, waitContext);
  const state = await store.get("r1", "u1");
  assert.equal(state?.status, "failed");
  assert.equal(state?.resumedRunId, undefined);
});

test("a continuation runs under a status record of its own, which the form's status points to", async () => {
  const runs = new ChatRunStore(new InMemoryStorage());
  setChatTurnDepsForTests({ runs: () => runs });
  const { store } = await storeWith(hitlState("r1"));
  const { sends } = fakeClient(store);
  await hitlWait.onEvent!({ requestId: "r1", userId: "u1" }, { requestId: "r1", data: {}, cancelled: false }, waitContext);

  const runId = sends[0]!.runId as string;
  assert.match(runId, /^[0-9a-f-]{36}$/, "the continuation runs under an id given to it");
  assert.equal((await store.get("r1", "u1"))?.resumedRunId, runId);
  const run = await runs.get("u1", runId);
  assert.equal(run?.status, "completed");
  assert.equal(run?.instanceId, "hitl-r1", "checked against the form's wait");
  assert.equal(await runs.get("u2", runId), null, "the owner's only");
});

test("each attempt at a busy session is a run of its own; the one that ran is the continuation", async () => {
  const runs = new ChatRunStore(new InMemoryStorage());
  setChatTurnDepsForTests({ runs: () => runs });
  const { store } = await storeWith(hitlState("r1"));
  const sends: Array<Record<string, unknown>> = [];
  setAgentClientForTests({
    _hitlStore: store,
    _sessionStore: { async appendMessages() {} },
    async send(request: Record<string, unknown>) {
      sends.push(request);
      return sends.length === 1
        ? { status: "failed", error: "SESSION_BUSY", runId: request.runId, text: "" }
        : { status: "completed", runId: request.runId, text: "ok" };
    },
  } as never);
  await hitlWait.onEvent!({ requestId: "r1", userId: "u1" }, { requestId: "r1", data: {}, cancelled: true }, waitContext);

  assert.equal(sends.length, 2);
  assert.notEqual(sends[0]!.runId, sends[1]!.runId, "a fresh id per attempt");
  assert.equal((await runs.get("u1", sends[0]!.runId as string))?.status, "failed");
  assert.equal((await runs.get("u1", sends[0]!.runId as string))?.error, "session_busy");
  assert.equal((await runs.get("u1", sends[1]!.runId as string))?.status, "completed");
  assert.equal((await store.get("r1", "u1"))?.resumedRunId, sends[1]!.runId);
});

// ── Both client paths refuse a different answer with 409 ──

test("a different answer is a 409 over HTTP and over the socket; the same one is accepted", async (t) => {
  const before = process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER;
  process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER = "true";
  resetProviderChain();
  t.after(() => {
    if (before === undefined) delete process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER;
    else process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER = before;
    resetProviderChain();
  });
  const signals = recordSignals();
  const answer = { data: { to: "Ada" }, cancelled: false, answeredAt: new Date().toISOString() };
  const { store } = await storeWith(hitlState("r1", { answer }));
  setAgentClientForTests({ _hitlStore: store } as never);

  const chat = async (hitlInputResponse: Record<string, unknown>) => {
    const body = { message: "Approved", sessionId: "s1", hitlInputResponse };
    const request: HttpRequestLike = {
      method: "POST",
      url: "https://gateway.test/api/chat",
      headers: new Headers({ "x-user-id": "u1", "content-type": "application/json" }),
      query: new URLSearchParams(),
      params: {},
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
    const result = await matchRoute(buildRouteTable().routes, "POST", "/api/chat")!.route.handler(request, context);
    return { status: result.status, body: JSON.parse(result.body ?? "{}") };
  };
  const socket = async (frame: Record<string, unknown>) =>
    (await handleClientEvent({ userId: "u1", connectionId: "c1", text: async () => JSON.stringify({ type: "input_response", ...frame }) }, context)).status;

  const conflict = await chat({ requestId: "r1", data: { to: "Eve" } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.requestId, "r1");
  assert.equal(await socket({ requestId: "r1", data: { to: "Eve" } }), 409);

  const same = await chat({ requestId: "r1", data: { to: "Ada" } });
  assert.deepEqual([same.status, same.body.resumed], [202, true]);
  assert.equal(await socket({ requestId: "r1", data: { to: "Ada" } }), 200);
  assert.equal(signals.length, 2, "re-delivered while the wait hasn't taken it");
});
