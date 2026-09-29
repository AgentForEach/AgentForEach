import test from "node:test";
import assert from "node:assert/strict";

import { isTransientStreamError, retryStreamStart } from "./stream-retry.js";
import type { StreamEvent } from "./types.js";

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const dropped = () => Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" });

test("a stream that drops before its first event is retried once", async () => {
  let attempts = 0;
  const events = await collect(
    retryStreamStart(async function* () {
      attempts++;
      if (attempts === 1) throw dropped();
      yield { type: "text_delta", delta: "hi" } as StreamEvent;
    }),
  );
  assert.equal(attempts, 2);
  assert.deepEqual(events.map((e) => e.type), ["text_delta"]);
});

test("an error event before any output is retried too", async () => {
  let attempts = 0;
  const events = await collect(
    retryStreamStart(async function* () {
      attempts++;
      if (attempts === 1) yield { type: "error", error: dropped() } as StreamEvent;
      else yield { type: "text_delta", delta: "ok" } as StreamEvent;
    }),
  );
  assert.equal(attempts, 2);
  assert.equal(events[0]!.type, "text_delta");
});

test("after output has started, a failure is not retried (it would duplicate text)", async () => {
  let attempts = 0;
  await assert.rejects(
    collect(
      retryStreamStart(async function* () {
        attempts++;
        yield { type: "text_delta", delta: "partial" } as StreamEvent;
        throw dropped();
      }),
    ),
    /Premature close/,
  );
  assert.equal(attempts, 1);
});

test("non-transient failures and repeated drops surface as an error event", async () => {
  let attempts = 0;
  const events = await collect(
    retryStreamStart(async function* () {
      attempts++;
      throw dropped();
    }),
  );
  assert.equal(attempts, 2, "one retry only");
  assert.equal(events.at(-1)!.type, "error");

  const bad = await collect(
    retryStreamStart(async function* () {
      throw Object.assign(new Error("invalid model"), { status: 400 });
    }),
  );
  assert.equal(bad.length, 1);
  assert.equal(isTransientStreamError(Object.assign(new Error("x"), { status: 429 })), false, "rate limits are not retried here");
});

test("an error event without an error object still reaches the caller", async () => {
  const events = await collect(
    retryStreamStart(async function* () {
      yield { type: "error", error: undefined } as unknown as StreamEvent;
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "error");
});
