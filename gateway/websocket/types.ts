/**
 * AgentForEach Real-Time System — Wire Protocol Types
 *
 * Defines the frame protocol for WebSocket communication between
 * AgentForEach's serverless backend and clients (iOS, Android, Web).
 *
 * A 3-frame discriminated union:
 *   - RequestFrame  (client → server)
 *   - ResponseFrame (server → client)
 *   - EventFrame    (server → client, push)
 *
 * There is no self-hosted WS server: Azure Web PubSub handles
 * connection management, and frames are
 * the application-level protocol on top of it.
 *
 * Protocol version is tracked to allow client/server evolution
 * without breaking older clients.
 *
 * @see docs/Architecture.md#real-time-protocol
 */

import type { ClientAccess, ClientAccessOptions, RealtimeCapabilities, RealtimeProvider } from "@agentforeach/platform";

// ============================================================================
// Protocol Version
// ============================================================================

/** Current protocol version. Increment on breaking changes. */
export const PROTOCOL_VERSION = 1;

// ============================================================================
// WebSocket Provider Identity
// ============================================================================

/** Registered WebSocket provider identifiers. */
export type WebSocketProviderId = "azure-webpubsub" | "noop" | (string & {});

// ============================================================================
// WebSocket Provider Interface
// ============================================================================

/**
 * The gateway's real-time provider: the platform's realtime port
 * (`RealtimeProvider`: push, presence, client access, optional relay), plus
 * group and broadcast pushes that some providers offer. Nothing in the
 * gateway calls those today; the emitter refuses them on providers without.
 *
 * The rest of the codebase interacts only through this contract — never
 * with provider-specific SDKs directly.
 */
export interface WebSocketProvider extends Omit<RealtimeProvider, "id" | "capabilities"> {
  /** Unique identifier for this provider. */
  readonly id: WebSocketProviderId;
  readonly capabilities?: RealtimeCapabilities;
  /** Human-readable label. */
  readonly label?: string;
  /** Send an event frame to all clients in a group. */
  sendToGroup?(group: string, frame: Frame): Promise<void>;
  /** Broadcast an event frame to ALL connected clients. */
  sendToAll?(frame: Frame): Promise<void>;
  /** Add a user to a group. */
  addUserToGroup?(userId: string, group: string): Promise<void>;
  /** Remove a user from a group. */
  removeUserFromGroup?(userId: string, group: string): Promise<void>;
}

/** Options for a client's access token. */
export type TokenGenerationOptions = ClientAccessOptions;

/**
 * Creates a provider from config. Factories may load their SDK lazily
 * (`await import(...)`), so a host that never uses a provider never bundles it.
 */
export type WebSocketProviderFactory = (
  config: WebSocketProviderConfig,
) => WebSocketProvider | Promise<WebSocketProvider>;

/**
 * Provider-agnostic configuration passed to the factory.
 */
export type WebSocketProviderConfig = {
  /** Connection string or URL for the provider. */
  connectionString: string;
  /** Hub / namespace / channel name. */
  hub: string;
  /** Additional provider-specific options. */
  options?: Record<string, unknown>;
};

// ============================================================================
// Frame Types (discriminated union)
// ============================================================================

/**
 * Client → Server request frame.
 *
 * Sent by iOS/Android/Web clients via Web PubSub's sendToGroup or
 * upstream event handler. The server responds with a matching ResponseFrame.
 */
export type RequestFrame = {
  type: "req";
  /** Unique request ID (UUID) — correlates with the response. */
  id: string;
  /** RPC method name (e.g., "chat.send", "cron.list"). */
  method: string;
  /** Method-specific params. */
  params?: unknown;
};

/**
 * Server → Client response frame.
 *
 * Sent by Azure Functions via Web PubSub's sendToUser() in reply
 * to a specific request.
 */
export type ResponseFrame = {
  type: "res";
  /** Matches the request ID. */
  id: string;
  /** Whether the request succeeded. */
  ok: boolean;
  /** Result payload on success. */
  payload?: unknown;
  /** Error details on failure. */
  error?: FrameError;
};

/**
 * Server → Client event frame (push).
 *
 * Pushed to clients without a prior request. Used for:
 *   - LLM streaming (agent/chat events)
 *   - Cron job results
 *   - Presence changes
 *   - System notifications
 */
export type EventFrame = {
  type: "event";
  /** Event name (e.g., "agent", "chat", "cron", "presence"). */
  event: string;
  /** Event-specific payload. */
  payload?: unknown;
  /** Monotonic sequence number for gap detection. */
  seq?: number;
};

/** The union of all frame types. */
export type Frame = RequestFrame | ResponseFrame | EventFrame;

// ============================================================================
// Error Shape
// ============================================================================

export type FrameError = {
  /** Machine-readable error code. */
  code: string;
  /** Human-readable error message. */
  message: string;
  /** Additional context. */
  details?: unknown;
  /** Whether the client should retry. */
  retryable?: boolean;
  /** Suggested retry delay in milliseconds. */
  retryAfterMs?: number;
};

// ============================================================================
// Event Names
// ============================================================================

/**
 * Well-known event names pushed by the server.
 *
 * Event names:
 *   - agent/chat:  LLM streaming (future — when chat goes through WS)
 *   - cron:        Cron job completed / failed
 *   - presence:    Connected devices changed
 *   - health:      System health snapshot
 *   - shutdown:    Server maintenance (graceful close)
 */
export const EVENTS = {
  /** LLM response streaming (lifecycle, assistant text, tool calls). */
  AGENT: "agent",
  /** Chat delta/final events (higher-level than agent). */
  CHAT: "chat",
  /** Cron job executed — result notification. */
  CRON: "cron",
  /** Connected client list changed. */
  PRESENCE: "presence",
  /** System health snapshot. */
  HEALTH: "health",
  /** Server shutting down. */
  SHUTDOWN: "shutdown",
  /** Memory added/updated notification. */
  MEMORY: "memory",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

// ============================================================================
// Groups (Web PubSub topic routing)
// ============================================================================

/**
 * Web PubSub groups for topic-based event filtering.
 *
 * Clients join groups based on what events they want to receive.
 *
 * Example: An iOS app joins "cron" and "chat" groups.
 * The server sends cron results to the "cron" group, chat events
 * to the "chat" group. The app receives both.
 */
export const GROUPS = {
  /** Cron job result notifications. */
  CRON: "cron",
  /** Chat / agent streaming events. */
  CHAT: "chat",
  /** Presence updates (who's connected). */
  PRESENCE: "presence",
  /** System health and admin events. */
  SYSTEM: "system",
  /** Memory layer change notifications. */
  MEMORY: "memory",
} as const;

export type GroupName = (typeof GROUPS)[keyof typeof GROUPS];

// ============================================================================
// Client Token Claims
// ============================================================================

/**
 * Claims embedded in a Web PubSub client access token.
 *
 * The server generates these tokens; clients present them
 * when connecting via WebSocket.
 */
export type ClientTokenClaims = {
  /** AgentForEach user ID — maps to Web PubSub userId. */
  userId: string;
  /** Client type identifier. */
  clientId: ClientId;
  /** Client platform. */
  platform: string;
  /** Client app version. */
  version: string;
  /** Groups the client is allowed to join. */
  groups: GroupName[];
  /** Role for authorization. */
  role: ClientRole;
};

// ============================================================================
// Client Types
// ============================================================================

/**
 * Known client identifiers.
 */
export type ClientId =
  | "agentforeach-ios"
  | "agentforeach-android"
  | "agentforeach-web"
  | "agentforeach-cli"
  | (string & {});

/**
 * Client roles for authorization.
 *
 * Two roles:
 *   - user:  standard user (chat, view cron, receive notifications)
 *   - admin: full access (config, system)
 */
export type ClientRole = "user" | "admin";

// ============================================================================
// Cron Event Payload
// ============================================================================

/**
 * Payload for EVENTS.CRON — pushed when a cron job completes.
 */
export type CronEventPayload = {
  jobId: string;
  jobName: string;
  userId: string;
  status: "ok" | "error" | "skipped" | "expired";
  summary?: string;
  error?: string;
  durationMs: number;
  model?: string;
  ts: number;
};

// ============================================================================
// Chat Event Payloads (future — for LLM streaming)
// ============================================================================

/**
 * Payload for EVENTS.CHAT — pushed during LLM response streaming.
 *
 * States flow:  thinking → (reasoning_delta | tool_start | tool_delta |
 *                tool_done | delta)* → final | error | aborted
 * A `heartbeat` may interleave anywhere in the flow on a fixed cadence.
 *
 * Clients that only care about text can filter on
 * `state === "thinking" | "delta" | "final" | "error"` and ignore the rest.
 */
export type ChatEventPayload =
  | ChatThinkingPayload
  | ChatHeartbeatPayload
  | ChatDeltaPayload
  | ChatReasoningDeltaPayload
  | ChatToolStartPayload
  | ChatToolDeltaPayload
  | ChatToolDonePayload
  | ChatProviderFallbackPayload
  | ChatDocumentsExtractedPayload
  | ChatInputRequestPayload
  | ChatInputExpiredPayload
  | ChatAbortedPayload
  | ChatFinalPayload
  | ChatErrorPayload;

export type ChatThinkingPayload = {
  state: "thinking";
  runId?: string;
  sessionId?: string;
};

/**
 * Liveness beacon pushed on a fixed cadence for the whole run.
 *
 * Long tool calls and slow reasoning legitimately produce 45s+ of socket
 * silence; client-side that silence is indistinguishable from a half-open
 * connection, so clients recycle the socket — and lose whatever the runner
 * pushes during the reconnect gap (Web PubSub does not replay). The
 * heartbeat turns liveness into a positive signal instead of an inference.
 * Clients that don't recognise the state simply ignore it.
 */
export type ChatHeartbeatPayload = {
  state: "heartbeat";
  runId?: string;
  sessionId?: string;
};

export type ChatDeltaPayload = {
  state: "delta";
  runId: string;
  sessionId: string;
  /** New text since the previous delta (several model deltas, coalesced). */
  delta: string;
  /**
   * Where `delta` starts in the reply. A client whose text is shorter missed
   * a frame (Web PubSub doesn't replay): keep going and let `final`, which
   * carries the full text, correct it.
   */
  offset: number;
};

export type ChatReasoningDeltaPayload = {
  state: "reasoning_delta";
  runId: string;
  sessionId: string;
  delta: string;
};

export type ChatToolStartPayload = {
  state: "tool_start";
  runId: string;
  sessionId: string;
  callId: string;
  toolType: string;
  name?: string;
};

export type ChatToolDeltaPayload = {
  state: "tool_delta";
  runId: string;
  sessionId: string;
  callId: string;
  delta: string;
};

export type ChatToolDonePayload = {
  state: "tool_done";
  runId: string;
  sessionId: string;
  callId: string;
};

export type ChatProviderFallbackPayload = {
  state: "provider_fallback";
  runId: string;
  sessionId: string;
  fromProvider: string;
  toProvider: string;
  reason: string;
};

export type ChatDocumentsExtractedPayload = {
  state: "documents_extracted";
  runId?: string;
  sessionId?: string;
  /** Names of the attached documents read into this turn's context. */
  fileNames: string[];
  count: number;
};

export type ChatFinalPayload = {
  state: "final";
  runId: string;
  sessionId: string;
  text: string;
  providerId: string;
  model: string;
  usage?: unknown;
  durationMs: number;
};

export type ChatErrorPayload = {
  state: "error";
  runId?: string;
  sessionId?: string;
  /** User-safe sentence describing what went wrong. */
  error: string;
  /**
   * Machine-readable cause, so the client can choose an affordance rather than
   * offering the same "retry" for every failure: `rate_limited`, `timeout`,
   * `provider_unavailable`, `model_unavailable`, `auth`, `context_length`,
   * `content_filtered`, `internal`.
   */
  code?: string;
  /** Whether sending the same message again has a reasonable chance. */
  retryable?: boolean;
};

/**
 * Pushed when the user aborts a running request.
 * The client should clear streaming indicators and show an
 * "aborted" notice.
 */
export type ChatAbortedPayload = {
  state: "aborted";
  runId?: string;
  sessionId?: string;
};

/**
 * Payload for EVENTS.CHAT — pushed when the runner needs human input
 * before executing an MCP tool. The client should display a form popup
 * and send back an input_response message.
 *
 * @see ../hitl/types.ts — InputRequest
 */
export type ChatInputRequestPayload = {
  state: "input_request";
  /** Unique ID to correlate the response. */
  requestId: string;
  runId: string;
  sessionId: string;
  /** The MCP tool that triggered this. */
  toolName: string;
  /** The tool call ID from the LLM response. */
  toolCallId: string;
  /** The type of form to render: text_input, confirmation, single_select, multi_select, form. */
  formType: import("../hitl/types.js").HitlFormType;
  /** Named form definition from agentforeach.json hitl.forms (if any). */
  formName?: string;
  /** Options for single_select / multi_select form types. */
  options?: Array<{ label: string; value: string; description?: string }>;
  /** Human-readable description of what the AI is trying to do. */
  intent: string;
  /** LLM-proposed tool arguments (pre-filled form defaults). */
  proposedArgs: Record<string, unknown>;
  /** JSON Schema describing the form fields. */
  schema: Record<string, unknown>;
  /** UI rendering hints for the client. */
  uiHints?: {
    layout?: "single-column" | "two-column" | "wizard";
    groups?: Array<{ label: string; fields: string[] }>;
    prefilledFields?: string[];
    requiredFromHuman?: string[];
    hiddenFields?: string[];
  };
  /** Timeout in seconds — client should show a countdown. */
  timeoutSeconds: number;
};

/**
 * Payload for EVENTS.CHAT — pushed when a HITL input request times out.
 * The client should dismiss the input form and show a brief notice.
 * No LLM call is made — the session is left as-is so the user can
 * continue naturally in their next message.
 *
 * @see ../hitl/types.ts — InputRequest
 */
export type ChatInputExpiredPayload = {
  state: "input_expired";
  /** The requestId that timed out (matches the original input_request). */
  requestId: string;
  runId: string;
  sessionId: string;
  /** Human-readable reason. */
  reason: string;
};

// ============================================================================
// Presence Payload
// ============================================================================

export type PresenceEntry = {
  userId: string;
  clientId: ClientId;
  platform: string;
  version: string;
  connectedAt: number;
};

export type PresencePayload = {
  entries: PresenceEntry[];
  stateVersion: number;
};

// ============================================================================
// Client Access Token
// ============================================================================

/** A client's WebSocket URL with its token (see `RealtimeProvider.clientAccess`). */
export type ClientAccessToken = ClientAccess;
