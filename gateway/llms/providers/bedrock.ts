/**
 * AgentForEach Provider Layer — Amazon Bedrock Provider
 *
 * Implements the Provider interface with the Bedrock Converse API, so any
 * Converse model (Amazon Nova, Anthropic Claude on Bedrock, Llama, ...) runs
 * the same tool loop. There is no API key: credentials come from the AWS
 * credential chain (an execution role, or the environment), and the region
 * from AWS_REGION.
 *
 * The AWS SDK is loaded with `await import()` the first time Bedrock is used
 * (`bedrockRuntime()`), so deployments that never select Bedrock never load
 * it, and the Cloudflare Worker aliases it to a stub. Install
 * `@aws-sdk/client-bedrock-runtime` next to the gateway to use it.
 *
 * Supports:
 *   - Function calling (toolUse / toolResult), with the tool's images
 *   - Reasoning content, sent back with its tool use
 *   - Streaming (ConverseStream)
 *   - Multi-turn conversations via message history
 *   - Vision (base64 images)
 *
 * Reference: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */

import { randomUUID } from "node:crypto";
import type {
  BedrockRuntimeClient,
  ContentBlock as AwsBlock,
  ConverseCommandInput,
  Message,
  TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";
import { transcriptThroughInput } from "../transcript.js";
import type {
  ContentBlock,
  FunctionCallOutput,
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
} from "../types.js";

// ============================================================================
// The SDK, loaded on first use
// ============================================================================

type BedrockSdk = typeof import("@aws-sdk/client-bedrock-runtime");

/** What the provider and the embeddings client need from a Bedrock client. */
export type BedrockClient = Pick<BedrockRuntimeClient, "send">;

let runtime: Promise<{ sdk: BedrockSdk; client: BedrockClient }> | undefined;

/**
 * The Bedrock runtime SDK and one shared client, loaded the first time
 * Bedrock is used. Shared by the model provider and the embeddings client.
 */
export function bedrockRuntime(): Promise<{ sdk: BedrockSdk; client: BedrockClient }> {
  runtime ??= import("@aws-sdk/client-bedrock-runtime").then(
    (sdk) => ({ sdk, client: new sdk.BedrockRuntimeClient({ maxAttempts: 3 }) }),
    (err) => {
      runtime = undefined;
      throw new Error(
        "bedrock: @aws-sdk/client-bedrock-runtime isn't installed; add it to the gateway's dependencies to use Bedrock",
        { cause: err },
      );
    },
  );
  return runtime;
}

// ============================================================================
// Request mapping
// ============================================================================

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 180_000;
const IMAGE_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);

function toAws(block: ContentBlock): AwsBlock {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "tool_use":
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input as never } };
    case "tool_result":
      return {
        toolResult: {
          toolUseId: block.tool_use_id,
          content: [
            { text: block.content },
            ...(block.images ?? []).map((image) => ({
              image: { format: image.mediaType.split("/")[1] as "png", source: { bytes: Buffer.from(image.data, "base64") } },
            })),
          ],
        },
      };
    case "image": {
      const format = block.source.mediaType?.split("/")[1];
      if (block.source.type !== "base64" || !IMAGE_FORMATS.has(format ?? "")) {
        throw new Error("Bedrock images require supported base64 image data");
      }
      return { image: { format: format as "png", source: { bytes: Buffer.from(block.source.data, "base64") } } };
    }
    case "thinking":
      return { reasoningContent: { reasoningText: { text: block.thinking, signature: block.signature } } };
    case "redacted_thinking":
      return { reasoningContent: { redactedContent: Buffer.from(block.data, "base64") } };
    default:
      throw new Error("Unsupported Bedrock content; use the shared document extraction path");
  }
}

/** The Converse request for a provider request. Exported for tests. */
export function bedrockRequest(request: ProviderRequest, config: ProviderConfig): ConverseCommandInput {
  let transcript = transcriptThroughInput(request);
  // The saved transcript strips earlier screenshots; send this round's tool images once.
  if (Array.isArray(request.input) && (request.input[0] as { type?: string } | undefined)?.type === "function_call_output") {
    transcript = [
      ...(request.conversation?.messages ?? []),
      {
        role: "user",
        content: (request.input as FunctionCallOutput[]).map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.output,
          images: r.images,
        })),
      },
    ];
  }
  const messages: Message[] = transcript.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? [{ text: m.content }] : m.content.map(toAws),
  }));
  const tools =
    request.toolChoice === "none"
      ? []
      : (request.tools ?? []).map((tool) => {
          if (tool.type !== "function") throw new Error(`Bedrock requires function tools; unsupported native tool: ${tool.type}`);
          return { toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.parameters as never } } };
        });
  const choice = request.toolChoice;
  const maxTokens = request.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("Bedrock maxOutputTokens must be positive");
  return {
    modelId: request.model ?? config.defaultModel,
    messages,
    ...(request.instructions ? { system: [{ text: request.instructions }] } : {}),
    inferenceConfig: { maxTokens, temperature: request.temperature, topP: request.topP },
    ...(tools.length
      ? {
          toolConfig: {
            tools,
            toolChoice: typeof choice === "object" ? { tool: { name: choice.name } } : choice === "required" ? { any: {} } : { auto: {} },
          },
        }
      : {}),
  };
}

// ============================================================================
// Response mapping
// ============================================================================

function fromAws(block: AwsBlock): ContentBlock | undefined {
  if (block.text !== undefined) return { type: "text", text: block.text };
  if (block.toolUse) return { type: "tool_use", id: block.toolUse.toolUseId!, name: block.toolUse.name!, input: block.toolUse.input };
  if (block.reasoningContent?.reasoningText) {
    return { type: "thinking", thinking: block.reasoningContent.reasoningText.text!, signature: block.reasoningContent.reasoningText.signature! };
  }
  if (block.reasoningContent?.redactedContent) {
    return { type: "redacted_thinking", data: Buffer.from(block.reasoningContent.redactedContent).toString("base64") };
  }
  return undefined;
}

/** A missing or unknown stop reason is a failure, and max_tokens is incomplete, never completed. */
function result(config: ProviderConfig, request: ProviderRequest, content: AwsBlock[], stop: string | undefined, usage?: TokenUsage): ProviderResponse {
  const blocks = content.map(fromAws).filter((v): v is ContentBlock => !!v);
  const text = blocks
    .filter((v): v is Extract<ContentBlock, { type: "text" }> => v.type === "text")
    .map((v) => v.text)
    .join("");
  const failed = !stop || !["end_turn", "tool_use", "stop_sequence", "max_tokens"].includes(stop);
  return {
    providerId: config.providerId ?? "bedrock",
    responseId: randomUUID(),
    model: request.model ?? config.defaultModel,
    text,
    output: blocks.flatMap((v): ProviderResponse["output"] =>
      v.type === "text"
        ? [{ type: "message", role: "assistant", content: [v] }]
        : v.type === "tool_use"
          ? [{ type: "function_call", callId: v.id, name: v.name, arguments: JSON.stringify(v.input) }]
          : [],
    ),
    status: failed ? "failed" : stop === "max_tokens" ? "incomplete" : "completed",
    ...(failed ? { error: { code: stop ?? "missing_stop_reason", message: "Bedrock did not complete the response" } } : {}),
    usage: usage
      ? { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, totalTokens: usage.totalTokens!, cachedInputTokens: usage.cacheReadInputTokens }
      : undefined,
    conversationState: { messages: [...transcriptThroughInput(request), { role: "assistant", content: blocks }] },
  };
}

// ============================================================================
// Bedrock Provider
// ============================================================================

export class BedrockProvider implements Provider {
  readonly id: string;
  readonly capabilities = { nativeDocuments: false, chainsResponses: false };

  /** `client` replaces the shared Bedrock client (tests). */
  constructor(
    private config: ProviderConfig,
    private client?: BedrockClient,
  ) {
    if (config.baseUrl) throw new Error("Bedrock uses regional AWS endpoints; baseUrl is not supported");
    this.id = config.providerId ?? "bedrock";
  }

  private async runtime(): Promise<{ sdk: BedrockSdk; client: BedrockClient }> {
    const loaded = await bedrockRuntime();
    return this.client ? { sdk: loaded.sdk, client: this.client } : loaded;
  }

  private signal(request: ProviderRequest): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeoutMs && this.config.timeoutMs > 0 ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS);
    return request.abortSignal ? AbortSignal.any([request.abortSignal, timeout]) : timeout;
  }

  async createResponse(request: ProviderRequest): Promise<ProviderResponse> {
    const { sdk, client } = await this.runtime();
    const value = await client.send(new sdk.ConverseCommand(bedrockRequest(request, this.config)), { abortSignal: this.signal(request) });
    return result(this.config, request, value.output?.message?.content ?? [], value.stopReason, value.usage);
  }

  async *streamResponse(request: ProviderRequest): AsyncIterable<StreamEvent> {
    const { sdk, client } = await this.runtime();
    const value = await client.send(new sdk.ConverseStreamCommand(bedrockRequest(request, this.config)), { abortSignal: this.signal(request) });
    if (!value.stream) throw new Error("Bedrock returned no response stream");
    const blocks = new Map<number, { text?: string; tool?: { id: string; name: string; input: string }; thinking?: string; signature?: string; redacted?: Uint8Array }>();
    let stop: string | undefined;
    let usage: TokenUsage | undefined;
    for await (const event of value.stream) {
      // A fault inside the stream (throttling among them) fails the call; it is never a completed response.
      const error =
        event.internalServerException ??
        event.modelStreamErrorException ??
        event.validationException ??
        event.throttlingException ??
        event.serviceUnavailableException;
      if (error) throw Object.assign(new Error(error.message ?? "Bedrock stream failed"), { name: Object.keys(event)[0] });
      if (event.contentBlockStart) {
        const e = event.contentBlockStart;
        const tool = e.start?.toolUse;
        if (tool) {
          blocks.set(e.contentBlockIndex!, { tool: { id: tool.toolUseId!, name: tool.name!, input: "" } });
          yield { type: "tool_call_start", callId: tool.toolUseId!, toolType: "function", name: tool.name };
        }
      }
      if (event.contentBlockDelta) {
        const e = event.contentBlockDelta;
        const b = blocks.get(e.contentBlockIndex!) ?? {};
        blocks.set(e.contentBlockIndex!, b);
        if (e.delta?.text !== undefined) {
          b.text = (b.text ?? "") + e.delta.text;
          yield { type: "text_delta", delta: e.delta.text };
        }
        if (e.delta?.toolUse?.input !== undefined) {
          if (!b.tool) throw new Error("Bedrock tool delta without start");
          b.tool.input += e.delta.toolUse.input;
          yield { type: "tool_call_delta", callId: b.tool.id, delta: e.delta.toolUse.input };
        }
        if (e.delta?.reasoningContent?.text) {
          b.thinking = (b.thinking ?? "") + e.delta.reasoningContent.text;
          yield { type: "reasoning_delta", delta: e.delta.reasoningContent.text };
        }
        if (e.delta?.reasoningContent?.signature) b.signature = (b.signature ?? "") + e.delta.reasoningContent.signature;
        if (e.delta?.reasoningContent?.redactedContent) {
          b.redacted = Buffer.concat([b.redacted ?? Buffer.alloc(0), e.delta.reasoningContent.redactedContent]);
        }
      }
      if (event.contentBlockStop) {
        const b = blocks.get(event.contentBlockStop.contentBlockIndex!);
        if (b?.tool) yield { type: "tool_call_done", callId: b.tool.id };
      }
      if (event.messageStop) stop = event.messageStop.stopReason;
      if (event.metadata) usage = event.metadata.usage;
    }
    const content = [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, b]): AwsBlock[] =>
        b.tool
          ? [{ toolUse: { toolUseId: b.tool.id, name: b.tool.name, input: JSON.parse(b.tool.input) } }]
          : b.thinking !== undefined
            ? [{ reasoningContent: { reasoningText: { text: b.thinking, signature: b.signature } } }]
            : b.redacted
              ? [{ reasoningContent: { redactedContent: b.redacted } }]
              : [{ text: b.text ?? "" }],
      );
    yield { type: "done", response: result(this.config, request, content, stop, usage) };
  }
}

/** Factory function for the provider registry. */
export const createBedrockProvider = (config: ProviderConfig): Provider => new BedrockProvider(config);
