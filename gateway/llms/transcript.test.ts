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

test("the saved transcript never holds a tool's image: it went in that round's own input", () => {
  const input = [{ type: "function_call_output", callId: "a", output: "first shot", images: [{ mediaType: "image/jpeg", data: "AAAA" }] }];
  const request = { input, conversation: { messages: [{ role: "user", content: "q" }] } } as ProviderRequest;
  const saved = transcriptThroughInput(request);
  const block = (saved[1]!.content as Array<{ content: string; images?: unknown[] }>)[0]!;
  assert.equal(block.images, undefined);
  assert.equal(block.content, `first shot\n${SEEN_IMAGE_NOTE}`);
  assert.equal((input[0] as { images?: unknown[] }).images?.length, 1, "the request's own input isn't mutated");
});
