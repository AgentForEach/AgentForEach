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
