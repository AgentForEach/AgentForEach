/**
 * Failover across providers when the primary chains responses
 * (previousResponseId), which no other provider can follow.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import { resetCooldowns, withFailover, withFailoverStream, type FailoverConfig } from "./failover.js";
import type { Provider, ProviderId, ProviderRequest, ProviderResponse, StreamEvent } from "./types.js";

const CONFIG: FailoverConfig = {
  enabled: true,
  retryableStatusCodes: [429, 500, 502, 503],
  maxRetries: 2,
  cooldownMs: 60_000,
  chain: ["openai", "anthropic"],
};

const HISTORY = [
  { role: "user" as const, content: "My name is Ann." },
  { role: "assistant" as const, content: "Nice to meet you, Ann." },
  { role: "user" as const, content: "What's my name?" },
];

class FakeProvider implements Provider {
  readonly requests: ProviderRequest[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly failWith?: number,
  ) {}

  async createResponse(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    if (this.failWith) throw Object.assign(new Error("rate limited"), { status: this.failWith });
    return { providerId: this.id, responseId: `${this.id}-1`, model: request.model ?? "m", text: "ok", output: [], status: "completed" };
  }

  async *streamResponse(request: ProviderRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    if (this.failWith) throw Object.assign(new Error("rate limited"), { status: this.failWith });
    yield { type: "text_delta", delta: "ok" };
  }
}

function providers(openaiStatus?: number) {
  const openai = new FakeProvider("openai", openaiStatus);
  const anthropic = new FakeProvider("anthropic");
  const resolve = (id: ProviderId) => (id === "openai" ? openai : anthropic);
  return { openai, anthropic, resolve };
}

const defaultModel = (id: ProviderId) => `${id}-default`;

beforeEach(() => resetCooldowns());

test("a chained turn that fails over sends the fallback the whole conversation", async () => {
  const { anthropic, resolve } = providers(429);
  const request: ProviderRequest = {
    model: "gpt",
    input: [HISTORY[2]!],
    failoverInput: HISTORY,
    conversation: { previousResponseId: "resp_prev", containerId: "cntr_1" },
  };

  const result = await withFailover("openai", CONFIG, resolve, defaultModel, request);

  assert.equal(result.providerId, "anthropic");
  const sent = anthropic.requests[0]!;
  assert.deepEqual(sent.input, HISTORY);
  assert.equal(sent.conversation?.previousResponseId, undefined);
  assert.equal(sent.model, "anthropic-default");
});

test("the streaming path sends the fallback the whole conversation too", async () => {
  const { anthropic, resolve } = providers(429);
  const request: ProviderRequest = {
    model: "gpt",
    input: [HISTORY[2]!],
    failoverInput: HISTORY,
    conversation: { previousResponseId: "resp_prev" },
  };

  for await (const _ of withFailoverStream("openai", CONFIG, resolve, defaultModel, request)) {
    // drain
  }
  assert.deepEqual(anthropic.requests[0]!.input, HISTORY);
});

test("a tool round that continues this turn's response never moves to another provider", async () => {
  const { openai, anthropic, resolve } = providers(429);
  const toolRound: ProviderRequest = {
    model: "gpt",
    input: [{ type: "function_call_output", callId: "call_1", output: "{}" }],
    conversation: { previousResponseId: "resp_this_turn" },
  };

  await assert.rejects(() => withFailover("openai", CONFIG, resolve, defaultModel, toolRound), /rate limited|exhausted/);
  assert.equal(openai.requests.length, 1);
  assert.equal(anthropic.requests.length, 0);
});

test("a request pinned to its provider is tried even while that provider cools down", async () => {
  const failing = providers(429);
  // An unchained request fails over and puts openai in cooldown.
  await withFailover("openai", CONFIG, failing.resolve, defaultModel, { model: "gpt", input: "hi" });

  const healthy = providers();
  const toolRound: ProviderRequest = {
    model: "gpt",
    input: [{ type: "function_call_output", callId: "call_1", output: "{}" }],
    conversation: { previousResponseId: "resp_this_turn" },
  };
  const result = await withFailover("openai", CONFIG, healthy.resolve, defaultModel, toolRound);
  assert.equal(result.providerId, "openai");
});

test("unchained requests fail over as before", async () => {
  const { anthropic, resolve } = providers(429);
  const result = await withFailover("openai", CONFIG, resolve, defaultModel, { model: "gpt", input: HISTORY });
  assert.equal(result.providerId, "anthropic");
  assert.deepEqual(anthropic.requests[0]!.input, HISTORY);
});
