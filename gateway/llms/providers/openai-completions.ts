/**
 * AgentForEach Provider Layer — OpenAI Chat Completions Provider
 *
 * Implements the Provider interface using the OpenAI Chat Completions API.
 * This is the standard `/v1/chat/completions` endpoint that most OpenAI-
 * compatible providers support (Minimax, Together, Groq, Ollama, etc.).
 *
 * Supports:
 *   - Function calling (tool_calls)
 *   - Multi-turn conversations via message history
 *   - Streaming via server-sent events (ChatCompletionChunk)
 *   - Vision / image inputs
 *   - Reasoning effort pass-through
 *
 * Key differences from the Responses API provider:
 *   - Uses `client.chat.completions.create()` not `client.responses.create()`
 *   - No `previous_response_id` — full message history sent every request
 *   - No native shell / web_search tools — mapped to function tools
 *   - Conversation state carried via `messages` array (like Anthropic)
 *
 * Reference: https://platform.openai.com/docs/api-reference/chat/create
 */

import OpenAI from "openai";
import { transcriptThroughInput } from "../transcript.js";
import type {
  ConversationMessage,
  ContentBlock,
  FunctionCallOutput,
  FunctionCallOutputItem,
  MessageOutputItem,
  OpenAIProviderConfig,
  OutputItem,
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  ToolDefinition,
  UsageStats,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = "gpt-4o";
const PROVIDER_ID = "openai-completions" as const;

/**
 * Character budget for the accumulated conversation state.
 * Keeps tool-loop rounds + recent history within ~25K tokens.
 * Configurable via env var; defaults to 100 000 chars.
 */
const MAX_CONV_STATE_CHARS = Number.isFinite(
  Number.parseInt(process.env.LLM_MAX_CONV_STATE_CHARS ?? "", 10),
)
  ? Number.parseInt(process.env.LLM_MAX_CONV_STATE_CHARS!, 10)
  : 100_000;

/** Allowed MIME types for image data URIs (defense-in-depth). */
const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ============================================================================
// OpenAI Completions Provider
// ============================================================================

export class OpenAICompletionsProvider implements Provider {
  readonly id: string;
  // Chat Completions supports image_url but has no file-input part.
  readonly capabilities = { nativeDocuments: false };

  private client: OpenAI;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.id = config.providerId ?? PROVIDER_ID;
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      ...(config.organization && { organization: config.organization }),
      ...(config.project && { project: config.project }),
      ...(config.timeoutMs && { timeout: config.timeoutMs }),
    });
  }

  // --------------------------------------------------------------------------
  // createResponse — non-streaming
  // --------------------------------------------------------------------------

  async createResponse(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model ?? this.config.defaultModel;
    const params = this.buildRequestParams(request, model);

    const completion = await this.client.chat.completions.create(
      {
        ...params,
        stream: false,
      },
      // Pass abort signal so the HTTP request is cancelled on abort
      request.abortSignal ? { signal: request.abortSignal } : undefined,
    );

    return this.mapResponse(completion, model, request);
  }

  // --------------------------------------------------------------------------
  // streamResponse — SSE streaming
  // --------------------------------------------------------------------------

  async *streamResponse(request: ProviderRequest): AsyncIterable<StreamEvent> {
    const model = request.model ?? this.config.defaultModel;
    const params = this.buildRequestParams(request, model);

    const stream = await this.client.chat.completions.create(
      {
        ...params,
        stream: true,
        stream_options: { include_usage: true },
      },
      // Pass abort signal so the HTTP/SSE stream is terminated on abort
      request.abortSignal ? { signal: request.abortSignal } : undefined,
    );

    const textParts: string[] = [];
    // Accumulate tool calls from streaming deltas (keyed by tool call index)
    const toolCallAcc = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: string | null = null;
    let streamModel = model;
    let streamId = "";
    let streamUsage: OpenAI.CompletionUsage | undefined;

    try {
      for await (const chunk of stream) {
        streamId = chunk.id;
        streamModel = chunk.model ?? streamModel;
        if (chunk.usage) streamUsage = chunk.usage;

        const choice = chunk.choices[0];
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice?.delta;
        if (!delta) continue;

        // Text content delta
        if (delta.content) {
          textParts.push(delta.content);
          yield { type: "text_delta", delta: delta.content };
        }

        // Tool call deltas — accumulate across chunks
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;

            if (!toolCallAcc.has(idx)) {
              // First chunk for this tool call — emit start event.
              // Name is initialised empty; the accumulation below will set it.
              toolCallAcc.set(idx, {
                id: tc.id ?? "",
                name: "",
                arguments: "",
              });
              yield {
                type: "tool_call_start",
                callId: tc.id ?? "",
                toolType: "function",
                name: tc.function?.name,
              };
            }

            const acc = toolCallAcc.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) {
              acc.arguments += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                callId: acc.id,
                delta: tc.function.arguments,
              };
            }
          }
        }
      }

      // Emit tool_call_done for each accumulated tool call
      for (const [, tc] of toolCallAcc) {
        yield { type: "tool_call_done", callId: tc.id };
      }

      // Build final ProviderResponse and emit done
      const finalResponse = this.buildStreamFinalResponse(
        streamId,
        streamModel,
        textParts,
        toolCallAcc,
        finishReason,
        streamUsage,
        request,
      );
      yield { type: "done", response: finalResponse };
    } catch (err) {
      // When the request is aborted (user clicked stop), the SDK throws
      // APIUserAbortError / AbortError. This is expected — just return silently.
      if (
        err instanceof Error &&
        (err.name === "APIUserAbortError" || err.name === "AbortError")
      ) {
        console.log(`[openai-completions-provider] stream aborted by client`);
        return;
      }

      yield {
        type: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  // --------------------------------------------------------------------------
  // listModels
  // --------------------------------------------------------------------------

  async listModels(): Promise<string[]> {
    const models = await this.client.models.list();
    const ids: string[] = [];
    for await (const model of models) {
      ids.push(model.id);
    }
    return ids;
  }

  // --------------------------------------------------------------------------
  // Private: Build request parameters
  // --------------------------------------------------------------------------

  private buildRequestParams(
    request: ProviderRequest,
    model: string,
  ): OpenAI.ChatCompletionCreateParams {
    const params: OpenAI.ChatCompletionCreateParams = {
      model,
      messages: this.buildMessages(request),
    };

    // Tools
    if (request.tools?.length) {
      const mapped = this.mapTools(request.tools);
      if (mapped.length > 0) {
        params.tools = mapped;
      }
    }

    // Tool choice
    if (request.toolChoice) {
      params.tool_choice = this.mapToolChoice(request.toolChoice);
    }

    // Output limits
    if (request.maxOutputTokens !== undefined) {
      params.max_tokens = request.maxOutputTokens;
    }

    // Sampling
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
      params.top_p = request.topP;
    }

    // Reasoning effort — pass through for models that support it.
    // Models that don't will ignore it (standard SDK behavior).
    if (request.reasoning && request.reasoning.effort !== "none") {
      (params as unknown as Record<string, unknown>).reasoning_effort =
        request.reasoning.effort ?? "medium";
    }

    return params;
  }

  // --------------------------------------------------------------------------
  // Private: Build messages
  // --------------------------------------------------------------------------

  private buildMessages(
    request: ProviderRequest,
  ): OpenAI.ChatCompletionMessageParam[] {
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    // System prompt → system message
    if (request.instructions) {
      messages.push({ role: "system", content: request.instructions });
    }

    // ── Case 1: Simple string input ──
    if (typeof request.input === "string") {
      // Prepend conversation history if available
      if (request.conversation?.messages) {
        messages.push(...this.mapConversationMessages(request.conversation.messages));
      }

      messages.push({ role: "user", content: request.input });
      return messages;
    }

    // ── Case 2: FunctionCallOutput[] — tool results fed back ──
    if (
      request.input.length > 0 &&
      "type" in request.input[0] &&
      (request.input[0] as { type: string }).type === "function_call_output"
    ) {
      // Conversation history now contains the full prior context (user
      // messages, assistant messages with tool_calls, and prior tool results
      // stored as tool_result content blocks).  mapConversationMessages
      // expands tool_result blocks into { role: "tool" } messages.
      if (request.conversation?.messages) {
        messages.push(...this.mapConversationMessages(request.conversation.messages));
      }

      // Map FunctionCallOutput[] → tool result messages
      for (const item of request.input as FunctionCallOutput[]) {
        messages.push({
          role: "tool" as const,
          tool_call_id: item.callId,
          content: item.output,
        });
      }

      return messages;
    }

    // ── Case 3: ConversationMessage[] — history + current message ──
    //
    // The runner sends history oldest first, then the new message
    // ([...history, current]); keep that order, after any transcript from
    // earlier tool rounds.
    const inputMessages = request.input as ConversationMessage[];

    if (request.conversation?.messages) {
      messages.push(...this.mapConversationMessages(request.conversation.messages));
    }
    for (const msg of inputMessages) {
      messages.push(this.mapConversationMessage(msg));
    }

    return messages;
  }

  // --------------------------------------------------------------------------
  // Private: Map a single ConversationMessage → ChatCompletionMessageParam
  // --------------------------------------------------------------------------

  private mapConversationMessage(
    msg: ConversationMessage,
  ): OpenAI.ChatCompletionMessageParam {
    const role = msg.role as "user" | "assistant";

    // Simple string content
    if (typeof msg.content === "string") {
      if (role === "assistant") {
        return { role: "assistant", content: msg.content };
      }
      return { role: "user", content: msg.content };
    }

    // Rich content blocks
    if (role === "assistant") {
      return this.mapAssistantContentBlocks(msg.content);
    }

    // User role — map text + images to ChatCompletionContentPart[]
    const parts: OpenAI.ChatCompletionContentPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        parts.push({ type: "text", text: block.text });
      } else if (block.type === "document") {
        // The Chat Completions wire format has no file input at all. The
        // caller gates on `capabilities.nativeDocuments`, so reaching here
        // means a document slipped through — say so rather than dropping it,
        // which would leave the model answering about a document it never saw.
        parts.push({
          type: "text",
          text: `[Attachment "${block.fileName ?? "document"}" could not be read by this model.]`,
        });
      } else if (block.type === "image" && block.source) {
        const source = block.source;
        const safeMediaType = SAFE_IMAGE_MIME_TYPES.has(
          source.mediaType ?? "",
        )
          ? source.mediaType!
          : "image/jpeg";

        const imageUrl =
          source.type === "base64"
            ? `data:${safeMediaType};base64,${source.data}`
            : source.data;

        parts.push({
          type: "image_url",
          image_url: { url: imageUrl, detail: "auto" },
        });
      }
    }

    return { role: "user", content: parts.length > 0 ? parts : "" };
  }

  // --------------------------------------------------------------------------
  // Private: Map ConversationMessage[] → ChatCompletionMessageParam[]
  //
  // Unlike the singular mapConversationMessage, this handles expansion of
  // tool_result content blocks (stored during tool loops) into individual
  // { role: "tool" } messages that the Chat Completions API expects.
  // --------------------------------------------------------------------------

  private mapConversationMessages(
    msgs: ConversationMessage[],
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    for (const m of msgs) {
      // tool_result content blocks → expand to individual tool messages
      if (
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result")
      ) {
        for (const block of m.content) {
          if (block.type === "tool_result") {
            result.push({
              role: "tool" as const,
              tool_call_id: (block as { tool_use_id: string }).tool_use_id,
              content: (block as { content: string }).content,
            });
          }
        }
      } else {
        result.push(this.mapConversationMessage(m));
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // Private: Map assistant content blocks (text + tool_use)
  // --------------------------------------------------------------------------

  private mapAssistantContentBlocks(
    blocks: ContentBlock[],
  ): OpenAI.ChatCompletionAssistantMessageParam {
    const textParts: string[] = [];
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments:
              typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input ?? {}),
          },
        });
      }
    }

    const result: OpenAI.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: textParts.join("\n") || null,
    };

    if (toolCalls.length > 0) {
      result.tool_calls = toolCalls;
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Private: Map tools
  // --------------------------------------------------------------------------

  private mapTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    const mapped: OpenAI.ChatCompletionTool[] = [];

    for (const tool of tools) {
      switch (tool.type) {
        case "function":
          mapped.push({
            type: "function",
            function: {
              name: tool.name,
              ...(tool.description && { description: tool.description }),
              parameters: tool.parameters as
                | OpenAI.FunctionParameters
                | undefined,
              ...(tool.strict !== undefined && { strict: tool.strict }),
            },
          });
          break;

        case "shell":
        case "local_shell":
          // Chat Completions API doesn't have native shell tools.
          // Map to a function tool that the runner's executor will handle.
          mapped.push({
            type: "function",
            function: {
              name: "shell_execute",
              description:
                "Execute shell commands. Returns stdout, stderr, and exit code.",
              parameters: {
                type: "object",
                properties: {
                  commands: {
                    type: "array",
                    items: { type: "string" },
                    description: "Shell commands to execute sequentially.",
                  },
                },
                required: ["commands"],
              },
            },
          });
          break;

        case "web_search":
          // Chat Completions API doesn't have native web search.
          // Map to a function tool — skip if the runner doesn't have a
          // web search handler (it will just report "unknown tool").
          mapped.push({
            type: "function",
            function: {
              name: "web_search",
              description: "Search the web for up-to-date information.",
              parameters: {
                type: "object",
                properties: {
                  query: {
                    type: "string",
                    description: "The search query.",
                  },
                },
                required: ["query"],
              },
            },
          });
          break;

        default:
          // Unknown tool type — skip gracefully
          break;
      }
    }

    return mapped;
  }

  // --------------------------------------------------------------------------
  // Private: Map tool choice
  // --------------------------------------------------------------------------

  private mapToolChoice(
    choice: NonNullable<ProviderRequest["toolChoice"]>,
  ): OpenAI.ChatCompletionCreateParams["tool_choice"] {
    if (typeof choice === "string") {
      // "auto", "required", "none" map directly
      return choice as "auto" | "required" | "none";
    }
    return { type: "function", function: { name: choice.name } };
  }

  // --------------------------------------------------------------------------
  // Private: Map response (non-streaming)
  // --------------------------------------------------------------------------

  private mapResponse(
    completion: OpenAI.ChatCompletion,
    requestModel: string,
    request: ProviderRequest,
  ): ProviderResponse {
    const choice = completion.choices[0];
    const text = choice?.message?.content ?? "";
    const output = this.mapOutputItems(choice);

    return {
      providerId: this.id,
      responseId: completion.id,
      model: completion.model ?? requestModel,
      text,
      output,
      usage: this.mapUsage(completion.usage),
      conversationState: this.buildConversationState(choice, request),
      status: this.mapStatus(choice?.finish_reason),
      raw: completion,
    };
  }

  // --------------------------------------------------------------------------
  // Private: Map output items
  // --------------------------------------------------------------------------

  private mapOutputItems(
    choice: OpenAI.ChatCompletion.Choice | undefined,
  ): OutputItem[] {
    if (!choice) return [];
    const items: OutputItem[] = [];

    // Text message
    if (choice.message.content) {
      const mapped: MessageOutputItem = {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: choice.message.content }],
      };
      items.push(mapped);
    }

    // Tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const mapped: FunctionCallOutputItem = {
          type: "function_call",
          callId: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        };
        items.push(mapped);
      }
    }

    return items;
  }

  // --------------------------------------------------------------------------
  // Private: Build conversation state for multi-turn
  // --------------------------------------------------------------------------

  private buildConversationState(
    choice: OpenAI.ChatCompletion.Choice | undefined,
    request: ProviderRequest,
  ): { messages: ConversationMessage[] } {
    // Accumulate the FULL conversation so subsequent tool-loop rounds
    // retain context (user question, history, prior tool results, etc.).
    const captured = transcriptThroughInput(request);

    // 3. Add the assistant's response
    const hasToolCalls = !!choice?.message?.tool_calls?.length;
    let assistantContent: string | ContentBlock[];

    if (hasToolCalls) {
      const blocks: ContentBlock[] = [];
      if (choice!.message.content) {
        blocks.push({ type: "text", text: choice!.message.content });
      }
      for (const tc of choice!.message.tool_calls!) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeParseJson(tc.function.arguments),
        });
      }
      assistantContent = blocks;
    } else {
      assistantContent = choice?.message?.content ?? "";
    }

    captured.push({ role: "assistant", content: assistantContent });

    return { messages: this.boundMessages(captured) };
  }

  // --------------------------------------------------------------------------
  // Private: Build final response from accumulated stream data
  // --------------------------------------------------------------------------

  private buildStreamFinalResponse(
    responseId: string,
    model: string,
    textParts: string[],
    toolCalls: Map<number, { id: string; name: string; arguments: string }>,
    finishReason: string | null,
    usage: OpenAI.CompletionUsage | undefined,
    request: ProviderRequest,
  ): ProviderResponse {
    const text = textParts.join("");
    const output: OutputItem[] = [];

    if (text) {
      output.push({
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
      } satisfies MessageOutputItem);
    }

    // Reconstruct tool call output items from accumulated data
    const sortedToolCalls = [...toolCalls.entries()].sort(
      ([a], [b]) => a - b,
    );
    for (const [, tc] of sortedToolCalls) {
      output.push({
        type: "function_call",
        callId: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      } satisfies FunctionCallOutputItem);
    }

    // Build conversation state — accumulate full context (same logic as
    // buildConversationState) so tool-loop rounds retain prior context.
    const captured: ConversationMessage[] = [];

    if (request.conversation?.messages) {
      captured.push(...request.conversation.messages);
    }

    if (typeof request.input === "string") {
      captured.push({ role: "user", content: request.input });
    } else if (Array.isArray(request.input) && request.input.length > 0) {
      const first = request.input[0] as { type?: string };
      if (first.type === "function_call_output") {
        const toolResultBlocks: ContentBlock[] = (
          request.input as FunctionCallOutput[]
        ).map((item) => ({
          type: "tool_result" as const,
          tool_use_id: item.callId,
          content: item.output,
        }));
        captured.push({ role: "user", content: toolResultBlocks });
      } else {
        const msgs = request.input as ConversationMessage[];
        if (msgs.length > 1) {
          const [current, ...history] = msgs;
          captured.push(...history, current);
        } else {
          captured.push(...msgs);
        }
      }
    }

    const hasToolCallOutput = sortedToolCalls.length > 0;
    let assistantContent: string | ContentBlock[];

    if (hasToolCallOutput) {
      const blocks: ContentBlock[] = [];
      if (text) blocks.push({ type: "text", text });
      for (const [, tc] of sortedToolCalls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeParseJson(tc.arguments),
        });
      }
      assistantContent = blocks;
    } else {
      assistantContent = text;
    }

    captured.push({ role: "assistant", content: assistantContent });

    return {
      providerId: this.id,
      responseId,
      model,
      text,
      output,
      usage: this.mapUsage(usage),
      conversationState: { messages: this.boundMessages(captured) },
      status: this.mapStatus(finishReason),
    };
  }

  // --------------------------------------------------------------------------
  // Private: Bound conversation state to character budget
  //
  // Keeps the newest messages (trim from the front). Tool-loop messages at
  // the end are the most critical; older session history is nice-to-have.
  // --------------------------------------------------------------------------

  private boundMessages(
    messages: ConversationMessage[],
  ): ConversationMessage[] {
    if (messages.length === 0 || MAX_CONV_STATE_CHARS <= 0) return messages;

    // Measure from the end (newest = most important for tool-loop continuity)
    let usedChars = 0;
    let cutoff = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const cost = messageCharCost(messages[i]);
      if (usedChars + cost > MAX_CONV_STATE_CHARS) {
        cutoff = i + 1;
        break;
      }
      usedChars += cost;
    }

    return cutoff > 0 ? messages.slice(cutoff) : messages;
  }

  // --------------------------------------------------------------------------
  // Private: Map usage
  // --------------------------------------------------------------------------

  private mapUsage(
    usage: OpenAI.CompletionUsage | undefined,
  ): UsageStats | undefined {
    if (!usage) return undefined;

    return {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      cachedInputTokens:
        usage.prompt_tokens_details?.cached_tokens ?? undefined,
      reasoningTokens:
        usage.completion_tokens_details?.reasoning_tokens ?? undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Private: Map status
  // --------------------------------------------------------------------------

  private mapStatus(
    finishReason: string | null | undefined,
  ): ProviderResponse["status"] {
    switch (finishReason) {
      case "stop":
        return "completed";
      case "tool_calls":
        return "completed";
      case "length":
        return "incomplete";
      case "content_filter":
        return "failed";
      default:
        return "completed";
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Safely parse JSON; return the raw string on failure. */
function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/** Approximate character cost of a ConversationMessage (for budget trimming). */
function messageCharCost(msg: ConversationMessage): number {
  if (typeof msg.content === "string") return msg.content.length + 16;
  return (
    msg.content.reduce((sum, block) => {
      if (block.type === "text") return sum + block.text.length;
      if (block.type === "tool_result")
        return sum + (block as { content: string }).content.length;
      if (block.type === "tool_use")
        return sum + JSON.stringify((block as { input: unknown }).input ?? {}).length;
      if (block.type === "image") return sum + 1000; // rough estimate
      return sum;
    }, 0) + 16
  ); // 16 bytes overhead for role/framing
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an OpenAI Chat Completions provider instance.
 */
export function createOpenAICompletionsProvider(
  config: ProviderConfig,
): OpenAICompletionsProvider {
  return new OpenAICompletionsProvider(config as OpenAIProviderConfig);
}
