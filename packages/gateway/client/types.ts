/**
 * AgentForEach Client Layer — Types
 *
 * Type definitions for the unified client that orchestrates
 * message handling across all subsystems.
 *
 * Maps to OpenClaw's gateway → auto-reply → agent runner pipeline,
 * simplified for Azure serverless:
 *
 *   AgentClient.send(message)
 *     → build system prompt (prompt layer)
 *     → recall memories (memory layer)
 *     → call LLM (provider layer)
 *     → capture memories (memory layer)
 *     → push response (realtime layer)
 *     → persist session (session store)
 */

import type { ProviderId, Provider, UsageStats } from "../llms/index.js";
import type {
  PromptMode,
  SessionType,
  AgentIdentity,
  PromptDocumentStore,
} from "../prompt/index.js";
import type { HookEmitter } from "../hooks/index.js";
import type {
  Session,
  SessionMessage,
  SessionSummary,
  MessageDocument,
} from "../sessions/index.js";
import type { UsageRecord, UsageSummary } from "../usage/index.js";

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Configuration for the AgentForEach client.
 *
 * All fields are optional — values are auto-resolved from agentforeach.json
 * via each subsystem's config module (llms, websocket, sessions, memory,
 * database). Explicit values here override the auto-resolved config
 * (useful for tests, migration, or standalone usage).
 *
 * Equivalent to OpenClaw's server config + model config + agent config.
 */
export interface AgentClientConfig {
  /**
   * Database connection config.
   *
   * Auto-resolved from agentforeach.json "database" section via
   * `loadDatabaseConfig()`.  If provided, overrides the auto-resolved
   * values.
   */
  cosmos?: {
    endpoint?: string;
    key?: string;
    databaseId?: string;
  };

  /**
   * LLM provider config.
   *
   * Auto-resolved from agentforeach.json "llms" section via
   * `resolveDefaultProviderId()`, `resolveProviderConfig()`, and
   * `getEnabledProviderIds()`. Explicit values override the auto-resolved
   * config.
   */
  provider?: {
    /** Provider to use. Auto-resolved from agentforeach.json "llms.defaultProvider". */
    id?: ProviderId;
    /** API key for the provider. Auto-resolved from agentforeach.json. */
    apiKey?: string;
    /**
     * Optional per-provider API keys used when `providerId` overrides are
     * supplied on individual requests. Auto-resolved from enabled providers.
     */
    apiKeys?: Partial<Record<ProviderId, string>>;
    /** Default model. Auto-resolved from agentforeach.json per-provider config. */
    defaultModel?: string;
    /**
     * Optional provider-specific default models used when `providerId`
     * overrides are supplied without an explicit `model`. Auto-resolved.
     */
    defaultModels?: Partial<Record<ProviderId, string>>;
    /** Base URL override (proxies, Azure OpenAI). */
    baseUrl?: string;
  };

  /**
   * Memory layer config.
   *
   * Auto-resolved from agentforeach.json "memory" section.
   * Embedding config comes from the "llms.embedding" section.
   *
   * @deprecated Prefer configuring via agentforeach.json "memory" section.
   */
  memory?: {
    /** Enable auto-recall (inject relevant memories into prompt). */
    autoRecall?: boolean;
    /** Enable auto-capture (store memorable messages). */
    autoCapture?: boolean;
  };

  /**
   * Real-time push config.
   *
   * Auto-resolved from agentforeach.json "websocket" section via
   * `resolveConnectionString()` and `resolveHub()`.
   */
  realtime?: {
    /** Web PubSub connection string. If omitted, auto-resolved from config. */
    connectionString?: string;
    /** Hub name. Auto-resolved from config. */
    hub?: string;
    /** Whether to push streaming deltas to connected clients. Default: true. */
    streamToClient?: boolean;
  };

  /**
   * Session config.
   *
   * Auto-resolved from agentforeach.json "session" section via
   * `loadSessionConfig()`. Explicit values override the auto-resolved config.
   */
  session?: {
    /** Max messages to retain in session history. */
    maxHistoryMessages?: number;
    /** Session inactivity TTL in seconds. */
    ttlSeconds?: number;
  };
}

// ============================================================================
// Send Request / Response
// ============================================================================

/**
 * Input for sending a message to AgentForEach.
 *
 * Equivalent to OpenClaw's `chat.send({ sessionKey, message })`.
 */
export interface SendRequest {
  /** Stable internal run id, allocated before credit reservation. */
  runId?: string;
  /** User sending the message. */
  userId: string;

  /** Agent to address. Default: "default". */
  agentId?: string;

  /** The user's message text. */
  message: string;

  /**
   * Attachments to include with the message.
   *
   * Images are transient — the base64 reaches the provider for this turn and
   * is not persisted. Documents are extracted to text, and that text *is*
   * persisted so later turns can still refer to them.
   *
   * `fileName` is optional but improves both format detection and the context
   * block the model sees.
   */
  attachments?: Array<{ mimeType: string; base64: string; fileName?: string }>;

  /** Human-input response that resolves a pending request_user_input tool call. */
  hitlInputResponse?: {
    requestId: string;
    data?: Record<string, unknown>;
    cancelled?: boolean;
  };

  /** Session key — groups messages into a conversation. */
  sessionId?: string;
  /** Optional idempotency key for duplicate-suppressed retries. */
  idempotencyKey?: string;

  // -- Model overrides --

  /** Override the provider for this request. */
  providerId?: ProviderId;

  /** Override the model for this request. */
  model?: string;

  /** Reasoning effort level. */
  reasoningEffort?: "none" | "low" | "medium" | "high";

  /** Sampling temperature. */
  temperature?: number;

  // -- Prompt overrides --

  /** Override prompt mode. Default: "full". */
  promptMode?: PromptMode;

  /** Override session type. Default: "interactive". */
  sessionType?: SessionType;

  /** Extra system prompt to append (e.g., from a channel). */
  extraSystemPrompt?: string;

  // -- Context --

  /** Channel the message came from (e.g., "telegram", "discord"). */
  channelName?: string;

  /** Channel-specific chat/conversation ID (e.g., Telegram chat ID). */
  channelChatId?: string;

  /**
   * Whether the requesting surface can render HITL widgets
   * (request_user_input pickers/forms). Absent means
   * yes — the app/websocket surface is the historical caller. Channel
   * plugins set it from their own capability (channels/types.ts).
   */
  hitlWidgets?: boolean;

  /** Whether this is a group chat message. */
  isGroupChat?: boolean;

  /** Group name (if group chat). */
  groupName?: string;

  /** Authorized sender identifiers. */
  authorizedSenders?: string[];

  /** User's timezone (e.g., "America/New_York"). */
  userTimezone?: string;

  // -- Control --

  /** Abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;

  /**
   * Epoch ms by which the run must finish; it fails with a timeout error
   * after that. Default: now + CHITTI_RUN_DEADLINE_MS (9 min, under the
   * Functions timeout). HTTP callers pass less: Azure's front end drops
   * requests after 230 s.
   */
  deadlineAt?: number;

  /**
   * Started by the system (a cron heartbeat, a HITL continuation), not by a
   * user message: not rate-limited, and a busy session isn't reported to the
   * user's socket (the caller retries).
   */
  scheduled?: boolean;

  /**
   * The caller already counted this message against the rate limit (the
   * chat handlers check before starting a background turn). Server-set only.
   */
  rateLimitChecked?: boolean;

  /** Arbitrary metadata. */
  metadata?: Record<string, string>;

  /**
   * Optional internal callback invoked when cron tools mutate jobs.
   * Used by function handlers to signal Durable scheduler wake events.
   */
  onCronMutation?: () => Promise<void>;

  /**
   * @internal Azure Function invocation context, threaded from the WS handler.
   * Used by the HITL gate to obtain a Durable Functions client.
   * Not serialised — stripped by `serializeSendRequest()`.
   */
  _invocationContext?: import("@azure/functions").InvocationContext;
}

/**
 * Result of a completed send operation.
 *
 * Equivalent to OpenClaw's final chat event `{state: "final", message}`.
 */
export interface SendResponse {
  /** Unique run ID for this request. */
  runId: string;

  /** The assistant's reply text. */
  text: string;

  /** The session ID (created or reused). */
  sessionId: string;

  /** Resolved agent identity. */
  identity: AgentIdentity;

  /** Provider that generated the response. */
  providerId: ProviderId;

  /** Model that generated the response. */
  model: string;

  /** Token usage. */
  usage?: UsageStats;

  /** Number of memories recalled for this request. */
  memoriesRecalled: number;

  /** Whether a new memory was captured from this exchange. */
  memoryCaptured: boolean;

  /** Total processing time in milliseconds. */
  durationMs: number;

  /** Completion status. */
  status: "completed" | "failed" | "awaiting_input" | "aborted";

  /**
   * Error message if status is "failed". User-facing refusals use a code,
   * with the explanation in `text`: RATE_LIMITED, SESSION_BUSY,
   * INSUFFICIENT_CREDITS, CREDITS_UNAVAILABLE.
   */
  error?: string;

  /** With RATE_LIMITED: seconds until the next message is accepted. */
  retryAfterSeconds?: number;

  /**
   * Present when status is "awaiting_input".
   * The Durable Functions orchestration instance ID that is waiting
   * for the user's input. The client should display the form and
   * send back the input_response to resume the run.
   */
  hitlRequestId?: string;

  /**
   * Present when the model asked a bounded-choice question on a surface
   * without HITL widgets (hitlWidgets=false). The channel renders these
   * natively (WhatsApp reply buttons for ≤3 options, a list beyond that);
   * `text` remains a complete message on its own and becomes the body the
   * choices attach to. The user's selection arrives as their next inbound
   * message — there is no suspend/resume.
   */
  nativeChoices?: NativeChoices;
}

/**
 * A bounded-choice question destined for a channel's native selection UI.
 * Channel-neutral on purpose: the channel router shapes it into its own
 * OutboundPayload (buttons vs list) and enforces the channel's caps.
 */
export interface NativeChoices {
  options: Array<{ id: string; title: string; description?: string }>;
  /** Label on the list-opening button when the channel renders a list. */
  listButton?: string;
}

// ============================================================================
// Session Types (re-exported from dedicated sessions module)
// ============================================================================

export type {
  Session,
  SessionMessage,
  SessionSummary,
  MessageDocument,
} from "../sessions/index.js";

// ============================================================================
// Usage Types (re-exported from dedicated usage module)
// ============================================================================

export type { UsageRecord, UsageSummary } from "../usage/index.js";

// ============================================================================
// Streaming Callback
// ============================================================================

/**
 * Callback for streaming events during a send operation.
 *
 * Equivalent to OpenClaw's `subscribeEmbeddedPiSession()` event handlers
 * (onPartialReply, onBlockReply, onToolResult, onAgentEvent).
 */
export type StreamCallback = (event: ClientStreamEvent) => void;

/**
 * Events emitted during send processing.
 *
 * Maps OpenClaw's granular event types to a simpler set:
 *   - OpenClaw emitChatDelta → text_delta
 *   - OpenClaw onToolResult  → tool_start / tool_done
 *   - OpenClaw emitChatFinal → done
 */
export type ClientStreamEvent =
  | { type: "run_started"; runId: string }
  | { type: "text_delta"; delta: string; accumulated: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; callId: string; toolType: string; name?: string }
  | { type: "tool_delta"; callId: string; delta: string }
  | { type: "tool_done"; callId: string }
  | { type: "memories_recalled"; count: number; context: string }
  | { type: "memory_captured"; text: string }
  | { type: "provider_fallback"; fromProvider: string; toProvider: string; reason: string }
  | { type: "links_resolved"; count: number; urls: string[] }
  | { type: "documents_extracted"; count: number; fileNames: string[] }
  | {
      type: "input_request";
      requestId: string;
      toolName: string;
      intent: string;
      proposedArgs: Record<string, unknown>;
      formType: import("../hitl/types.js").HitlFormType;
      formName?: string;
      options?: Array<{ label: string; value: string; description?: string }>;
      schema: Record<string, unknown>;
      uiHints?: import("../hitl/types.js").HitlUiHints;
      timeoutSeconds: number;
    }
  | { type: "done"; response: SendResponse }
  | { type: "error"; error: Error };

// ============================================================================
// Client Interface
// ============================================================================

/**
 * The AgentForEach client — unified API for sending messages and receiving responses.
 *
 * This is the equivalent of OpenClaw's full gateway → auto-reply → agent pipeline,
 * compressed into a single clean interface for serverless deployment.
 *
 * ```ts
 * const client = createAgentClient();
 * await client.initialize();
 *
 * // Simple request-response
 * const response = await client.send({ userId: "u1", message: "Hello!" });
 *
 * // With streaming
 * const response = await client.send(
 *   { userId: "u1", message: "Write a poem" },
 *   (event) => {
 *     if (event.type === "text_delta") process.stdout.write(event.delta);
 *   },
 * );
 * ```
 */
export interface AgentClient {
  /**
   * Initialize all subsystems (Cosmos DB containers, etc.).
   * Must be called once before first use.
   */
  initialize(): Promise<void>;

  /**
   * The prompt document store used for system prompt assembly.
   * Exposed for use by subsystems (e.g. cron executor) that need
   * to build system prompts outside the main runner pipeline.
   */
  readonly promptStore: PromptDocumentStore;

  /**
   * Hook emitter for lifecycle events. Register handlers via hooks.on().
   *
   * Provides typed hooks at every stage of the message pipeline:
   * run lifecycle, session lifecycle, prompt build, LLM call, tool
   * execution, memory, compaction, messages, and commands.
   *
   * ```ts
   * client.hooks.on("llm_response", (event) => {
   *   console.log(`LLM responded with ${event.model}`);
   * });
   * ```
   */
  readonly hooks: HookEmitter;

  /**
   * The default LLM provider (resolved from agentforeach.json).
   * Exposed for subsystems (e.g. cron executor) that need to call
   * the LLM outside the main runner pipeline.
   */
  readonly provider: Provider;

  /**
   * Resolve a provider by ID. Returns the default provider when called
   * without arguments. Providers are cached per (id, apiKey) pair.
   */
  readonly resolveProvider: (providerId?: ProviderId) => Provider;

  /**
   * Resolve the default model for a provider. Returns the default
   * provider's model when called without arguments.
   */
  readonly resolveDefaultModel: (providerId?: ProviderId) => string;

  /**
   * Send a message and get a response.
   *
   * Full pipeline:
   *   1. Load/create session
   *   2. Build system prompt (from prompt documents + identity + context)
   *   3. Recall relevant memories
   *   4. Call LLM provider (streaming or non-streaming)
   *   5. Capture memories from exchange
   *   6. Persist session with new messages
   *   7. Push response to connected clients (if realtime enabled)
   *
   * @param request - The user's message and context.
   * @param onStream - Optional callback for streaming events.
   * @returns The completed response.
   */
  send(request: SendRequest, onStream?: StreamCallback): Promise<SendResponse>;

  /**
   * List sessions for a user.
   */
  listSessions(
    userId: string,
    agentId?: string,
    opts?: { limit?: number },
  ): Promise<SessionSummary[]>;

  /**
   * Get full session history.
   */
  getSession(userId: string, sessionId: string): Promise<Session | null>;

  /**
   * Delete a session.
   */
  deleteSession(userId: string, sessionId: string): Promise<boolean>;

  /**
   * Get messages for a session from the messages container.
   */
  getSessionMessages(
    userId: string,
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<MessageDocument[]>;

  /**
   * Seed default prompt documents for a new user.
   * Called automatically on first send, but can be called explicitly.
   */
  seedUser(userId: string, agentId?: string): Promise<void>;

  /**
   * Get aggregated usage summary for a user.
   */
  getUsageSummary(
    userId: string,
    opts?: { from?: string; to?: string },
  ): Promise<UsageSummary>;

  /**
   * Get individual usage records for a user.
   */
  getUsageRecords(
    userId: string,
    opts?: { from?: string; to?: string; limit?: number },
  ): Promise<UsageRecord[]>;
}
