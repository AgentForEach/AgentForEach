import test from "node:test";
import assert from "node:assert/strict";

import { OpenAICompletionsProvider } from "./openai-completions.js";
import type { ProviderRequest } from "../types.js";

const provider = new OpenAICompletionsProvider({ apiKey: "test", defaultModel: "m" } as never);
const build = (r: ProviderRequest) =>
  (provider as unknown as { buildMessages: (r: ProviderRequest) => Array<{ role: string; content: unknown }> })
    .buildMessages(r);

test("history keeps its order and the new message comes last", () => {
  const messages = build({
    instructions: "sys",
    input: [
      { role: "user", content: "oldest" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "newest" },
    ],
  } as ProviderRequest);
  assert.deepEqual(
    messages.map((m) => m.content),
    ["sys", "oldest", "reply", "newest"],
  );
});

test("tool images follow the text-only tool messages in one user message", () => {
  const messages = build({
    input: [
      { type: "function_call_output", callId: "c1", output: "shot taken", images: [{ mediaType: "image/jpeg", data: "AAAA" }] },
      { type: "function_call_output", callId: "c2", output: "plain" },
    ],
    conversation: { messages: [] },
  } as ProviderRequest);
  assert.deepEqual(messages.map((m) => m.role), ["tool", "tool", "user"], "tool messages stay together, images after");
  assert.equal(messages[0]!.content, "shot taken");
  assert.deepEqual(messages[2]!.content, [
    { type: "text", text: "Image returned by tool call c1:" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "auto" } },
  ]);
});

test("tool results without images add no extra message", () => {
  const messages = build({
    input: [{ type: "function_call_output", callId: "c1", output: "plain" }],
    conversation: { messages: [] },
  } as ProviderRequest);
  assert.deepEqual(messages.map((m) => m.role), ["tool"]);
});
