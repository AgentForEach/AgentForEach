/**
 * AgentForEach Provider Layer — Types
 *
 * Unified type definitions for multi-provider LLM abstraction.
 * Supports OpenAI Responses API (with Shell tool) and Anthropic Claude.
 *
 * Design goals:
 *   - Provider-agnostic request/response shapes
 *   - First-class shell/container tool support (OpenAI)
 *   - Streaming and non-streaming
 *   - Multi-turn conversation state
 *   - Usage tracking for billing / observability
 */

// ============================================================================
// Provider Identity
// ============================================================================

/** Registered provider identifiers. */
export type ProviderId = "openai" | "anthropic" | (string & {});

/** Optional input modalities a provider supports beyond text. */
export interface ProviderCapabilities {
  /**
   * Accepts PDFs as native document input, rendering each page so the model
   * sees layout — tables, stamps, marginal notes — rather than flattened text.
   *
   * False for OpenAI-compatible Chat Completions endpoints: that wire format
   * has `image_url` but no file input at all.
   */
  nativeDocuments: boolean;
}

// ============================================================================
// Provider Configuration
// ============================================================================

/** Base configuration shared by all providers. */
export interface ProviderConfig {
  /** API key for authentication. */
  apiKey: string;
  /** Default model to use if not specified per-request. */
  defaultModel: string;
  /** Optional base URL override (proxies, Azure OpenAI, etc.). */
  baseUrl?: string;
  /** Request timeout in milliseconds (0 = no timeout). */
  timeoutMs?: number;
  /**
   * Override the provider ID this instance reports.
   *
   * Used when a config-level provider (e.g. "minimax") is routed to a
   * format-specific factory (e.g. "openai-completions"). Without this
   * the instance would report the factory ID instead of the config name.
   */
  providerId?: string;
}

/** Responses API truncation mode. */
export type OpenAIResponsesTruncation = "auto" | "disabled";

/** Responses API server-side compaction settings. */
export interface OpenAIContextManagementConfig {
  /** Enable server-side context management / compaction. */
  enabled?: boolean;
  /** Trigger compaction when rendered token count crosses this threshold. */
  compactThreshold?: number;
}

/** OpenAI Responses API request defaults. */
export interface OpenAIResponsesConfig {
  /** Optional truncation strategy for oversized conversations. */
  truncation?: OpenAIResponsesTruncation;
  /** Optional server-side context management / compaction settings. */
  contextManagement?: OpenAIContextManagementConfig;
  /**
   * Whether to store responses on OpenAI servers for multi-turn chaining
   * via `previous_response_id`.
   *
   * - `true`  (default) — responses are stored for 30 days.
   * - `false` — responses are ephemeral; `previous_response_id` cannot
   *   reference them.
   */
  store?: boolean;
}

/** OpenAI-specific config extensions. */
export interface OpenAIProviderConfig extends ProviderConfig {
  /** Default shell environment type. */
  defaultShellEnvironment?: ShellEnvironmentType;
  /** Organization ID for API billing. */
  organization?: string;
  /** Project ID for API scoping. */
  project?: string;
  /** Default Responses API behavior for truncation / server-side compaction. */
  responses?: OpenAIResponsesConfig;
}

/** Anthropic-specific config extensions. */
export interface AnthropicProviderConfig extends ProviderConfig {
  /** Max tokens for Anthropic API (required by their API). */
  defaultMaxTokens?: number;
}

// ============================================================================
// Shell / Container Tool
// ============================================================================

/** Shell environment types supported by OpenAI Responses API. */
export type ShellEnvironmentType = "container_auto" | "container_reference" | "local";

/** Shell environment configuration. */
export type ShellEnvironment =
  | {
      type: "container_auto";
      fileIds?: string[];
      memoryLimit?: string;
      networkPolicy?: NetworkPolicy;
      skills?: SkillReference[];
    }
  | {
      type: "container_reference";
      containerId: string;
      networkPolicy?: NetworkPolicy;
    }
  | {
      type: "local";
      skills?: LocalSkill[];
    };

/** A skill reference for container_auto environment. */
export type SkillReference =
  | { type: "skill_reference"; id: string; version?: string | number }
  | { type: "inline"; name: string; description: string; source: { type: "base64"; mediaType: string; data: string } };

/** A local skill (path-based). */
export interface LocalSkill {
  name: string;
  description: string;
  path: string;
}

/** Network access policy for containers. */
export type NetworkPolicy =
  | { type: "disabled" }
  | {
      type: "allowlist";
      allowedDomains: string[];
      domainSecrets?: DomainSecret[];
    };

/** Secret credential for a network domain. */
export interface DomainSecret {
  domain: string;
  name: string;
  value: string;
}

// ============================================================================
// Tool Definitions (provider-agnostic)
// ============================================================================

/**
 * A tool the model may invoke.
 *
 * Discriminated union — `type` field selects the variant.
 */
export type ToolDefinition =
  | ShellToolDefinition
  | LocalShellToolDefinition
  | FunctionToolDefinition
  | WebSearchToolDefinition;

/** Shell tool — runs commands in a hosted container or local runtime. */
export interface ShellToolDefinition {
  type: "shell";
  environment: ShellEnvironment;
}

/** Local shell tool — runs commands in a local environment (Agents SDK). */
export interface LocalShellToolDefinition {
  type: "local_shell";
}

/** Function tool — model calls developer-defined functions. */
export interface FunctionToolDefinition {
  type: "function";
  name: string;
  description?: string;
  /** JSON Schema for the function parameters. */
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/** Web search tool — built-in web search (OpenAI only). */
export interface WebSearchToolDefinition {
  type: "web_search";
}

// ============================================================================
// Conversation / Multi-turn State
// ============================================================================

/** Provider-agnostic conversation state for multi-turn requests. */
export interface ConversationState {
  /** OpenAI: previous_response_id for linked responses. */
  previousResponseId?: string;
  /** OpenAI: reusable container ID for shell tool persistence. */
  containerId?: string;
  /** Anthropic: conversation history as message array. */
  messages?: ConversationMessage[];
}

/** A single message in a multi-turn conversation (Anthropic-style). */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** Rich content block for multi-modal messages. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "document"; source: DocumentSource; fileName?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; images?: ToolResultImage[] }
  /** Anthropic extended thinking; must be sent back unchanged with its tool_use. */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** Image source for vision inputs. */
export interface ImageSource {
  type: "base64" | "url";
  mediaType?: string;
  data: string;
}

/**
 * Document source for native document inputs.
 *
 * Only base64 is supported — deliberately. Provider-hosted file IDs are not
 * portable, and AgentForEach's failover engine can move a single turn between
 * providers mid-flight, which would invalidate any handle we had obtained.
 */
export interface DocumentSource {
  type: "base64";
  /** Currently only "application/pdf" is accepted by any provider. */
  mediaType: string;
  data: string;
}

// ============================================================================
// Function Call Output (tool result feedback)
// ============================================================================

/**
 * Result of a function tool call, fed back to the model as input.
 *
 * After the model emits a `function_call` output item, the orchestration
 * executes the function and creates one of these per call. On the next
 * LLM request, these are sent as the `input` so the model can incorporate
 * the tool results.
 */
export interface FunctionCallOutput {
  type: "function_call_output";
  /** The call ID from the function_call output item. */
  callId: string;
  /** The string result returned by the function. */
  output: string;
  /** Images the tool returned for the model to see (a browser screenshot), sent with `output`. */
  images?: ToolResultImage[];
}

/**
 * An image a tool returns to the model. Providers send it with the tool's
 * result (Anthropic tool_result blocks, OpenAI function_call_output lists);
 * Chat Completions, whose tool messages are text only, gets it in a user
 * message after them. Only the latest round's images are resent (see
 * transcript.ts), and none are saved to session history.
 */
export interface ToolResultImage {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** Base64, no data: prefix. */
  data: string;
}

// ============================================================================
// Provider Request (unified)
// ============================================================================

/** Input to create a response from any provider. */
export interface ProviderRequest {
  /** Model identifier (e.g., "gpt-5.2", "claude-sonnet-4-20250514"). */
  model?: string;
  /**
   * The user's input.
   *
   * - `string` — simple text prompt
   * - `ConversationMessage[]` — structured multi-turn messages
   * - `FunctionCallOutput[]` — tool results fed back after a function_call round
   */
  input: string | ConversationMessage[] | FunctionCallOutput[];
  /** System/developer instructions. */
  instructions?: string;
  /** Tools available to the model. */
  tools?: ToolDefinition[];
  /** How the model should select tools. */
  toolChoice?: "auto" | "required" | "none" | { type: "function"; name: string };
  /** Multi-turn conversation state. */
  conversation?: ConversationState;
  /**
   * What failover sends to a different provider in place of `input` when
   * `conversation.previousResponseId` is set: the local history plus the new
   * message, since no other provider can follow that response chain. Without
   * it a chained request (a tool round continuing this turn) stays on its
   * provider.
   */
  failoverInput?: ConversationMessage[];
  /** Maximum output tokens. */
  maxOutputTokens?: number;
  /** Maximum number of tool calls. */
  maxToolCalls?: number;
  /** Sampling temperature (0–2). */
  temperature?: number;
  /** Nucleus sampling parameter. */
  topP?: number;
  /** Whether to enable reasoning/thinking (for models that support it). */
  reasoning?: ReasoningConfig;
  /** Whether to stream the response. */
  stream?: boolean;
  /** Abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
  /** Arbitrary metadata to attach to the request. */
  metadata?: Record<string, string>;
}

/** Reasoning/thinking configuration. */
export interface ReasoningConfig {
  /**
   * Effort level for reasoning.
   *
   * OpenAI Responses API supports: none, minimal, low, medium, high, xhigh.
   * - gpt-5.1 defaults to none; supports none, low, medium, high.
   * - Models before gpt-5.1 default to medium; do not support none.
   * - xhigh is for gpt-5.1-codex-max and later.
   *
   * Claude extended thinking maps effort to token budgets.
   */
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /**
   * Optional reasoning summary mode.
   *
   * Newer Responses API variants use `reasoning.summary`.
   */
  summary?: "auto" | "concise" | "detailed";
  /**
   * Whether to include a summary of reasoning in the response.
   * @deprecated Use `summary` instead.
   */
  generateSummary?: boolean;
}

// ============================================================================
// Provider Response (unified)
// ============================================================================

/** Output from a provider response call. */
export interface ProviderResponse {
  /** Provider that generated this response. */
  providerId: ProviderId;
  /** The raw response ID from the provider. */
  responseId: string;
  /** Model that actually generated the response. */
  model: string;
  /** Primary text output (convenience — extracted from output items). */
  text: string;
  /** Structured output items. */
  output: OutputItem[];
  /** Token usage statistics. */
  usage?: UsageStats;
  /** Updated conversation state for multi-turn. */
  conversationState?: ConversationState;
  /** Response completion status. */
  status: "completed" | "incomplete" | "failed";
  /** Error details if status is "failed". */
  error?: { code: string; message: string };
  /** Service tier used (OpenAI-specific). */
  serviceTier?: string;
  /** Raw provider-specific response (for debugging / escape hatch). */
  raw?: unknown;
}

/** A single output item in the response. */
export type OutputItem =
  | MessageOutputItem
  | ShellCallOutputItem
  | ShellCallResultItem
  | FunctionCallOutputItem
  | ReasoningOutputItem;

/** Assistant message output. */
export interface MessageOutputItem {
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
}

/** Shell command requested by the model. */
export interface ShellCallOutputItem {
  type: "shell_call";
  callId: string;
  commands: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
  status: "completed" | "in_progress";
}

/** Shell command execution result. */
export interface ShellCallResultItem {
  type: "shell_call_output";
  callId: string;
  output: Array<{
    stdout: string;
    stderr: string;
    outcome: { type: "exit"; exitCode: number } | { type: "timeout" };
  }>;
  maxOutputChars?: number;
}

/** Function call requested by the model. */
export interface FunctionCallOutputItem {
  type: "function_call";
  callId: string;
  name: string;
  arguments: string;
}

/** Reasoning/thinking output. */
export interface ReasoningOutputItem {
  type: "reasoning";
  text?: string;
  summary?: string;
}

// ============================================================================
// Token Usage
// ============================================================================

/** Token usage statistics. */
export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Cached input tokens (OpenAI prompt caching). */
  cachedInputTokens?: number;
  /** Reasoning tokens (o-series models). */
  reasoningTokens?: number;
}

// ============================================================================
// Streaming
// ============================================================================

/** Events emitted during streaming. */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_start"; callId: string; toolType: string; name?: string }
  | { type: "tool_call_delta"; callId: string; delta: string }
  | { type: "tool_call_done"; callId: string }
  | { type: "done"; response: ProviderResponse }
  | { type: "error"; error: Error };

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * The core provider contract.
 *
 * Each LLM provider implements this interface to expose a unified API
 * for creating responses, streaming, and extracting text.
 */
export interface Provider {
  /** Unique identifier for this provider. */
  readonly id: ProviderId;

  /**
   * What this provider can accept beyond plain text.
   *
   * Absent means "assume the baseline" — text and images only.
   */
  readonly capabilities?: ProviderCapabilities;

  /**
   * Create a non-streaming response.
   *
   * @param request - The unified request.
   * @returns The unified response.
   */
  createResponse(request: ProviderRequest): Promise<ProviderResponse>;

  /**
   * Create a streaming response.
   *
   * @param request - The unified request (stream flag is implicit).
   * @returns An async iterable of stream events.
   */
  streamResponse(request: ProviderRequest): AsyncIterable<StreamEvent>;

  /**
   * List available models for this provider.
   * Returns model IDs that can be used in requests.
   */
  listModels?(): Promise<string[]>;
}

// ============================================================================
// Provider Factory
// ============================================================================

/** Factory function that creates a Provider from config. */
export type ProviderFactory = (config: ProviderConfig) => Provider;
