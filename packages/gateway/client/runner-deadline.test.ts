/**
 * A stalled provider stream and a run past its deadline must end the run
 * promptly with a clear error, not hang until the platform kills it.
 *
 * Separate file: the timeouts are read from the environment at import.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.LLM_STREAM_IDLE_TIMEOUT_MS = "100";

const { runAgentTurn } = await import("./runner.js");
const { makeDeps, textResponse } = await import("./runner.test-harness.js");

import type { Provider, ProviderRequest, StreamEvent } from "../llms/types.js";

function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
      once: true,
    });
  });
}

test("a stream that stalls mid-reply fails after the idle timeout and its request is aborted", async () => {
  let requestSignal: AbortSignal | undefined;
  const provider = {
    id: "openai",
    async createResponse() {
      throw new Error("not used");
    },
    async *streamResponse(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requestSignal = req.abortSignal;
      yield { type: "text_delta", delta: "Hel" } as StreamEvent;
      // A generator that ignores its signal: the old code awaited return()
      // here, which queues behind this pending next() forever.
      await new Promise(() => {});
    },
  } as unknown as Provider;
  const { deps } = makeDeps(provider);

  const started = Date.now();
  const res = await runAgentTurn(
    { userId: "u1", sessionId: "s1", message: "hi" } as never,
    deps,
    () => {},
  );
  assert.equal(res.status, "failed");
  assert.match(String(res.error), /no events for/);
  assert.ok(Date.now() - started < 3000, "fails promptly");
  assert.equal(requestSignal?.aborted, true, "the provider request is aborted");
});

test("a run past its deadline fails with a timeout, and the provider call is aborted", async () => {
  const provider = {
    id: "openai",
    async createResponse(req: ProviderRequest) {
      return aborted(req.abortSignal);
    },
    streamResponse() {
      throw new Error("not used");
    },
  } as unknown as Provider;
  const { deps } = makeDeps(provider);

  const res = await runAgentTurn(
    { userId: "u1", sessionId: "s1", message: "hi", deadlineAt: Date.now() + 150 } as never,
    deps,
  );
  assert.equal(res.status, "failed");
  assert.match(String(res.error), /timed out/);
});

test("a run within its deadline is unaffected", async () => {
  const provider = {
    id: "openai",
    async createResponse() {
      return textResponse("done");
    },
    streamResponse() {
      throw new Error("not used");
    },
  } as unknown as Provider;
  const { deps } = makeDeps(provider);
  const res = await runAgentTurn(
    { userId: "u1", sessionId: "s1", message: "hi", deadlineAt: Date.now() + 60_000 } as never,
    deps,
  );
  assert.equal(res.status, "completed");
});
