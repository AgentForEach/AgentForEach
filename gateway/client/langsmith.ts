import { Client as LangSmithClient, RunTree } from "langsmith";
import type { ClientConfig as LangSmithClientConfig } from "langsmith";
import type { HookEmitter, HookEventMap } from "../hooks/index.js";
import type { UsageStats } from "../llms/index.js";
import { loadConfigSection } from "../utils/config.js";
import { resolveEnvValue } from "../utils/index.js";

interface LangSmithJsonConfig {
  enabled?: boolean;
  apiKey?: string;
  apiUrl?: string;
  project?: string;
  hideInputs?: boolean;
  hideOutputs?: boolean;
  tags?: string[];
  maxFieldLength?: number;
}

interface ObservabilityJsonConfig {
  langsmith?: LangSmithJsonConfig;
}

interface ResolvedLangSmithConfig {
  apiKey: string;
  apiUrl?: string;
  project: string;
  hideInputs: boolean;
  hideOutputs: boolean;
  tags: string[];
  maxFieldLength: number;
}

const DEFAULT_PROJECT = "agentforeach";
const DEFAULT_MAX_FIELD_LENGTH = 4000;

export function registerLangSmithTracing(hooks: HookEmitter): boolean {
  const config = resolveLangSmithConfig();
  if (!config) {
    return false;
  }

  const tracer = new LangSmithTracer(config);
  tracer.attach(hooks);
  return true;
}

function resolveLangSmithConfig(): ResolvedLangSmithConfig | null {
  const section = loadConfigSection<ObservabilityJsonConfig>("observability");
  const json = section?.langsmith ?? {};

  const enabled =
    parseBoolean(process.env.LANGSMITH_TRACING) ??
    parseBoolean(process.env.LANGSMITH_ENABLED) ??
    json.enabled ??
    false;

  if (!enabled) {
    return null;
  }

  const apiKey = process.env.LANGSMITH_API_KEY ?? resolveEnvValue(json.apiKey);
  if (!apiKey) {
    console.warn(
      "[langsmith] Tracing is enabled but LANGSMITH_API_KEY is not configured.",
    );
    return null;
  }

  return {
    apiKey,
    apiUrl:
      process.env.LANGSMITH_ENDPOINT ??
      process.env.LANGCHAIN_ENDPOINT ??
      resolveEnvValue(json.apiUrl),
    project:
      process.env.LANGSMITH_PROJECT ??
      process.env.LANGCHAIN_PROJECT ??
      resolveEnvValue(json.project) ??
      DEFAULT_PROJECT,
    hideInputs:
      parseBoolean(process.env.LANGSMITH_HIDE_INPUTS) ??
      json.hideInputs ??
      false,
    hideOutputs:
      parseBoolean(process.env.LANGSMITH_HIDE_OUTPUTS) ??
      json.hideOutputs ??
      false,
    tags:
      parseTags(process.env.LANGSMITH_TAGS) ??
      normalizeTags(json.tags) ??
      [],
    maxFieldLength: Math.max(
      128,
      json.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH,
    ),
  };
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) return undefined;

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseTags(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return normalizeTags(value.split(","));
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags?.length) return undefined;
  const normalized = tags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

class LangSmithTracer {
  private readonly client: LangSmithClient;
  private readonly rootRuns = new Map<string, RunTree>();
  private readonly llmRuns = new Map<string, RunTree>();
  private readonly toolRuns = new Map<string, RunTree>();

  constructor(private readonly config: ResolvedLangSmithConfig) {
    const clientConfig: LangSmithClientConfig = {
      apiKey: config.apiKey,
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
      hideInputs: config.hideInputs,
      hideOutputs: config.hideOutputs,
    };

    this.client = new LangSmithClient(clientConfig);
  }

  attach(hooks: HookEmitter): void {
    hooks.on("run_started", (event) => {
      void this.handleRunStarted(event);
    });
    hooks.on("llm_call_started", (event) => {
      void this.handleLlmCallStarted(event);
    });
    hooks.on("provider_fallback", (event) => {
      void this.handleProviderFallback(event);
    });
    hooks.on("llm_response", (event) => {
      void this.handleLlmResponse(event);
    });
    hooks.on("tool_call_started", (event) => {
      void this.handleToolCallStarted(event);
    });
    hooks.on("after_tool_call", (event) => {
      void this.handleToolCallCompleted(event);
    });
    hooks.on("run_completed", (event) => {
      void this.handleRunCompleted(event);
    });
    hooks.on("run_failed", (event) => {
      void this.handleRunFailed(event);
    });
  }

  private async handleRunStarted(
    event: HookEventMap["run_started"],
  ): Promise<void> {
    if (this.rootRuns.has(event.runId)) {
      return;
    }

    const run = new RunTree({
      name: `agentforeach.${event.agentId}`,
      run_type: "chain",
      project_name: this.config.project,
      client: this.client,
      tags: this.config.tags,
      metadata: {
        source: "agentforeach",
        runId: event.runId,
        userId: event.userId,
        user_id: event.userId,
        agentId: event.agentId,
        sessionId: event.sessionId,
        ...(event.sessionId
          ? { thread_id: this.buildThreadId(event.userId, event.sessionId) }
          : {}),
        channelName: event.channelName,
      },
      inputs: this.config.hideInputs
        ? { hidden: true }
        : {
            message: truncateString(event.message, this.config.maxFieldLength),
            channelName: event.channelName,
            metadata: summarizeValue(event.metadata, this.config.maxFieldLength),
          },
    });

    this.rootRuns.set(event.runId, run);
    await this.safePost(run);
  }

  private async handleLlmCallStarted(
    event: HookEventMap["llm_call_started"],
  ): Promise<void> {
    const root = this.getOrCreateRoot(event);
    const threadId = this.buildThreadId(event.userId, event.sessionId);
    root.metadata = {
      ...root.metadata,
      user_id: event.userId,
      sessionId: event.sessionId,
      thread_id: threadId,
    };
    await this.safePatch(root, true);

    const llmRun = root.createChild({
      name: `llm.round.${event.round}`,
      run_type: "llm",
      project_name: this.config.project,
      client: this.client,
      metadata: {
        runId: event.runId,
        userId: event.userId,
        user_id: event.userId,
        sessionId: event.sessionId,
        thread_id: threadId,
        round: event.round,
        model: event.request.model,
      },
      inputs: this.config.hideInputs
        ? { hidden: true }
        : buildLlmInputs(event.request, this.config.maxFieldLength),
    });

    this.llmRuns.set(this.roundKey(event.runId, event.round), llmRun);
    await this.safePost(llmRun);
  }

  private async handleProviderFallback(
    event: HookEventMap["provider_fallback"],
  ): Promise<void> {
    const root = this.rootRuns.get(event.runId);
    if (!root) {
      return;
    }

    root.addEvent({
      name: "provider_fallback",
      message: `${event.fromProvider} -> ${event.toProvider}`,
      kwargs: {
        round: event.round,
        reason: truncateString(event.reason, this.config.maxFieldLength),
      },
    });

    await this.safePatch(root, true);
  }

  private async handleLlmResponse(
    event: HookEventMap["llm_response"],
  ): Promise<void> {
    const key = this.roundKey(event.runId, event.round);
    const llmRun = this.llmRuns.get(key);
    if (!llmRun) {
      return;
    }

    await this.safeEnd(
      llmRun,
      this.config.hideOutputs
        ? buildHiddenOutputs(event.response.usage)
        : buildLlmOutputs(event.response, this.config.maxFieldLength),
    );
    this.llmRuns.delete(key);
  }

  private async handleToolCallStarted(
    event: HookEventMap["tool_call_started"],
  ): Promise<void> {
    const threadId = this.buildThreadId(event.userId, event.sessionId);
    const parent =
      this.llmRuns.get(this.roundKey(event.runId, event.round)) ??
      this.rootRuns.get(event.runId);
    if (!parent) {
      return;
    }

    const toolRun = parent.createChild({
      name: event.name,
      run_type: "tool",
      project_name: this.config.project,
      client: this.client,
      metadata: {
        runId: event.runId,
        userId: event.userId,
        user_id: event.userId,
        sessionId: event.sessionId,
        thread_id: threadId,
        round: event.round,
        callId: event.callId,
      },
      inputs: this.config.hideInputs
        ? { hidden: true }
        : {
            args: summarizeValue(event.args, this.config.maxFieldLength),
          },
    });

    this.toolRuns.set(this.toolKey(event.runId, event.callId), toolRun);
    await this.safePost(toolRun);
  }

  private async handleToolCallCompleted(
    event: HookEventMap["after_tool_call"],
  ): Promise<void> {
    if (!event.runId) {
      return;
    }

    const key = this.toolKey(event.runId, event.callId);
    const toolRun = this.toolRuns.get(key);
    if (!toolRun) {
      return;
    }

    await this.safeEnd(
      toolRun,
      this.config.hideOutputs
        ? { hidden: true }
        : {
            result: summarizeValue(event.result, this.config.maxFieldLength),
          },
    );
    this.toolRuns.delete(key);
  }

  private async handleRunCompleted(
    event: HookEventMap["run_completed"],
  ): Promise<void> {
    await this.finalizeOutstandingChildren(event.runId);

    const root = this.rootRuns.get(event.runId);
    if (!root) {
      return;
    }

    await this.safeEnd(
      root,
      this.config.hideOutputs
        ? buildHiddenOutputs(event.response.usage)
        : buildRootOutputs(event.response, this.config.maxFieldLength),
    );
    this.rootRuns.delete(event.runId);
  }

  private async handleRunFailed(
    event: HookEventMap["run_failed"],
  ): Promise<void> {
    await this.finalizeOutstandingChildren(event.runId, event.error.message);

    const root = this.rootRuns.get(event.runId);
    if (!root) {
      return;
    }

    await this.safeEnd(root, undefined, event.error.message);
    this.rootRuns.delete(event.runId);
  }

  private getOrCreateRoot(
    event:
      | HookEventMap["llm_call_started"]
      | HookEventMap["provider_fallback"]
      | HookEventMap["llm_response"],
  ): RunTree {
    const existing = this.rootRuns.get(event.runId);
    if (existing) {
      return existing;
    }

    const run = new RunTree({
      name: "agentforeach.run",
      run_type: "chain",
      project_name: this.config.project,
      client: this.client,
      tags: this.config.tags,
      metadata: {
        source: "agentforeach",
        runId: event.runId,
        userId: event.userId,
        user_id: event.userId,
        sessionId: event.sessionId,
        thread_id: this.buildThreadId(event.userId, event.sessionId),
      },
      inputs: { recovered: true },
    });

    this.rootRuns.set(event.runId, run);
    void this.safePost(run);
    return run;
  }

  private async finalizeOutstandingChildren(
    runId: string,
    error?: string,
  ): Promise<void> {
    for (const [key, run] of this.llmRuns) {
      if (!key.startsWith(`${runId}:`)) continue;
      await this.safeEnd(run, undefined, error);
      this.llmRuns.delete(key);
    }

    for (const [key, run] of this.toolRuns) {
      if (!key.startsWith(`${runId}:`)) continue;
      await this.safeEnd(run, undefined, error);
      this.toolRuns.delete(key);
    }
  }

  private roundKey(runId: string, round: number): string {
    return `${runId}:${round}`;
  }

  private toolKey(runId: string, callId: string): string {
    return `${runId}:${callId}`;
  }

  private buildThreadId(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  private async safePost(run: RunTree): Promise<void> {
    try {
      await run.postRun();
    } catch (error) {
      console.error("[langsmith] Failed to create run:", toErrorString(error));
    }
  }

  private async safePatch(run: RunTree, excludeInputs = false): Promise<void> {
    try {
      await run.patchRun({ excludeInputs });
    } catch (error) {
      console.error("[langsmith] Failed to patch run:", toErrorString(error));
    }
  }

  private async safeEnd(
    run: RunTree,
    outputs?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    try {
      const usageMetadata = extractUsageMetadata(outputs);
      if (usageMetadata) {
        run.extra = {
          ...run.extra,
          metadata: {
            ...run.extra?.metadata,
            usage_metadata: usageMetadata,
          },
        };
      }

      await run.end(outputs, error);
      await run.patchRun({ excludeInputs: this.config.hideInputs });
    } catch (endError) {
      console.error("[langsmith] Failed to finalize run:", toErrorString(endError));
    }
  }
}

function buildLlmInputs(
  request: HookEventMap["llm_call_started"]["request"],
  maxFieldLength: number,
): Record<string, unknown> {
  const input = summarizeValue(request.input, maxFieldLength);
  return {
    model: request.model,
    stream: request.stream,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    reasoning: summarizeValue(request.reasoning, maxFieldLength),
    toolChoice: request.toolChoice,
    toolCount: request.tools?.length ?? 0,
    tools: request.tools
      ?.map((tool) => ("name" in tool ? tool.name : tool.type))
      .slice(0, 20),
    instructions: summarizeValue(request.instructions, maxFieldLength),
    input,
    message: typeof request.input === "string" ? truncateString(request.input, maxFieldLength) : undefined,
    metadata: summarizeValue(request.metadata, maxFieldLength),
  };
}

function buildLlmOutputs(
  response: HookEventMap["llm_response"]["response"],
  maxFieldLength: number,
): Record<string, unknown> {
  const outputText = truncateString(response.text, maxFieldLength);
  const usageMetadata = normalizeUsageMetadata(response.usage);
  const assistantMessage = buildAssistantMessage(response, maxFieldLength);
  const nestedOutputs: Record<string, unknown> = {
    text: outputText,
    output: outputText,
    content: assistantMessage.content,
    message: assistantMessage,
    messages: [assistantMessage],
    generations: outputText ? [{ text: outputText }] : [],
    output_items: summarizeValue(response.output, maxFieldLength),
    ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
  };

  return {
    responseId: response.responseId,
    providerId: response.providerId,
    model: response.model,
    status: response.status,
    output: outputText,
    text: outputText,
    content: assistantMessage.content,
    message: assistantMessage,
    messages: [assistantMessage],
    generations: outputText ? [{ text: outputText }] : [],
    usage: summarizeValue(response.usage, maxFieldLength),
    usage_metadata: usageMetadata,
    output_items: summarizeValue(response.output, maxFieldLength),
    outputs: nestedOutputs,
  };
}

function buildRootOutputs(
  response: HookEventMap["run_completed"]["response"],
  maxFieldLength: number,
): Record<string, unknown> {
  const outputText = truncateString(response.text, maxFieldLength);
  const usageMetadata = normalizeUsageMetadata(response.usage);
  const nestedOutputs: Record<string, unknown> = {
    output: outputText,
    text: outputText,
    content: outputText,
    ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
  };

  return {
    output: outputText ? [outputText] : [],
    text: outputText,
    content: outputText,
    providerId: response.providerId,
    model: response.model,
    sessionId: response.sessionId,
    status: response.status,
    usage: summarizeValue(response.usage, maxFieldLength),
    usage_metadata: usageMetadata,
    durationMs: response.durationMs,
    memoriesRecalled: response.memoriesRecalled,
    memoryCaptured: response.memoryCaptured,
    outputs: nestedOutputs,
  };
}

function buildAssistantMessage(
  response: HookEventMap["llm_response"]["response"],
  maxFieldLength: number,
): Record<string, unknown> {
  const content = truncateString(response.text, maxFieldLength) ?? "";
  const toolCalls = extractToolCalls(response.output, maxFieldLength);

  return {
    role: "assistant",
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function extractToolCalls(
  outputItems: HookEventMap["llm_response"]["response"]["output"],
  maxFieldLength: number,
): Array<Record<string, unknown>> {
  return outputItems
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      id: item.callId,
      type: "function",
      function: {
        name: item.name,
        arguments: truncateString(item.arguments, maxFieldLength) ?? "{}",
      },
    }));
}

function normalizeUsageMetadata(
  usage: UsageStats | undefined,
): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }

  const inputTokenDetails: Record<string, number> = {};
  const outputTokenDetails: Record<string, number> = {};

  if (typeof usage.cachedInputTokens === "number") {
    inputTokenDetails.cache_read = usage.cachedInputTokens;
  }

  if (typeof usage.reasoningTokens === "number") {
    outputTokenDetails.reasoning = usage.reasoningTokens;
  }

  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(Object.keys(inputTokenDetails).length > 0
      ? { input_token_details: inputTokenDetails }
      : {}),
    ...(Object.keys(outputTokenDetails).length > 0
      ? { output_token_details: outputTokenDetails }
      : {}),
  };
}

function buildHiddenOutputs(
  usage: UsageStats | undefined,
): Record<string, unknown> {
  return {
    hidden: true,
    ...(normalizeUsageMetadata(usage)
      ? { usage_metadata: normalizeUsageMetadata(usage) }
      : {}),
  };
}

function extractUsageMetadata(
  outputs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const usageMetadata =
    outputs?.usage_metadata ??
    (typeof outputs?.outputs === "object" && outputs.outputs !== null
      ? (outputs.outputs as Record<string, unknown>).usage_metadata
      : undefined);
  return usageMetadata && typeof usageMetadata === "object"
    ? (usageMetadata as Record<string, unknown>)
    : undefined;
}

function summarizeValue(
  value: unknown,
  maxFieldLength: number,
  depth = 0,
): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value, maxFieldLength);
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (depth >= 3) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 10).map((item) =>
      summarizeValue(item, maxFieldLength, depth + 1),
    );
    return value.length > 10
      ? [...items, `[+${value.length - 10} more]`]
      : items;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    const summarized: Record<string, unknown> = {};

    for (const [key, entryValue] of entries) {
      if (/base64|image|bytes|data/i.test(key)) {
        summarized[key] = "[omitted]";
        continue;
      }

      summarized[key] = summarizeValue(entryValue, maxFieldLength, depth + 1);
    }

    return summarized;
  }

  return String(value);
}

function truncateString(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value.length > maxLength
    ? `${value.slice(0, maxLength)}…`
    : value;
}

function toErrorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}