import test from "node:test";
import assert from "node:assert/strict";

import { SEEN_IMAGE_NOTE, transcriptThroughInput } from "./transcript.js";
import type { ProviderRequest } from "./types.js";

test("the transcript keeps the runner's order: history first, new message last", () => {
  const messages = transcriptThroughInput({
    input: [
      { role: "user", content: "oldest" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "newest" },
    ],
  } as ProviderRequest);
  assert.deepEqual(messages.map((m) => m.content), ["oldest", "reply", "newest"]);
});

test("tool outputs become one user message of tool_result blocks after the prior rounds", () => {
  const messages = transcriptThroughInput({
    input: [
      { type: "function_call_output", callId: "a", output: "1" },
      { type: "function_call_output", callId: "b", output: "2" },
    ],
    conversation: { messages: [{ role: "user", content: "q" }] },
  } as ProviderRequest);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: "1" },
      { type: "tool_result", tool_use_id: "b", content: "2" },
    ],
  });
});

test("only the latest round's tool images are kept; earlier ones become a note", () => {
  const round1 = transcriptThroughInput({
    input: [{ type: "function_call_output", callId: "a", output: "first shot", images: [{ mediaType: "image/jpeg", data: "AAAA" }] }],
    conversation: { messages: [{ role: "user", content: "q" }] },
  } as ProviderRequest);
  const kept = (round1[1]!.content as Array<{ images?: unknown[] }>)[0]!;
  assert.equal(kept.images?.length, 1, "the round's own image is kept for the model to see");

  const round2 = transcriptThroughInput({
    input: [{ type: "function_call_output", callId: "b", output: "second shot", images: [{ mediaType: "image/jpeg", data: "AAAA" }] }],
    conversation: { messages: round1 },
  } as ProviderRequest);
  const earlier = (round2[1]!.content as Array<{ content: string; images?: unknown[] }>)[0]!;
  assert.equal(earlier.images, undefined, "the earlier image is not resent");
  assert.equal(earlier.content, `first shot\n${SEEN_IMAGE_NOTE}`);
  const latest = (round2[2]!.content as Array<{ images?: unknown[] }>)[0]!;
  assert.equal(latest.images?.length, 1);
  assert.equal((round1[1]!.content as Array<{ images?: unknown[] }>)[0]!.images?.length, 1, "earlier transcripts aren't mutated");
});
