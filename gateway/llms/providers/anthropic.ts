/**
 * AgentForEach Provider Layer — Anthropic Claude Provider
 *
 * Implements the Provider interface using the Anthropic Messages API.
 * Supports:
 *   - Function calling (tool_use / tool_result)
 *   - Extended thinking
 *   - Streaming via server-sent events
 *   - Multi-turn conversations via message history
 *   - Vision (images in content blocks)
 *
 * Reference: https://platform.claude.com/docs/en/api/messages
 */

import Anthropic from "@anthropic-ai/sdk";
import { redactId } from "../../utils/redact.js";
import { transcriptThroughInput } from "../transcript.js";
import type {
  AnthropicProviderConfig,
  ConversationMessage,
  ContentBlock,
  FunctionCallOutput,
  FunctionCallOutputItem,
  ToolResultImage,
  MessageOutputItem,
  OutputItem,
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ReasoningOutputItem,
  StreamEvent,
  ToolDefinition,
  UsageStats,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_TOKENS = 4096;
const PROVIDER_ID = "anthropic" as const;

/** Allowed MIME types for image content blocks (defense-in-depth). */
const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ============================================================================
// Anthropic Provider
// ============================================================================

export class AnthropicProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly capabilities = { nativeDocuments: true };

  private client: Anthropic;
  private config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    this.config = config;
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      ...(config.timeoutMs && { timeout: config.timeoutMs }),
    });
  }

  // --------------------------------------------------------------------------
  // createResponse — non-streaming
  // --------------------------------------------------------------------------

  async createResponse(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model ?? this.config.defaultModel;
    const params = this.buildRequestParams(request, model);

    const message = await this.client.messages.create(
      {
        ...params,
        stream: false,
      },
      // Pass abort signal so the HTTP request is cancelled on abort
      request.abortSignal ? { signal: request.abortSignal } : undefined,
    );

    return this.mapResponse(message, model, request);
  }

  // --------------------------------------------------------------------------
  // streamResponse — SSE streaming
  // --------------------------------------------------------------------------

  async *streamResponse(request: ProviderRequest): AsyncIterable<StreamEvent> {
    const model = request.model ?? this.config.defaultModel;
    const params = this.buildRequestParams(request, model);

    const stream = this.client.messages.stream(
      params,
      // Pass abort signal so the HTTP/SSE stream is terminated on abort
      request.abortSignal ? { signal: request.abortSignal } : undefined,
    );

    try {
      for await (const event of stream) {
        const mapped = this.mapStreamEvent(event);
        if (mapped) {
          yield mapped;
        }
      }

      // Emit final response from accumulated message
      const finalMessage = await stream.finalMessage();
      yield { type: "done", response: this.mapResponse(finalMessage, model, request) };
    } catch (err) {
      // When the request is aborted (user clicked stop), the SDK throws
      // APIUserAbortError / AbortError. This is expected — just return silently.
      if (
        err instanceof Error &&
        (err.name === "APIUserAbortError" || err.name === "AbortError")
      ) {
        console.log(`[anthropic-provider] stream aborted by client`);
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
    // Anthropic doesn't have a list models endpoint in the SDK
    // Return the known model families
    return [
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-haiku-3-5-20241022",
    ];
  }

  // --------------------------------------------------------------------------
  // Private: Build request parameters
  // --------------------------------------------------------------------------

  private buildRequestParams(
    request: ProviderRequest,
    model: string,
  ): Anthropic.MessageCreateParams {
    const maxTokens =
      request.maxOutputTokens ??
      this.config.defaultMaxTokens ??
      DEFAULT_MAX_TOKENS;

    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: this.buildMessages(request),
    };

    // System prompt
    if (request.instructions) {
      params.system = request.instructions;
    }

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

    // Sampling params are deliberately NOT forwarded: current Claude models
    // (Sonnet 5, Opus 4.7+) reject temperature/top_p with a 400, and this
    // provider's role is the failover leg — a request tuned for the primary
    // provider must not hard-fail here over a parameter the model refuses.

    // Thinking: adaptive is the only on-mode on current Claude models —
    // budget_tokens is rejected with a 400. Depth is controlled by
    // output_config.effort instead of a token budget.
    if (request.reasoning) {
      const effort = this.resolveEffort(request.reasoning.effort);
      if (effort === null) {
        params.thinking = { type: "disabled" };
      } else {
        params.thinking = { type: "adaptive" };
        // The installed SDK's OutputConfig union lags the API ("xhigh" is
        // accepted by current models but missing from the type).
        params.output_config = {
          effort: effort as NonNullable<Anthropic.OutputConfig["effort"]>,
        };
      }
    }

    // Metadata
    // Pseudonymised: the provider stores it, and user ids can be phone numbers.
    if (request.metadata) {
      const userId = request.metadata.userId ?? request.metadata.user_id;
      params.metadata = { user_id: userId ? redactId(userId).slice(1) : undefined };
    }

    return params;
  }

  // --------------------------------------------------------------------------
  // Private: Build messages
  // --------------------------------------------------------------------------

  private buildMessages(request: ProviderRequest): Anthropic.MessageParam[] {
    if (typeof request.input === "string") {
      // Simple string input — wrap in a user message
      const messages: Anthropic.MessageParam[] = [];

      // Prepend conversation history if available
      if (request.conversation?.messages) {
        messages.push(
          ...request.conversation.messages.map((m) =>
            this.mapConversationMessage(m),
          ),
        );
      }

      messages.push({
        role: "user",
        content: request.input,
      });

      return this.mergeConsecutiveRoles(messages);
    }

    // Check if this is a function_call_output array (tool results feedback)
    if (
      request.input.length > 0 &&
      "type" in request.input[0] &&
      (request.input[0] as { type: string }).type === "function_call_output"
    ) {
      // Anthropic requires:
      //   1. The full assistant message (with tool_use blocks) — from conversation state
      //   2. A user message with tool_result blocks
      const messages: Anthropic.MessageParam[] = [];

      // Prepend conversation history (which includes the assistant's tool_use message)
      if (request.conversation?.messages) {
        messages.push(
          ...request.conversation.messages.map((m) =>
            this.mapConversationMessage(m),
          ),
        );
      }

      // Build tool_result content blocks from the function call outputs
      const toolResults = (request.input as FunctionCallOutput[]).map(
        (item) => ({
          type: "tool_result" as const,
          tool_use_id: item.callId,
          content: toolResultContent(item.output, item.images),
        }),
      );

      messages.push({
        role: "user",
        content: toolResults,
      });

      return this.mergeConsecutiveRoles(messages);
    }

    // Structured messages — map each one
    const messages: Anthropic.MessageParam[] = [];

    // Prepend conversation history if available
    if (request.conversation?.messages) {
      messages.push(
        ...request.conversation.messages.map((m) =>
          this.mapConversationMessage(m),
        ),
      );
    }

    messages.push(
      ...(request.input as ConversationMessage[]).map((m) =>
        this.mapConversationMessage(m),
      ),
    );

    return this.mergeConsecutiveRoles(messages);
  }

  private mapConversationMessage(
    msg: ConversationMessage,
  ): Anthropic.MessageParam {
    if (typeof msg.content === "string") {
      return { role: msg.role, content: msg.content };
    }

    // Map rich content blocks
    return {
      role: msg.role,
      content: msg.content.map((block) => this.mapContentBlock(block)),
    };
  }

  /**
   * Merge consecutive same-role messages into one.
   *
   * The Anthropic Messages API strictly requires alternating user/assistant
   * roles. After HITL resume, the session may contain consecutive assistant
   * messages (tool result + LLM continuation). This merging ensures the
   * API receives a valid message array.
   *
   * Only merges when both messages have plain string content — rich content
   * blocks (tool_use, tool_result, images) are left as-is.
   */
  private mergeConsecutiveRoles(
    messages: Anthropic.MessageParam[],
  ): Anthropic.MessageParam[] {
    const merged: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (
        last &&
        last.role === msg.role &&
        typeof last.content === "string" &&
        typeof msg.content === "string"
      ) {
        last.content = `${last.content}\n\n${msg.content}`;
      } else {
        merged.push({ ...msg });
      }
    }
    return merged;
  }

  private mapContentBlock(block: ContentBlock): Anthropic.ContentBlockParam {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };

      case "image": {
        // Defense-in-depth: only allow known image MIME types
        const safeMediaType = (
          SAFE_IMAGE_MIME_TYPES.has(block.source.mediaType ?? "")
            ? block.source.mediaType!
            : "image/jpeg"
        ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

        return {
          type: "image",
          source:
            block.source.type === "base64"
              ? {
                  type: "base64",
                  media_type: safeMediaType,
                  data: block.source.data,
                }
              : {
                  type: "url",
                  url: block.source.data,
                },
        };
      }

      case "document":
        // Claude renders each page and reads text alongside it, so layout —
        // merged table headers, stamps, marginal notes — survives.
        return {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: block.source.data,
          },
          ...(block.fileName ? { title: block.fileName } : {}),
        };

      case "tool_use":
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };

      case "tool_result":
        return {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: toolResultContent(block.content, block.images),
        };

      case "thinking":
        return { type: "thinking", thinking: block.thinking, signature: block.signature };

      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };

      default:
        return { type: "text", text: "" };
    }
  }

  // --------------------------------------------------------------------------
  // Private: Map tools
  // --------------------------------------------------------------------------

  private mapTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    const mapped: Anthropic.Tool[] = [];

    for (const tool of tools) {
      switch (tool.type) {
        case "function":
          mapped.push({
            name: tool.name,
            ...(tool.description && { description: tool.description }),
            input_schema: tool.parameters as Anthropic.Tool.InputSchema,
          });
          break;

        case "web_search":
          // Anthropic has its own web search tool
          // Use the server-side web search tool
          // Skip for now — can be added as a server tool
          break;

        case "shell":
        case "local_shell":
          // Anthropic doesn't have a native shell tool
          // Map to a function tool that the executor will handle
          mapped.push({
            name: "shell_execute",
            description:
              "Execute shell commands. Returns stdout, stderr, and exit code.",
            input_schema: {
              type: "object" as const,
              properties: {
                commands: {
                  type: "array",
                  items: { type: "string" },
                  description: "Shell commands to execute sequentially.",
                },
              },
              required: ["commands"],
            },
          });
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
  ): Anthropic.MessageCreateParams["tool_choice"] {
    if (typeof choice === "string") {
      switch (choice) {
        case "auto":
          return { type: "auto" };
        case "required":
          return { type: "any" };
        case "none":
          return { type: "none" };
        default:
          return { type: "auto" };
      }
    }
    return { type: "tool", name: choice.name };
  }

  // --------------------------------------------------------------------------
  // Private: Map response
  // --------------------------------------------------------------------------

  private mapResponse(
    message: Anthropic.Message,
    requestModel: string,
    request: ProviderRequest,
  ): ProviderResponse {
    const output = this.mapOutputItems(message.content);
    const text = this.extractText(message);

    // Build conversation state with message history for multi-turn.
    // IMPORTANT: Preserve tool_use blocks in the assistant message so that
    // if the runner feeds back function_call_output items, the Anthropic API
    // sees the full assistant message (with tool_use) preceding the tool_result.
    const hasToolUse = message.content.some((b) => b.type === "tool_use");

    const assistantContent: ContentBlock[] = message.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input as unknown,
        };
      }
      // Thinking blocks go back verbatim (with their signature): with
      // thinking on, the API rejects a tool_use turn whose thinking changed.
      if (block.type === "thinking") {
        return { type: "thinking" as const, thinking: block.thinking, signature: block.signature };
      }
      if (block.type === "redacted_thinking") {
        return { type: "redacted_thinking" as const, data: block.data };
      }
      return { type: "text" as const, text: "" };
    });

    const assistantMessage: ConversationMessage = {
      role: "assistant",
      content: hasToolUse ? assistantContent : text,
    };

    return {
      providerId: PROVIDER_ID,
      responseId: message.id,
      model: message.model ?? requestModel,
      text,
      output,
      usage: this.mapUsage(message.usage),
      // The whole transcript, not just this reply: the next tool round only
      // adds tool results, and Claude needs the question and history too.
      conversationState: {
        messages: [...transcriptThroughInput(request), assistantMessage],
      },
      status: this.mapStatus(message.stop_reason),
      raw: message,
    };
  }

  // --------------------------------------------------------------------------
  // Private: Map output items
  // --------------------------------------------------------------------------

  private mapOutputItems(content: Anthropic.ContentBlock[]): OutputItem[] {
    const items: OutputItem[] = [];

    for (const block of content) {
      switch (block.type) {
        case "text": {
          const mapped: MessageOutputItem = {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: block.text }],
          };
          items.push(mapped);
          break;
        }

        case "tool_use": {
          const mapped: FunctionCallOutputItem = {
            type: "function_call",
            callId: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          };
          items.push(mapped);
          break;
        }

        case "thinking": {
          const thinkBlock = block as unknown as {
            type: "thinking";
            thinking: string;
          };
          const mapped: ReasoningOutputItem = {
            type: "reasoning",
            text: thinkBlock.thinking,
          };
          items.push(mapped);
          break;
        }

        default:
          // Skip unknown block types
          break;
      }
    }

    return items;
  }

  // --------------------------------------------------------------------------
  // Private: Extract text
  // --------------------------------------------------------------------------

  private extractText(message: Anthropic.Message): string {
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        texts.push(block.text);
      }
    }
    return texts.join("\n");
  }

  // --------------------------------------------------------------------------
  // Private: Map usage
  // --------------------------------------------------------------------------

  private mapUsage(usage: Anthropic.Usage): UsageStats {
    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
      cachedInputTokens: usage.cache_read_input_tokens ?? undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Private: Map status
  // --------------------------------------------------------------------------

  private mapStatus(
    stopReason: Anthropic.Message["stop_reason"],
  ): ProviderResponse["status"] {
    switch (stopReason) {
      case "end_turn":
      case "stop_sequence":
        return "completed";
      case "max_tokens":
        return "incomplete";
      case "tool_use":
        return "completed";
      default:
        return "completed";
    }
  }

  // --------------------------------------------------------------------------
  // Private: Map stream events
  // --------------------------------------------------------------------------

  private mapStreamEvent(
    event: Anthropic.MessageStreamEvent,
  ): StreamEvent | null {
    switch (event.type) {
      case "content_block_delta": {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          return { type: "text_delta", delta: delta.text };
        }
        if (delta.type === "input_json_delta") {
          return {
            type: "tool_call_delta",
            callId: "",
            delta: delta.partial_json,
          };
        }
        if (delta.type === "thinking_delta") {
          return {
            type: "reasoning_delta",
            delta: (delta as unknown as { thinking: string }).thinking,
          };
        }
        return null;
      }

      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "tool_use") {
          return {
            type: "tool_call_start",
            callId: block.id,
            toolType: "function",
            name: block.name,
          };
        }
        return null;
      }

      case "content_block_stop": {
        // Signal tool call done. The index corresponds to the content block,
        // but we don't have the callId. Use the index as a placeholder —
        // the runner matches by position, not by callId for done events.
        return {
          type: "tool_call_done" as const,
          callId: String(event.index),
        };
      }

      default:
        return null;
    }
  }

  // --------------------------------------------------------------------------
  // Private: Resolve effort level
  // --------------------------------------------------------------------------

  /**
   * Map AgentForEach's effort vocabulary (OpenAI-shaped: none|minimal|low|medium|
   * high|xhigh) onto Anthropic's output_config.effort levels. Returns null
   * for "none", meaning thinking should be disabled rather than run at an
   * effort level. Replaces the former budget_tokens mapping, which current
   * Claude models reject.
   */
  private resolveEffort(effort: string | undefined): string | null {
    switch (effort) {
      case "none":
        return null;
      case "minimal":
      case "low":
        return "low";
      case "medium":
        return "medium";
      case "high":
        return "high";
      case "xhigh":
        return "xhigh";
      default:
        return "medium";
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an Anthropic Claude provider instance.
 */
export function createAnthropicProvider(
  config: ProviderConfig,
): AnthropicProvider {
  return new AnthropicProvider(config as AnthropicProviderConfig);
}

/** A tool result's text, plus its images as image blocks (Anthropic accepts both inside tool_result). */
function toolResultContent(
  text: string,
  images: ToolResultImage[] | undefined,
): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  if (!images?.length) return text;
  return [
    { type: "text", text },
    ...images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mediaType, data: img.data },
    })),
  ];
}
