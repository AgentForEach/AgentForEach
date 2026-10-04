import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage } from "@agentforeach/storage";
import type { DurableContext } from "@agentforeach/platform";
import { SessionStore, resetSessionConfigCache } from "./index.js";
import { INTERRUPTED_MESSAGE, noteInterruptedTurn, turnExecutionId, type InterruptedTurnDeps } from "./interrupted.js";

async function setup() {
  resetSessionConfigCache();
  const store = new SessionStore(new InMemoryStorage(), {
    maxHistoryMessages: 100,
    ttlSeconds: 86400,
    compactionThreshold: 60,
    compactionRetainCount: 20,
  });
  await store.initialize();
  const session = await store.getOrCreate("u1", "default");
  const pushed: Array<Record<string, unknown>> = [];
  const deps: InterruptedTurnDeps = {
    sessions: async () => store,
    push: async (_userId, data) => void pushed.push(data),
  };
  return { store, sessionId: session.sessionId, pushed, deps };
}

function rerun(instanceId: string, attempt = 2): DurableContext {
  const noop = () => {};
  return { instanceId, attempt, log: noop, warn: noop, error: noop, trace: noop } as unknown as DurableContext;
}

const turn = (sessionId: string) => ({ userId: "u1", sessionId, runId: "run-1" });

test("the execution id names the instance and attempt, and is unset where attempts aren't counted", () => {
  assert.equal(turnExecutionId(rerun("chat-x", 1)), "chat-x#1");
  assert.equal(turnExecutionId({ ...rerun("chat-x"), attempt: undefined } as DurableContext), undefined);
});

test("a re-run releases the lease the cut-off run of its instance left, notes it once, and tells the user", async () => {
  const { store, sessionId, pushed, deps } = await setup();
  // The lease's run id isn't the turn's: a form resume runs under a new one.
  const cutOff = `${turnExecutionId(rerun("chat-x", 1))}:abc`;
  assert.equal(await store.acquireRunLease("u1", sessionId, cutOff, Date.now() + 60_000, Date.now(), "resume-run"), true);

  await noteInterruptedTurn(turn(sessionId), rerun("chat-x"), deps);
  assert.equal(await store.peekActiveRun("u1", sessionId), undefined, "the session is free at once");

  // Cut off again after the note: the next re-run doesn't write it twice.
  await noteInterruptedTurn(turn(sessionId), rerun("chat-x", 3), deps);
  const notes = (await store.getMessages("u1", sessionId)).filter((m) => m.content === INTERRUPTED_MESSAGE);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].runId, "run-1");
  assert.equal(pushed.length, 2);
  assert.equal(pushed[0].code, "interrupted");
  assert.equal(pushed[0].runId, "run-1");
});

test("a lease another execution holds is left alone, even for the same run id", async () => {
  const { store, sessionId, deps } = await setup();
  // A `wait: true` retry of the same request: same runId, its own lease.
  assert.equal(await store.acquireRunLease("u1", sessionId, "live-lease", Date.now() + 60_000, Date.now(), "run-1"), true);
  await noteInterruptedTurn(turn(sessionId), rerun("chat-x"), deps);
  assert.equal((await store.peekActiveRun("u1", sessionId))?.leaseId, "live-lease");

  // Nor a lease from a different instance's executions.
  const other = await setup();
  await other.store.acquireRunLease("u1", other.sessionId, "chat-xy#1:abc", Date.now() + 60_000, Date.now(), "run-1");
  await noteInterruptedTurn(turn(other.sessionId), rerun("chat-x"), other.deps);
  assert.equal((await other.store.peekActiveRun("u1", other.sessionId))?.leaseId, "chat-xy#1:abc");
});

test("the session is freed even if the note can't be written", async () => {
  const { store, sessionId, deps } = await setup();
  await store.acquireRunLease("u1", sessionId, "chat-x#1:abc", Date.now() + 60_000, Date.now(), "run-1");
  store.appendMessages = async () => {
    throw new Error("store unavailable");
  };
  await noteInterruptedTurn(turn(sessionId), rerun("chat-x"), deps);
  assert.equal(await store.peekActiveRun("u1", sessionId), undefined);
});

test("without a session, the user is still told", async () => {
  const { pushed, deps } = await setup();
  await noteInterruptedTurn({ userId: "u1", runId: "run-1" }, rerun("chat-x"), deps);
  assert.equal(pushed.length, 1);
});
