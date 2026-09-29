/**
 * runAgentTurn end to end with a scripted provider and in-memory stores:
 * the tool loop, what reaches the provider each round, and what the session
 * keeps afterwards.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { runAgentTurn, type RunnerDeps } from "./runner.js";
import { makeDeps, scriptedProvider, textResponse, toolCallResponse } from "./runner.test-harness.js";
import type { Provider } from "../llms/types.js";

function send(deps: RunnerDeps, message = "hello", extra: Record<string, unknown> = {}) {
  return runAgentTurn({ userId: "u1", sessionId: "s1", message, ...extra } as never, deps);
}

// ============================================================================
// T1-1: a turn that stops at maxRounds must not leave a broken chain
// ============================================================================

test("stopping at maxRounds clears the provider chain, so the next turn sends local history", async () => {
  const provider = scriptedProvider([() => toolCallResponse([{ name: "memory_search", args: { query: "x" } }])]);
  const { deps, sessionStore } = makeDeps(provider, { maxToolRounds: 2 });

  const first = await send(deps);
  assert.match(first.text, /ran out of tool-execution rounds/);
  assert.equal(sessionStore.persistedStates.at(-1), null, "chain must be cleared");

  // Next turn: no previousResponseId (it would 400), history sent instead.
  const replyProvider = scriptedProvider([() => textResponse("ok")]);
  deps.provider = replyProvider;
  await send(deps, "again");
  const req = replyProvider.requests[0]!;
  assert.equal(req.conversation?.previousResponseId, undefined);
  assert.ok(Array.isArray(req.input) && req.input.length > 1, "local history is included");
});

test("a normal turn keeps the provider chain", async () => {
  const provider = scriptedProvider([() => textResponse("hi there")]);
  const { deps, sessionStore } = makeDeps(provider);
  const res = await send(deps);
  assert.equal(res.text, "hi there");
  assert.match(String(sessionStore.persistedStates.at(-1)?.previousResponseId), /^resp_/);
});

test("a chained turn carries its history for failover, and a reply that doesn't chain clears the chain", async () => {
  const provider = scriptedProvider([
    () => textResponse("first"),
    // As if failover answered with a provider that doesn't chain (Anthropic).
    () => textResponse("second", { providerId: "anthropic", conversationState: undefined }),
  ]);
  const { deps, sessionStore } = makeDeps(provider);

  await send(deps, "my name is Ann");
  assert.match(String(sessionStore.persistedStates.at(-1)?.previousResponseId), /^resp_/);

  await send(deps, "what's my name?");
  const chained = provider.requests[1]!;
  assert.ok(chained.conversation?.previousResponseId, "the second turn is chained");
  const history = JSON.stringify(chained.failoverInput);
  assert.match(history, /my name is Ann/);
  assert.match(history, /what's my name\?/);
  assert.equal(sessionStore.persistedStates.at(-1), null, "a chain that wasn't extended is cleared");
});

test("a turn that fails after /new replaced its session writes nothing into the new one", async () => {
  let sessionStore!: ReturnType<typeof makeDeps>["sessionStore"];
  const provider = scriptedProvider([
    () => {
      // Mid-turn, the user sends /new: a fresh instance with an empty history.
      sessionStore.sessions.get("s1")!.instanceId = "inst2";
      sessionStore.messages.length = 0;
      throw Object.assign(new Error("upstream failure"), { status: 500 });
    },
  ]);
  const made = makeDeps(provider);
  sessionStore = made.sessionStore;

  await send(made.deps, "a message for the old conversation");
  assert.deepEqual(sessionStore.messages, [], "nothing from the old turn in the new conversation");
  assert.deepEqual(sessionStore.persistedStates, [], "the new conversation's chain is untouched");
});

// ============================================================================
// T1-1 (HITL): resuming a form sends every output the paused response needs
// ============================================================================

function memoryHitlStore() {
  const states = new Map<string, Record<string, unknown>>();
  return {
    states,
    async create(state: { requestId: string }) {
      states.set(state.requestId, structuredClone(state) as Record<string, unknown>);
    },
    async get(requestId: string) {
      return (states.get(requestId) as never) ?? null;
    },
    async updateStatus(requestId: string, _userId: string, status: string) {
      const s = states.get(requestId);
      if (s) s.status = status;
    },
    async setCompletedToolResults(requestId: string, _userId: string, results: unknown) {
      const s = states.get(requestId);
      if (s) s.completedToolResults = results;
    },
    async listPending() {
      return [...states.values()].filter((s) => s.status === "pending") as never[];
    },
  };
}

test("a form asked alongside other tool calls resumes with all their outputs", async () => {
  const provider = scriptedProvider([
    () =>
      toolCallResponse([
        { name: "memory_search", args: { query: "x" }, callId: "call_search" },
        { name: "request_user_input", args: { type: "text_input", intent: "Which city?" }, callId: "call_form" },
      ]),
    () => textResponse("Thanks!"),
  ]);
  const hitlStore = memoryHitlStore();
  const { deps } = makeDeps(provider, {
    hitlStore: hitlStore as unknown as RunnerDeps["hitlStore"],
    memoryToolHandler: async () => JSON.stringify({ results: ["found"] }),
  });

  const first = await send(deps, "plan my trip", { hitlWidgets: true });
  assert.equal(first.status, "awaiting_input");
  const [requestId] = [...hitlStore.states.keys()];
  assert.ok(requestId, "a pending input request was saved");

  await send(deps, "", { hitlInputResponse: { requestId, data: { city: "Pune" } } });
  const resumed = provider.requests.at(-1)!;
  const outputs = resumed.input as Array<{ type: string; callId: string; output: string }>;
  assert.deepEqual(outputs.map((o) => o.callId).sort(), ["call_form", "call_search"]);
  assert.match(outputs.find((o) => o.callId === "call_search")!.output, /found/);
});

// ============================================================================
// T1-6: one tool's exception is that tool's output, not the run's failure
// ============================================================================

test("a tool that throws returns an error to the model and the run completes", async () => {
  const provider = scriptedProvider([
    () => toolCallResponse([{ name: "memory_search", args: { query: "x" }, callId: "call_boom" }]),
    () => textResponse("Search is down, but here's what I know."),
  ]);
  const { deps } = makeDeps(provider, {
    memoryToolHandler: async () => {
      throw new Error("cosmos unavailable");
    },
  });

  const res = await send(deps);
  assert.equal(res.status, "completed");
  const outputs = provider.requests[1]!.input as Array<{ callId: string; output: string }>;
  assert.equal(outputs[0]!.callId, "call_boom");
  assert.match(outputs[0]!.output, /Tool memory_search failed: cosmos unavailable/);
});

test("a run that fails after completed rounds reports their usage for billing", async () => {
  const provider = scriptedProvider([
    () => toolCallResponse([{ name: "memory_search", args: { query: "x" } }]),
    () => {
      throw Object.assign(new Error("upstream exploded"), { status: 500 });
    },
  ]);
  const { deps } = makeDeps(provider);
  let failed: { usage?: { totalTokens: number }; model?: string } | undefined;
  deps.hooks.on("run_failed", (e) => {
    failed = e;
  });

  const res = await send(deps);
  assert.equal(res.status, "failed");
  assert.equal(failed?.usage?.totalTokens, 15, "the first round's tokens");
  assert.equal(failed?.model, "test-model");
});

// ============================================================================
// T2-3 / T1-8: one turn per session at a time
// ============================================================================

test("a second turn while one is running in the same session is refused, not forked", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const provider = scriptedProvider([
    async () => {
      await gate;
      return textResponse("first");
    },
  ]);
  const { deps, sessionStore } = makeDeps(provider);

  const first = send(deps, "one");
  await new Promise((r) => setTimeout(r, 20));
  const second = await send(deps, "two");
  assert.equal(second.status, "failed");
  assert.equal(second.error, "SESSION_BUSY");
  assert.match(second.text, /still working on your previous message/);

  release();
  assert.equal((await first).status, "completed");
  assert.equal(sessionStore.leases.size, 0, "the lease is released");
  assert.equal((await send(deps, "three")).status, "completed");
});

// ============================================================================
// T2-1: deltas carry new text and its offset, not the whole reply so far
// ============================================================================

test("streamed deltas are coalesced, carry offsets, and rebuild the reply", async () => {
  const { registerWebSocketProvider } = await import("../websocket/providers/index.js");
  const frames: Array<{ payload?: Record<string, unknown> }> = [];
  registerWebSocketProvider("capture", () => ({
    id: "capture",
    async sendToUser(_u: string, frame: unknown) {
      frames.push(frame as { payload?: Record<string, unknown> });
    },
  }) as never);
  const saved = process.env.WEBSOCKET_PROVIDER;
  process.env.WEBSOCKET_PROVIDER = "capture";
  try {
    const final = textResponse("Hello world");
    const provider = {
      id: "openai",
      async createResponse() {
        throw new Error("not used");
      },
      async *streamResponse() {
        yield { type: "text_delta", delta: "Hel" };
        yield { type: "text_delta", delta: "lo " };
        await new Promise((r) => setTimeout(r, 500)); // past the flush window
        yield { type: "text_delta", delta: "world" };
        yield { type: "done", response: final };
      },
    } as unknown as Provider;
    const { deps } = makeDeps(provider, { realtimeEnabled: true, streamToClient: true });
    const res = await runAgentTurn({ userId: "u1", sessionId: "s1", message: "hi" } as never, deps, () => {});
    assert.equal(res.status, "completed");

    const deltas = frames.map((f) => f.payload).filter((p) => p?.state === "delta") as Array<{
      delta: string;
      offset: number;
      accumulated?: string;
    }>;
    assert.deepEqual(
      deltas.map((d) => [d.offset, d.delta]),
      [
        [0, "Hel" + "lo "],
        [6, "world"],
      ],
    );
    assert.ok(deltas.every((d) => d.accumulated === undefined), "no full-text snapshot per push");
    const rebuilt = deltas.reduce((text, d) => text.slice(0, d.offset) + d.delta, "");
    assert.equal(rebuilt, "Hello world");
  } finally {
    if (saved === undefined) delete process.env.WEBSOCKET_PROVIDER;
    else process.env.WEBSOCKET_PROVIDER = saved;
  }
});

test("a retry of the same request waits for the original, then replays its reply", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const provider = scriptedProvider([
    async () => {
      await gate;
      return textResponse("once");
    },
  ]);
  const { registerWebSocketProvider } = await import("../websocket/providers/index.js");
  const pushed: Array<{ payload?: { state?: string } }> = [];
  registerWebSocketProvider("capture-dup", () => ({
    id: "capture-dup",
    async sendToUser(_u: string, frame: unknown) {
      pushed.push(frame as { payload?: { state?: string } });
    },
  }) as never);
  const saved = process.env.WEBSOCKET_PROVIDER;
  process.env.WEBSOCKET_PROVIDER = "capture-dup";
  try {
    const { deps } = makeDeps(provider, { realtimeEnabled: true, streamToClient: true });
    const same = { runId: "run-fixed", idempotencyKey: "key-1" };
    const first = send(deps, "hello", same);
    await new Promise((r) => setTimeout(r, 20));
    const retry = send(deps, "hello", same); // arrives while the original runs
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(a.text, "once");
    assert.equal(b.text, "once", "the retry replays the original's reply");
    assert.equal(provider.requests.length, 1, "the model ran once");
    assert.ok(!pushed.some((f) => f.payload?.state === "error"), "no busy error for a duplicate");
  } finally {
    if (saved === undefined) delete process.env.WEBSOCKET_PROVIDER;
    else process.env.WEBSOCKET_PROVIDER = saved;
  }
});

test("a failed turn keeps the user's message in history, with a note, and clears the chain", async () => {
  const provider = scriptedProvider([
    () => {
      throw Object.assign(new Error("upstream exploded"), { status: 500 });
    },
  ]);
  const { deps, sessionStore } = makeDeps(provider);
  const res = await send(deps, "plan my week");
  assert.equal(res.status, "failed");
  assert.deepEqual(
    sessionStore.messages.map((m) => [m.role, m.content]),
    [
      ["user", "plan my week"],
      ["assistant", "(This reply failed before it finished: provider_unavailable.)"],
    ],
  );
  assert.equal(sessionStore.persistedStates.at(-1), null);
});

test("a redelivered turn takes over when the original delivery died holding the session", async () => {
  const provider = scriptedProvider([
    async () => new Promise<never>(() => {}), // the original: its instance is killed mid-call
    () => textResponse("answered by the redelivery"),
  ]);
  const { deps, sessionStore } = makeDeps(provider);
  void send(deps, "hello", { runId: "run-crashed" });
  await new Promise((r) => setTimeout(r, 30));
  // The original's instance dies: nothing renews its lease, and it lapses.
  setTimeout(() => sessionStore.leases.delete("s1"), 60);
  const redelivered = await send(deps, "hello", { runId: "run-crashed" });
  assert.equal(redelivered.status, "completed");
  assert.equal(redelivered.text, "answered by the redelivery");
});

test("a run whose lease was taken mid-turn writes nothing and reports an interruption", async () => {
  const provider = scriptedProvider([
    async () => {
      // Meanwhile the lease lapsed and another execution took the session.
      sessionStore.leases.set("s1", { leaseId: "someone-else", runId: "other-run" });
      return textResponse("late answer");
    },
  ]);
  const { deps, sessionStore } = makeDeps(provider);
  const res = await send(deps, "hello");
  assert.equal(res.status, "failed");
  assert.deepEqual(sessionStore.messages, [], "no second answer, no failure note");
});

test("without an idempotency key, a second delivery of a finished run replays it instead of answering again", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const provider = scriptedProvider([
    async () => {
      await gate;
      return textResponse("only once");
    },
  ]);
  const { deps } = makeDeps(provider);
  const first = send(deps, "hello", { runId: "run-nokey" });
  await new Promise((r) => setTimeout(r, 20));
  const redelivery = send(deps, "hello", { runId: "run-nokey" });
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [a, b] = await Promise.all([first, redelivery]);
  assert.equal(a.text, "only once");
  assert.equal(b.text, "only once");
  assert.equal(provider.requests.length, 1, "the model ran once");
});
