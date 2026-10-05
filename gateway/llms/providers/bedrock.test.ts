import test from "node:test";
import assert from "node:assert/strict";

import { BedrockProvider, bedrockRequest, type BedrockClient } from "./bedrock.js";
import type { ProviderConfig, StreamEvent } from "../types.js";

const config: ProviderConfig = { apiKey: "", defaultModel: "amazon.nova-lite-v1:0" };
const client = (send: (command: any, options: any) => Promise<unknown>) => ({ send }) as unknown as BedrockClient;

test("Bedrock preserves a full tool loop and sends this round's tool images once", async () => {
  let request: any;
  const provider = new BedrockProvider(
    config,
    client(async (command) => {
      request = command.input;
      return {
        output: { message: { content: [{ toolUse: { toolUseId: "t1", name: "memory_search", input: { query: "cats" } } }] } },
        stopReason: "tool_use",
        usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
      };
    }),
  );
  const response = await provider.createResponse({
    input: "remember cats",
    maxOutputTokens: 128,
    tools: [{ type: "function", name: "memory_search", parameters: { type: "object" } }],
  });
  assert.equal(request.inferenceConfig.maxTokens, 128);
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.conversationState!.messages!.length, 2);
  const next = bedrockRequest(
    {
      input: [{ type: "function_call_output", callId: "t1", output: "found", images: [{ mediaType: "image/png", data: "YWJj" }] }],
      conversation: response.conversationState,
    },
    config,
  );
  assert.equal(next.messages![0].content![0].text, "remember cats");
  assert.equal(next.messages![1].content![0].toolUse?.toolUseId, "t1");
  assert.equal(next.messages![2].content![0].toolResult?.content?.length, 2);
});

test("Bedrock streams text and fragmented tool calls, keeping the final usage and arguments", async () => {
  async function* stream() {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } };
    yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call", name: "exec_command" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"command":' } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"pwd"}' } } } };
    yield { contentBlockStop: { contentBlockIndex: 1 } };
    yield { messageStop: { stopReason: "tool_use" } };
    yield { metadata: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } };
  }
  const provider = new BedrockProvider(config, client(async () => ({ stream: stream() })));
  const events: StreamEvent[] = [];
  for await (const e of provider.streamResponse({ input: "test" })) events.push(e);
  assert.equal(events[0].type, "text_delta");
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type === "done") {
    assert.equal(done.response.status, "completed");
    assert.equal(done.response.usage?.totalTokens, 5);
    assert.deepEqual(done.response.output[1], { type: "function_call", callId: "call", name: "exec_command", arguments: '{"command":"pwd"}' });
  }
});

test("Bedrock never reports a stream fault or a truncated response as completed", async () => {
  async function* bad() {
    yield { throttlingException: { message: "quota" } };
  }
  const faulty = new BedrockProvider(config, client(async () => ({ stream: bad() })));
  await assert.rejects(async () => {
    for await (const _e of faulty.streamResponse({ input: "test" })) {
      // drain
    }
  }, /quota/);
  const truncated = new BedrockProvider(
    config,
    client(async () => ({ output: { message: { content: [{ text: "partial" }] } }, stopReason: "max_tokens" })),
  );
  assert.equal((await truncated.createResponse({ input: "test" })).status, "incomplete");
  const unfinished = new BedrockProvider(config, client(async () => ({ output: { message: { content: [] } } })));
  assert.equal((await unfinished.createResponse({ input: "test" })).status, "failed");
});

test("Bedrock honours cancellation and rejects native tools and remote image URLs", async () => {
  const controller = new AbortController();
  controller.abort();
  let aborted = false;
  const provider = new BedrockProvider(
    config,
    client(async (_command, options) => {
      aborted = options.abortSignal.aborted;
      throw options.abortSignal.reason;
    }),
  );
  await assert.rejects(provider.createResponse({ input: "x", abortSignal: controller.signal }));
  assert.equal(aborted, true);
  assert.throws(() => bedrockRequest({ input: "x", tools: [{ type: "web_search" }] }, config), /unsupported native tool/);
  assert.throws(
    () => bedrockRequest({ input: [{ role: "user", content: [{ type: "image", source: { type: "url", data: "http://internal" } }] }] }, config),
    /base64/,
  );
  assert.equal(bedrockRequest({ input: "x", tools: [{ type: "web_search" }], toolChoice: "none" }, config).toolConfig, undefined);
  assert.throws(() => new BedrockProvider({ ...config, baseUrl: "https://example.com" }), /baseUrl/);
});
