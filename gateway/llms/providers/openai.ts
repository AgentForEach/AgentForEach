/**
 * AgentForEach Provider Layer — OpenAI Provider
 *
 * Implements the Provider interface using the OpenAI Responses API.
 * Supports:
 *   - Shell tool with hosted containers (container_auto / container_reference)
 *   - Local shell execution
 *   - Function calling
 *   - Web search
 *   - Multi-turn conversations via previous_response_id
 *   - Streaming via server-sent events
 *   - Reasoning (o-series models)
 *
 * Reference: https://developers.openai.com/api/docs/guides/tools-shell
 */

import OpenAI from "openai";
import { redactId } from "../../utils/redact.js";
import type {
  ConversationState,
  FunctionCallOutput,
  FunctionCallOutputItem,
  LocalShellToolDefinition,
  MessageOutputItem,
  OpenAIProviderConfig,
  OutputItem,
  Provider,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ReasoningOutputItem,
  ShellCallOutputItem,
  ShellCallResultItem,
  ShellEnvironment,
  StreamEvent,
  ToolDefinition,
  UsageStats,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = "gpt-5.2";
const PROVIDER_ID = "openai" as const;

/** Allowed MIME types for image data URIs (defense-in-depth). */
const SAFE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ============================================================================
// OpenAI Provider
// ============================================================================

/**
 * OpenAI reasoning models (gpt-5*, o1/o3/o4) reject non-default temperature
 * and top_p; sending them fails the whole request (compaction's 0.3 did,
 * silently, on every attempt).
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)/i.test(model.trim());
}

export class OpenAIProvider implements Provider {
  readonly id = PROVIDER_ID;
  // PDF only — Azure OpenAI documents no support for DOCX/XLSX as input_file.
  readonly capabilities = { nativeDocuments: true };

  private client: OpenAI;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    this.config = config;
    console.log(
      `[openai-provider] init: baseUrl=${config.baseUrl ?? "(default)"}, ` +
        `model=${config.defaultModel ?? "(none)"}, org=${config.organization ?? "(none)"}, ` +
        `project=${config.project ?? "(none)"}, timeout=${config.timeoutMs ?? "(default)"}`,
    );
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

    // ── Diagnostic: trace exactly what reaches the OpenAI API ──
    console.log(
      `[openai-provider] createResponse: model=${params.model}, ` +
        `hasInstructions=${!!params.instructions}, ` +
        `instructionsLen=${params.instructions?.length ?? 0}, ` +
        `inputType=${typeof params.input}, ` +
        `inputLen=${typeof params.input === "string" ? params.input.length : Array.isArray(params.input) ? params.input.length : "?"}`,
    );

    const response = await this.client.responses.create(
      {
        ...params,
        stream: false,
      },
      // Pass abort signal so the HTTP request is cancelled on abort
      request.abortSignal ? { signal: request.abortSignal } : undefined,
    );

    return this.mapResponse(response, model);
  }

  // --------------------------------------------------------------------------
  // streamResponse — SSE streaming
  // --------------------------------------------------------------------------

  async *streamResponse(request: ProviderRequest): AsyncIterable<StreamEvent> {
    const model = request.model ?? this.config.defaultModel;
    const params = this.buildRequestParams(request, model);

    console.log(
      `[openai-provider] streamResponse: model=${params.model}, ` +
        `baseUrl=${this.config.baseUrl ?? "(default)"}, ` +
        `hasInstructions=${!!params.instructions}, ` +
        `inputLen=${typeof params.input === "string" ? params.input.length : Array.isArray(params.input) ? params.input.length : "?"}`,
    );

    const stream = await this.client.responses.create(
      {
        ...params,
        stream: true,
      },
      // Pass abort signal so the HTTP/SSE stream is terminated on abort
      request.abortSignal ? { signal: request.abortSignal } : undefined,
    );

    // Accumulate the final response from stream events
    const textParts: string[] = [];
    const outputItems: OutputItem[] = [];
    let responseId = "";
    let finalModel = model;

    try {
      for await (const event of stream) {
        const mapped = this.mapStreamEvent(event, textParts);
        if (mapped) {
          yield mapped;
        }

        // Capture the final response when the stream completes
        if (event.type === "response.completed" && "response" in event) {
          const completed = event.response as OpenAI.Responses.Response;
          responseId = completed.id;
          finalModel = completed.model;

          const finalResponse = this.mapResponse(completed, finalModel);
          yield { type: "done", response: finalResponse };
        }

        // Handle incomplete responses (max tokens, content filter, etc.)
        if (event.type === "response.incomplete" && "response" in event) {
          const incomplete = event.response as OpenAI.Responses.Response;
          finalModel = incomplete.model ?? finalModel;

          const incompleteResponse = this.mapResponse(incomplete, finalModel);
          yield { type: "done", response: incompleteResponse };
        }

        // Handle failed responses
        if (event.type === "response.failed" && "response" in event) {
          const failed = event.response as OpenAI.Responses.Response;
          const errorMsg =
            failed.error?.message ?? "Response generation failed";
          console.error(
            `[openai-provider] response.failed: model=${model}, ` +
              `code=${failed.error?.code ?? "unknown"}, message=${errorMsg}`,
          );
          yield {
            type: "error",
            error: new Error(errorMsg),
          };
        }
      }
    } catch (err) {
      // When the request is aborted (user clicked stop), the SDK throws
      // APIUserAbortError. This is expected — just return silently.
      if (
        err instanceof Error &&
        (err.name === "APIUserAbortError" || err.name === "AbortError")
      ) {
        console.log(`[openai-provider] stream aborted by client — model=${model}`);
        return;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      const statusCode = (err as any)?.status ?? (err as any)?.statusCode ?? "n/a";
      console.error(
        `[openai-provider] stream error: model=${model}, status=${statusCode}, ` +
          `error=${errMsg}`,
        err,
      );
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
  ): OpenAI.Responses.ResponseCreateParams {
    const params: OpenAI.Responses.ResponseCreateParams = {
      model,
      input: this.buildInput(request),
    };

    // Instructions (system prompt)
    if (request.instructions) {
      params.instructions = request.instructions;
    }

    // Metadata (debug/observability). Stored with the response by the
    // provider, so user and session ids go out pseudonymised.
    if (request.metadata) {
      const metadata = { ...request.metadata };
      if (metadata.userId) metadata.userId = redactId(metadata.userId);
      if (metadata.sessionId) metadata.sessionId = redactId(metadata.sessionId);
      (params as unknown as { metadata?: Record<string, string> }).metadata = metadata;
    }

    // Keep one user's requests on the same prompt-cache servers. Every
    // user's prompt starts the same (tools, static instructions), so without
    // a key the provider spreads that prefix over many cold caches under
    // load. Pseudonymised: the provider never sees the user id.
    const cacheUser = request.metadata?.userId;
    if (cacheUser) {
      (params as unknown as { prompt_cache_key?: string }).prompt_cache_key = redactId(cacheUser).slice(1);
    }

    // Tools
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => this.mapTool(t));
    }

    // Tool choice
    if (request.toolChoice) {
      params.tool_choice = this.mapToolChoice(request.toolChoice);
    }

    // Multi-turn via previous_response_id
    if (request.conversation?.previousResponseId) {
      params.previous_response_id = request.conversation.previousResponseId;
    }

    // Store flag (Responses API) — controls 30-day server-side retention
    // for previous_response_id chaining.
    if (this.config.responses?.store !== undefined) {
      params.store = this.config.responses.store;
    }

    // Context-window controls (Responses API)
    if (this.config.responses?.truncation) {
      (
        params as unknown as {
          truncation?: "auto" | "disabled";
        }
      ).truncation = this.config.responses.truncation;
    }

    const compactThreshold = this.config.responses?.contextManagement?.compactThreshold;
    if (
      this.config.responses?.contextManagement?.enabled &&
      Number.isFinite(compactThreshold) &&
      compactThreshold !== undefined &&
      compactThreshold > 0
    ) {
      (
        params as unknown as {
          context_management?: Array<{ type: string; compact_threshold: number }>;
        }
      ).context_management = [
        {
          type: "compaction",
          compact_threshold: compactThreshold,
        },
      ];
    }

    // Output limits
    if (request.maxOutputTokens !== undefined) {
      params.max_output_tokens = request.maxOutputTokens;
    }
    if (request.maxToolCalls !== undefined) {
      // max_tool_calls is supported by the API but may not be in SDK types yet
      (params as unknown as Record<string, unknown>).max_tool_calls =
        request.maxToolCalls;
    }

    // Sampling (reasoning models reject anything but the defaults)
    if (!isOpenAIReasoningModel(params.model ?? request.model ?? "")) {
      if (request.temperature !== undefined) {
        params.temperature = request.temperature;
      }
      if (request.topP !== undefined) {
        params.top_p = request.topP;
      }
    }

    // Reasoning (o-series / gpt-5)
    if (request.reasoning && request.reasoning.effort !== "none") {
      const effort = request.reasoning.effort ?? "medium";
      const summaryMode =
        request.reasoning.summary ??
        (request.reasoning.generateSummary ? "auto" : undefined);
      // The API supports: minimal, low, medium, high, xhigh.
      // Filter out "none" (handled above) and cast to the SDK's type.
      params.reasoning = {
        effort: effort as "low" | "medium" | "high",
        ...(summaryMode !== undefined && {
          summary: summaryMode,
        }),
      };
    }

    return params;
  }

  // --------------------------------------------------------------------------
  // Private: Build input
  // --------------------------------------------------------------------------

  private buildInput(
    request: ProviderRequest,
  ): string | OpenAI.Responses.ResponseInputItem[] {
    if (typeof request.input === "string") {
      return request.input;
    }

    // Check if this is a function_call_output array (tool results feedback)
    if (
      request.input.length > 0 &&
      "type" in request.input[0] &&
      (request.input[0] as { type: string }).type === "function_call_output"
    ) {
      // Map FunctionCallOutput[] to OpenAI ResponseInputItem[]
      // OpenAI expects: { type: "function_call_output", call_id: "...", output: "..." }
      // A tool that returned images (a browser screenshot) sends them in the output list,
      // which the Responses API accepts beside text.
      return (request.input as FunctionCallOutput[]).map(
        (item) =>
          ({
            type: "function_call_output",
            call_id: item.callId,
            output: item.images?.length
              ? [
                  { type: "input_text", text: item.output },
                  ...item.images.map((img) => ({
                    type: "input_image",
                    image_url: `data:${SAFE_IMAGE_MIME_TYPES.has(img.mediaType) ? img.mediaType : "image/jpeg"};base64,${img.data}`,
                    detail: "auto",
                  })),
                ]
              : item.output,
          }) as unknown as OpenAI.Responses.ResponseInputItem,
      );
    }

    // Map ConversationMessage[] to OpenAI ResponseInputItem[]
    return (
      request.input as Array<{
        role: string;
        content:
          | string
          | Array<{
              type: string;
              text?: string;
              fileName?: string;
              source?: { type: string; mediaType?: string; data: string };
            }>;
      }>
    ).map((msg) => {
      const role = msg.role as "user" | "assistant";
      const textType = role === "assistant" ? "output_text" : "input_text";

      if (typeof msg.content === "string") {
        return {
          type: "message" as const,
          role,
          content: [
            { type: textType, text: msg.content },
          ] as OpenAI.Responses.ResponseInputMessageContentList,
        };
      }

      // Replay history with role-correct content types + image support:
      // - user text      -> input_text
      // - assistant text -> output_text
      // - user image     -> input_image (base64 data URI or URL)
      const parts: Array<
        | { type: "input_text" | "output_text"; text: string }
        | { type: "input_image"; image_url: string; detail?: string }
        | { type: "input_file"; filename?: string; file_data: string }
      > = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push({ type: textType, text: block.text });
        } else if (block.type === "document" && block.source) {
          // Sent inline rather than via the Files API on purpose: a file_id
          // belongs to one provider, and failover can move this turn to
          // another mid-flight.
          parts.push({
            type: "input_file",
            ...(block.fileName ? { filename: block.fileName } : {}),
            file_data: `data:application/pdf;base64,${block.source.data}`,
          });
        } else if (block.type === "image" && block.source) {
          const source = block.source;
          // Defense-in-depth: only allow known image MIME types in data URIs
          const safeMediaType = SAFE_IMAGE_MIME_TYPES.has(source.mediaType ?? "")
            ? source.mediaType!
            : "image/jpeg";
          if (source.type === "base64") {
            parts.push({
              type: "input_image",
              image_url: `data:${safeMediaType};base64,${source.data}`,
              detail: "auto",
            });
          } else if (source.type === "url") {
            parts.push({
              type: "input_image",
              image_url: source.data,
              detail: "auto",
            });
          }
        }
      }
      return {
        type: "message" as const,
        role,
        content: parts as OpenAI.Responses.ResponseInputMessageContentList,
      };
    });
  }

  // --------------------------------------------------------------------------
  // Private: Map tools
  // --------------------------------------------------------------------------

  private mapTool(tool: ToolDefinition): OpenAI.Responses.Tool {
    switch (tool.type) {
      case "shell":
        // Shell tool is supported by the API; cast through unknown
        // because the SDK types may not include it yet.
        return {
          type: "shell",
          environment: this.mapShellEnvironment(tool.environment),
        } as unknown as OpenAI.Responses.Tool;

      case "local_shell":
        // Local shell — separate tool type for local execution.
        return {
          type: "local_shell",
        } as unknown as OpenAI.Responses.Tool;

      case "function":
        return {
          type: "function",
          name: tool.name,
          ...(tool.description && { description: tool.description }),
          parameters: tool.parameters,
          ...(tool.strict !== undefined && { strict: tool.strict }),
        } as OpenAI.Responses.Tool;

      case "web_search":
        // Use the latest web_search type; fall back to preview for older models
        return {
          type: "web_search_preview",
        } as OpenAI.Responses.Tool;

      default:
        throw new Error(
          `Unsupported tool type: ${(tool as ToolDefinition).type}`,
        );
    }
  }

  private mapShellEnvironment(env: ShellEnvironment): Record<string, unknown> {
    switch (env.type) {
      case "container_auto":
        return {
          type: "container_auto",
          ...(env.fileIds?.length && { file_ids: env.fileIds }),
          ...(env.memoryLimit && { memory_limit: env.memoryLimit }),
          ...(env.networkPolicy && {
            network_access: this.mapNetworkPolicy(env.networkPolicy),
          }),
          ...(env.skills?.length && {
            skills: env.skills.map((s) => {
              if (s.type === "skill_reference") {
                return {
                  type: "skill_reference",
                  id: s.id,
                  ...(s.version !== undefined && { version: s.version }),
                };
              }
              return {
                type: "inline",
                name: s.name,
                description: s.description,
                source: s.source,
              };
            }),
          }),
        };

      case "container_reference":
        return {
          type: "container_reference",
          container_id: env.containerId,
          ...(env.networkPolicy && {
            network_access: this.mapNetworkPolicy(env.networkPolicy),
          }),
        };

      case "local":
        return {
          type: "local",
          ...(env.skills?.length && {
            skills: env.skills.map((s) => ({
              name: s.name,
              description: s.description,
              path: s.path,
            })),
          }),
        };
    }
  }

  private mapNetworkPolicy(
    policy: NonNullable<
      Extract<ShellEnvironment, { type: "container_auto" }>["networkPolicy"]
    >,
  ): Record<string, unknown> {
    if (policy.type === "disabled") {
      return { type: "disabled" };
    }
    return {
      type: "allowlist",
      allowed_domains: policy.allowedDomains,
      ...(policy.domainSecrets && {
        domain_secrets: policy.domainSecrets.map((s) => ({
          domain: s.domain,
          name: s.name,
          value: s.value,
        })),
      }),
    };
  }

  // --------------------------------------------------------------------------
  // Private: Map tool choice
  // --------------------------------------------------------------------------

  private mapToolChoice(
    choice: NonNullable<ProviderRequest["toolChoice"]>,
  ): OpenAI.Responses.ResponseCreateParams["tool_choice"] {
    if (typeof choice === "string") {
      return choice;
    }
    return { type: "function", name: choice.name };
  }

  // --------------------------------------------------------------------------
  // Private: Map response
  // --------------------------------------------------------------------------

  private mapResponse(
    response: OpenAI.Responses.Response,
    requestModel: string,
  ): ProviderResponse {
    const output = this.mapOutputItems(response.output);
    const text = this.extractText(response);

    return {
      providerId: PROVIDER_ID,
      responseId: response.id,
      model: response.model ?? requestModel,
      text,
      output,
      usage: this.mapUsage(response.usage),
      conversationState: this.buildConversationState(response),
      status: this.mapStatus(response.status),
      ...(response.error && {
        error: {
          code: response.error.code ?? "unknown",
          message: response.error.message ?? "Unknown error",
        },
      }),
      raw: response,
    };
  }

  // --------------------------------------------------------------------------
  // Private: Map output items
  // --------------------------------------------------------------------------

  private mapOutputItems(
    output: OpenAI.Responses.ResponseOutputItem[],
  ): OutputItem[] {
    const items: OutputItem[] = [];

    // Cast to any[] to handle shell_call / shell_call_output types
    // that exist in the API but may not be in SDK types yet.
    for (const item of output as unknown as Array<Record<string, unknown>>) {
      const itemType = item.type as string;
      switch (itemType) {
        case "message": {
          const msgContent =
            (item.content as Array<{ type: string; text: string }>) ?? [];
          const mapped: MessageOutputItem = {
            type: "message",
            role: "assistant",
            content: msgContent
              .filter((c) => c.type === "output_text")
              .map((c) => ({ type: "text" as const, text: c.text })),
          };
          items.push(mapped);
          break;
        }

        case "shell_call": {
          const shellItem = item as {
            type: "shell_call";
            call_id: string;
            call: {
              commands: string[];
              timeout_ms?: number;
              max_output_chars?: number;
            };
            status: string;
          };
          const mapped: ShellCallOutputItem = {
            type: "shell_call",
            callId: shellItem.call_id,
            commands: shellItem.call?.commands ?? [],
            timeoutMs: shellItem.call?.timeout_ms,
            maxOutputChars: shellItem.call?.max_output_chars,
            status:
              shellItem.status === "completed" ? "completed" : "in_progress",
          };
          items.push(mapped);
          break;
        }

        case "shell_call_output": {
          const shellResult = item as {
            type: "shell_call_output";
            call_id: string;
            output: Array<{
              stdout: string;
              stderr: string;
              outcome:
                | { type: "exit"; exit_code: number }
                | { type: "timeout" };
            }>;
          };
          const mapped: ShellCallResultItem = {
            type: "shell_call_output",
            callId: shellResult.call_id,
            output: shellResult.output.map((o) => ({
              stdout: o.stdout,
              stderr: o.stderr,
              outcome:
                o.outcome.type === "exit"
                  ? {
                      type: "exit" as const,
                      exitCode: (o.outcome as { exit_code: number }).exit_code,
                    }
                  : { type: "timeout" as const },
            })),
            maxOutputChars: (item as { max_output_chars?: number })
              .max_output_chars,
          };
          items.push(mapped);
          break;
        }

        case "function_call": {
          const fnItem = item as {
            type: "function_call";
            call_id: string;
            name: string;
            arguments: string;
          };
          const mapped: FunctionCallOutputItem = {
            type: "function_call",
            callId: fnItem.call_id,
            name: fnItem.name,
            arguments: fnItem.arguments,
          };
          items.push(mapped);
          break;
        }

        case "reasoning": {
          const reasoningItem = item as {
            type: "reasoning";
            text?: string;
            summary?: Array<{ text: string }>;
          };
          const mapped: ReasoningOutputItem = {
            type: "reasoning",
            text: reasoningItem.text,
            summary: reasoningItem.summary?.map((s) => s.text).join("\n"),
          };
          items.push(mapped);
          break;
        }

        default:
          // Unknown output type — skip gracefully
          break;
      }
    }

    return items;
  }

  // --------------------------------------------------------------------------
  // Private: Extract text convenience
  // --------------------------------------------------------------------------

  private extractText(response: OpenAI.Responses.Response): string {
    // The Responses API exposes output_text as a convenience accessor
    const anyResponse = response as unknown as Record<string, unknown>;
    if (typeof anyResponse.output_text === "string") {
      return anyResponse.output_text;
    }

    // Fallback: collect text from message output items
    const texts: string[] = [];
    for (const item of response.output) {
      if (item.type === "message") {
        for (const content of item.content) {
          if (content.type === "output_text") {
            texts.push(content.text);
          }
        }
      }
    }
    return texts.join("\n");
  }

  // --------------------------------------------------------------------------
  // Private: Map usage
  // --------------------------------------------------------------------------

  private mapUsage(
    usage: OpenAI.Responses.Response["usage"],
  ): UsageStats | undefined {
    if (!usage) return undefined;

    return {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      totalTokens: usage.total_tokens,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
    };
  }

  // --------------------------------------------------------------------------
  // Private: Build conversation state for multi-turn
  // --------------------------------------------------------------------------

  private buildConversationState(
    response: OpenAI.Responses.Response,
  ): ConversationState {
    const state: ConversationState = {
      previousResponseId: response.id,
    };

    // Extract container ID from shell_call items for persistent containers
    for (const item of response.output as unknown as Array<
      Record<string, unknown>
    >) {
      if (item.type === "shell_call") {
        // The container_id is available on the response when using container_auto
        // It gets promoted to the response level as well
        const anyResponse = response as unknown as Record<string, unknown>;
        if (typeof anyResponse.container_id === "string") {
          state.containerId = anyResponse.container_id;
        }
        break;
      }
    }

    return state;
  }

  // --------------------------------------------------------------------------
  // Private: Map status
  // --------------------------------------------------------------------------

  private mapStatus(
    status: OpenAI.Responses.Response["status"],
  ): ProviderResponse["status"] {
    switch (status) {
      case "completed":
        return "completed";
      case "failed":
        return "failed";
      case "incomplete":
        return "incomplete";
      default:
        return "completed";
    }
  }

  // --------------------------------------------------------------------------
  // Private: Map stream events
  // --------------------------------------------------------------------------

  private mapStreamEvent(
    event: OpenAI.Responses.ResponseStreamEvent,
    textParts: string[],
  ): StreamEvent | null {
    // Cast once — several event types are newer than the SDK's TS defs.
    const raw = event as unknown as Record<string, unknown>;
    const eventType = event.type as string;

    switch (eventType) {
      // -- Text deltas --
      case "response.output_text.delta":
        textParts.push((event as { delta: string }).delta);
        return { type: "text_delta", delta: (event as { delta: string }).delta };

      // -- Reasoning / thinking deltas --
      //    o-series and gpt-5 with reasoning emit these.
      //    `reasoning_text.delta`         = raw CoT tokens (model-dependent)
      //    `reasoning_summary_text.delta` = readable summary when reasoning.summary is enabled
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        return {
          type: "reasoning_delta",
          delta: raw.delta as string,
        };

      // -- Output item lifecycle (function_call, shell_call, web_search, mcp_call) --
      case "response.output_item.added": {
        const addedItem = (
          raw as {
            item: {
              type: string;
              call_id?: string;
              name?: string;
              id?: string;
            };
          }
        ).item;

        if (addedItem?.type === "function_call") {
          return {
            type: "tool_call_start",
            callId: addedItem.call_id ?? "",
            toolType: "function",
            name: addedItem.name,
          };
        }
        if (addedItem?.type === "shell_call") {
          return {
            type: "tool_call_start",
            callId: addedItem.call_id ?? addedItem.id ?? "",
            toolType: "shell",
          };
        }
        if (addedItem?.type === "web_search_call") {
          return {
            type: "tool_call_start",
            callId: addedItem.id ?? "",
            toolType: "web_search",
          };
        }
        if (addedItem?.type === "mcp_call") {
          // Use item.id (not call_id) to match mcp_call_arguments.delta/done
          // events which reference by item_id.
          return {
            type: "tool_call_start",
            callId: addedItem.id ?? addedItem.call_id ?? "",
            toolType: "mcp",
            name: addedItem.name,
          };
        }
        return null;
      }

      // -- Function call argument streaming --
      case "response.function_call_arguments.delta":
        return {
          type: "tool_call_delta",
          callId: (raw.call_id as string) ?? (raw.item_id as string) ?? "",
          delta: (event as { delta: string }).delta,
        };

      case "response.function_call_arguments.done":
        return {
          type: "tool_call_done",
          callId: (raw.call_id as string) ?? (raw.item_id as string) ?? "",
        };

      // -- MCP call argument streaming --
      case "response.mcp_call_arguments.delta":
        return {
          type: "tool_call_delta",
          callId: (raw.item_id as string) ?? "",
          delta: raw.delta as string,
        };

      case "response.mcp_call_arguments.done":
        return {
          type: "tool_call_done",
          callId: (raw.item_id as string) ?? "",
        };

      // -- Web search lifecycle --
      case "response.web_search_call.searching":
        // Already emitted tool_call_start via output_item.added;
        // this is an informational mid-flight event — skip.
        return null;

      case "response.web_search_call.completed":
        return {
          type: "tool_call_done",
          callId: (raw.item_id as string) ?? "",
        };

      // -- MCP call lifecycle --
      case "response.mcp_call.completed":
      case "response.mcp_call.failed":
        return {
          type: "tool_call_done",
          callId: (raw.item_id as string) ?? "",
        };

      default:
        return null;
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an OpenAI provider instance.
 */
export function createOpenAIProvider(config: ProviderConfig): OpenAIProvider {
  return new OpenAIProvider(config as OpenAIProviderConfig);
}
