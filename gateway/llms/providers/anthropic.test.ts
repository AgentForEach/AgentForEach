/**
 * Anthropic provider — request shape for current Claude models.
 *
 * The failover leg was silently dead: it pinned a retired model and sent
 * parameters (budget_tokens thinking, temperature/top_p) that every current
 * Claude model rejects with a 400, so any transient OpenAI error became a
 * hard failure. These tests pin the corrected request shape so a regression
 * cannot reintroduce the dead leg.
 *
 *   npx tsx --test gateway/llms/providers/anthropic.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicProvider } from "./anthropic.js";
import type { ProviderRequest } from "../types.js";

const provider = new AnthropicProvider({
  apiKey: "test-key",
  defaultModel: "claude-sonnet-5",
});

// buildRequestParams is private; reach it deliberately — the wire shape is
// exactly what these tests exist to pin.
const build = (request: ProviderRequest, model = "claude-sonnet-5") =>
  (provider as unknown as {
    buildRequestParams: (r: ProviderRequest, m: string) => Record<string, unknown>;
  }).buildRequestParams(request, model);

const baseRequest = (overrides: Partial<ProviderRequest> = {}): ProviderRequest =>
  ({
    input: "hello",
    ...overrides,
  }) as ProviderRequest;

test("reasoning maps to adaptive thinking + output_config.effort, never budget_tokens", () => {
  const params = build(baseRequest({ reasoning: { effort: "medium" } }));
  assert.deepEqual(params.thinking, { type: "adaptive" });
  assert.deepEqual(params.output_config, { effort: "medium" });
  assert.ok(
    !JSON.stringify(params).includes("budget_tokens"),
    "budget_tokens is rejected with a 400 by current Claude models",
  );
});

test("effort vocabulary maps onto Anthropic levels", () => {
  assert.deepEqual(
    build(baseRequest({ reasoning: { effort: "minimal" } })).output_config,
    { effort: "low" },
  );
  assert.deepEqual(
    build(baseRequest({ reasoning: { effort: "xhigh" } })).output_config,
    { effort: "xhigh" },
  );
});

test("effort 'none' disables thinking instead of sending a zero budget", () => {
  const params = build(baseRequest({ reasoning: { effort: "none" } }));
  assert.deepEqual(params.thinking, { type: "disabled" });
  assert.equal(params.output_config, undefined);
});

test("sampling params are never forwarded — current models 400 on them", () => {
  const params = build(baseRequest({ temperature: 0.7, topP: 0.9 }));
  assert.equal(params.temperature, undefined);
  assert.equal(params.top_p, undefined);
});

test("no reasoning field means no thinking config (model default applies)", () => {
  const params = build(baseRequest());
  assert.equal(params.thinking, undefined);
});

// ============================================================================
// Tool loop: the second round must still carry the question (T1-2)
// ============================================================================

const mapResponse = (message: unknown, request: ProviderRequest) =>
  (provider as unknown as {
    mapResponse: (m: unknown, model: string, r: ProviderRequest) => import("../types.js").ProviderResponse;
  }).mapResponse(message, "claude-sonnet-5", request);

test("a tool round keeps the question, history and signed thinking", () => {
  const round1: ProviderRequest = {
    input: [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "what's the weather in Pune?" },
    ],
    reasoning: { effort: "medium" },
  } as ProviderRequest;

  const response = mapResponse(
    {
      id: "msg_1",
      model: "claude-sonnet-5",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: "thinking", thinking: "need the weather tool", signature: "sig-abc" },
        { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "Pune" } },
      ],
    },
    round1,
  );

  // The runner's next round: the transcript so far plus the tool result.
  const round2 = build({
    input: [{ type: "function_call_output", callId: "toolu_1", output: "31°C" }],
    conversation: { messages: response.conversationState!.messages },
    reasoning: { effort: "medium" },
  } as ProviderRequest) as { messages: Array<{ role: string; content: unknown }> };

  const wire = JSON.stringify(round2.messages);
  assert.match(wire, /what's the weather in Pune\?/, "the question is still there");
  assert.match(wire, /earlier question/);
  assert.equal(round2.messages[0]!.role, "user");
  const assistant = round2.messages.at(-2)!;
  assert.deepEqual((assistant.content as Array<{ type: string }>)[0], {
    type: "thinking",
    thinking: "need the weather tool",
    signature: "sig-abc",
  });
  const last = round2.messages.at(-1)! as { role: string; content: Array<{ type: string; tool_use_id: string }> };
  assert.equal(last.role, "user");
  assert.equal(last.content[0]!.type, "tool_result");
  assert.equal(last.content[0]!.tool_use_id, "toolu_1");
});

test("the user id reaches Anthropic only as a pseudonym", () => {
  const params = build(baseRequest({ metadata: { userId: "whatsapp:+15551234567" } } as Partial<ProviderRequest>));
  const userId = (params.metadata as { user_id?: string }).user_id;
  assert.ok(userId && !userId.includes("15551234567"));
});
