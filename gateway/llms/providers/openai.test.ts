import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIProvider } from "./openai.js";
import type { ProviderRequest } from "../types.js";

const provider = new OpenAIProvider({ apiKey: "test", defaultModel: "gpt-5.6-luna" } as never);
const build = (r: ProviderRequest) =>
  (provider as unknown as { buildRequestParams: (r: ProviderRequest, m: string) => Record<string, unknown> })
    .buildRequestParams(r, "gpt-5.6-luna");

test("requests carry a stable per-user prompt_cache_key, and no raw user or session id", () => {
  const req = (userId: string) =>
    ({ input: "hi", metadata: { userId, sessionId: "whatsapp-15551234567", runId: "r1" } }) as ProviderRequest;
  const a = build(req("whatsapp:+15551234567"));
  const again = build(req("whatsapp:+15551234567"));
  const other = build(req("whatsapp:+15557654321"));

  assert.equal(typeof a.prompt_cache_key, "string");
  assert.equal(a.prompt_cache_key, again.prompt_cache_key, "same user, same key");
  assert.notEqual(a.prompt_cache_key, other.prompt_cache_key);
  const wire = JSON.stringify(a);
  assert.ok(!wire.includes("15551234567"), "the phone number never reaches the provider");
  assert.equal((a.metadata as Record<string, string>).runId, "r1");
});

test("a tool result with an image sends an output list with input_text and input_image", () => {
  const params = build({
    input: [
      { type: "function_call_output", callId: "call_1", output: "shot taken", images: [{ mediaType: "image/jpeg", data: "AAAA" }] },
      { type: "function_call_output", callId: "call_2", output: "plain" },
    ],
  } as ProviderRequest);
  const input = params.input as Array<{ call_id: string; output: unknown }>;
  assert.deepEqual(input[0], {
    type: "function_call_output",
    call_id: "call_1",
    output: [
      { type: "input_text", text: "shot taken" },
      { type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "auto" },
    ],
  });
  assert.equal(input[1]!.output, "plain");
});

test("OpenAI Responses keeps responses to resume from (previous_response_id)", () => {
  assert.equal(provider.capabilities.chainsResponses, true);
});
