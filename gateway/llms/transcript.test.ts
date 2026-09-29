import test from "node:test";
import assert from "node:assert/strict";

import { transcriptThroughInput } from "./transcript.js";
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
