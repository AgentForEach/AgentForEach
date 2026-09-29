/**
 * AgentForEach HITL (Human-in-the-Loop) Module — Types
 *
 * Type definitions for the human-in-the-loop system that allows
 * the agent runner to pause mid-tool-loop, request structured input
 * from the user (via a form/popup in the client app), and resume
 * execution once the user responds.
 *
 * Architecture:
 *   - The runner detects that a tool call needs human input (via config)
 *   - It saves its state (HitlRunState) to Cosmos DB and returns
 *   - A Durable Functions orchestrator waits for the user's response
 *     via waitForExternalEvent() — the Azure Function is NOT held open
 *   - When the user responds, the orchestrator resumes the runner
 *     with the user's data merged into the tool args
 *
 * Config-driven:
 *   All HITL behaviour is defined in agentforeach.json "hitl" section.
 *   Built-in form types are always available. Named forms and
 *   tool-to-form mappings are user-defined — no code changes needed
 *   to add HITL for a new MCP server.
 *
 * Wire protocol:
 *   Server → Client:  ChatInputRequestPayload  (via EVENTS.CHAT)
 *   Client → Server:  ClientInputResponseMessage (via WS upstream)
 *
 * @see ../websocket/types.ts — ChatEventPayload union
 * @see ./config.ts — agentforeach.json loader
 */

// ============================================================================
// Form Types — Built-in form type taxonomy
// ============================================================================

/**
 * Built-in form types the client must support.
 *
 * The LLM only needs to know the form type or named form — the client
 * resolves the actual rendering from formType + schema + uiHints.
 *
 *   - "text_input"         — Single text field (prompt + optional placeholder)
 *   - "confirmation"       — Yes/No with preview of proposed args
 *   - "single_select"      — Pick one from a list of options
 *   - "multi_select"       — Pick multiple from a list of options
 *   - "form"               — Full JSON Schema form (custom layout, groups, etc.)
 *
 * A client that renders extra widgets declares them under
 * "hitl.customFormTypes" in agentforeach.json; request_user_input offers those
 * names to the model and forwards them as the formType string unchanged.
 */
/** The built-in form types, plus any configured in `hitl.customFormTypes`. */
export type HitlFormType =
  | "text_input"
  | "confirmation"
  | "single_select"
  | "multi_select"
  | "form"
  | (string & {});

// ============================================================================
// Form Definitions — Named forms from config
// ============================================================================

/**
 * A named form definition from agentforeach.json "hitl.forms".
 *
 * Users define these to describe custom input forms (e.g., "create_contact",
 * "choose_priority") without code changes. Tool policies reference
 * them by name.
 */
export interface HitlFormDefinition {
  /** The form's name (key in the forms map). */
  name: string;

  /** Human-readable title shown in the form header. */
  title: string;

  /** Optional description shown below the title. */
  description?: string;

  /** The built-in form type to use for rendering. */
  formType: HitlFormType;

  /**
   * JSON Schema for the form fields.
   * Used when formType is "form" or to override MCP tool inputSchema.
   * Omit for simple types (text_input, confirmation, single/multi_select).
   */
  schema?: Record<string, unknown>;

  /** UI rendering hints (layout, grouping, field visibility). */
  uiHints?: HitlUiHints;

  /**
   * Pre-defined options for single_select / multi_select form types.
   * When present, the client renders these as the choice list.
   * When absent, options come from the LLM's proposedArgs.
   */
  options?: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
}

// ============================================================================
// Tool Policy Config — Resolved from agentforeach.json
// ============================================================================

/**
 * Resolved tool HITL policy (from agentforeach.json "hitl.tools").
 *
 * Maps a tool name/pattern to a gate mode and optional form definition.
 */
export interface HitlToolPolicyConfig {
  /** Tool name or glob pattern (e.g., "example_*"). */
  toolPattern: string;

  /**
   * When to gate for human input:
   *   - "always"            — always show the form
   *   - "when_args_missing" — show if required fields are missing
   *   - "confirm_only"      — show confirmation with proposed args
   *   - "never"             — never gate (explicit opt-out)
   */
  gate: "always" | "when_args_missing" | "confirm_only" | "never";

  /** The built-in form type to use. */
  formType: HitlFormType;

  /** Reference to a named form (from hitl.forms). */
  formName?: string;

  /** The resolved form definition (populated at config load time). */
  resolvedForm?: HitlFormDefinition;

  /** Intent template with {argName} placeholders. */
  intentTemplate?: string;

  /** Timeout in seconds for waiting on user response. */
  timeoutSeconds?: number;

  /** Schema override (takes precedence over form schema and MCP schema). */
  schemaOverride?: Record<string, unknown>;

  /** UI hints (merged: tool-level overrides form-level). */
  uiHints?: HitlUiHints;
}

// ============================================================================
// UI Hints
// ============================================================================

/**
 * UI rendering hints sent to the client alongside the form schema.
 * These are suggestions — the client can ignore them if its UI
 * doesn't support the requested layout.
 */
export interface HitlUiHints {
  /** Form layout style. */
  layout?: "single-column" | "two-column" | "wizard";

  /** Group related fields under labeled sections. */
  groups?: Array<{ label: string; fields: string[] }>;

  /**
   * Fields the LLM already filled with confidence.
   * Client shows these as pre-filled (editable) to reduce user effort.
   */
  prefilledFields?: string[];

  /**
   * Fields that critically need human input.
   * Client highlights these (e.g., red asterisk, focus first).
   */
  requiredFromHuman?: string[];

  /**
   * Fields to hide from the form entirely.
   * Useful for internal fields (userId, documentId) that the
   * LLM fills but the human shouldn't see.
   */
  hiddenFields?: string[];
}

// ============================================================================
// Input Request — Server → Client
// ============================================================================

/**
 * Payload pushed to the client when a tool call needs human input.
 * Sent as a CHAT event with state "input_request".
 */
export interface InputRequest {
  /** Unique ID to correlate the response. */
  requestId: string;

  /** The run that spawned this request. */
  runId: string;

  /** Session context. */
  sessionId: string;

  /** User who must respond. */
  userId: string;

  /** The MCP tool name that triggered this. */
  toolName: string;

  /** The tool call ID from the LLM response (for feeding results back). */
  toolCallId: string;

  /** Human-readable description of what the AI is trying to do. */
  intent: string;

  /**
   * The form type the client should render.
   * One of the built-in types: text_input, confirmation, single_select,
   * multi_select, form.
   */
  formType: HitlFormType;

  /**
   * Optional named form reference (from hitl.forms config).
   * The client can use this to look up additional rendering instructions
   * or map to a client-specific component.
   */
  formName?: string;

  /** LLM-proposed tool arguments (pre-filled defaults for the form). */
  proposedArgs: Record<string, unknown>;

  /** JSON Schema describing the form fields. */
  schema: Record<string, unknown>;

  /** UI rendering hints for the client. */
  uiHints?: HitlUiHints;

  /**
   * Pre-defined options for single_select / multi_select forms.
   * When present, client renders these as the choice list.
   */
  options?: Array<{
    label: string;
    value: string;
    description?: string;
  }>;

  /** Timeout in seconds — client should show a countdown. */
  timeoutSeconds: number;
}

// ============================================================================
// Input Response — Client → Server
// ============================================================================

/**
 * Response from the client when the user submits/cancels an input form.
 */
export interface InputResponse {
  /** Matches the requestId from the InputRequest. */
  requestId: string;

  /** User-provided data matching the schema. */
  data: Record<string, unknown>;

  /** True if the user cancelled / dismissed the form. */
  cancelled: boolean;
}

// ============================================================================
// Run State — Serializable snapshot for Durable Functions
// ============================================================================

/**
 * Serializable snapshot of the runner's state at the point where
 * it paused for human input.
 *
 * Persisted to Cosmos DB so the runner can be resumed in a new
 * Azure Function invocation after the user responds.
 */
export interface HitlRunState {
  /** Unique ID for this HITL interaction. */
  requestId: string;

  /** How long the request waits for the user; the stored state outlives it. */
  timeoutSeconds?: number;

  /** The Durable Functions orchestration instance ID. */
  orchestrationId: string;

  /** The original SendRequest (minus non-serializable fields). */
  originalRequest: SerializableSendRequest;

  /** The run ID. */
  runId: string;

  /** Session ID. */
  sessionId: string;

  /** Current tool loop round number. */
  toolRound: number;

  /** The function call from the LLM that triggered HITL. */
  pendingToolCall: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  };

  /**
   * Other function calls from the same LLM response that were
   * already executed (or are executing in parallel).
   * These don't need re-execution on resume.
   */
  completedToolResults: Array<{
    callId: string;
    output: string;
  }>;

  /**
   * Other function calls that should execute independently
   * (not HITL-gated). These are handled in the non-HITL path.
   */
  independentToolCalls: Array<{
    callId: string;
    name: string;
    arguments: string;
  }>;

  /**
   * Diagnostic snapshot of the LLM conversation state at the moment HITL
   * was triggered. Stored for audit / debugging purposes only.
   *
   * **NOT used for functional resumption.** The session's own
   * `conversationState` (managed by the shared SessionStore) is the
   * authoritative source for conversation threading (previousResponseId,
   * containerId). The resume path clears the session's conversationState
   * because the HITL interruption breaks the Responses API chain (the
   * last chained response has an unresolved tool call).
   */
  conversationState: {
    previousResponseId?: string;
    containerId?: string;
    messages?: unknown[];
  };

  /** Provider and model used in this run. */
  providerId: string;
  model: string;

  /** Accumulated usage stats so far. */
  usage?: Record<string, unknown>;

  /** Timestamp when the HITL request was created. */
  createdAt: number;

  /** Status of the HITL request. */
  status: "pending" | "responded" | "cancelled" | "timed_out";
}

/**
 * SendRequest with non-serializable fields removed.
 * Safe for Cosmos DB / Durable Functions serialization.
 */
export interface SerializableSendRequest {
  userId: string;
  agentId?: string;
  message: string;
  sessionId?: string;
  idempotencyKey?: string;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  temperature?: number;
  channelName?: string;
  channelChatId?: string;
  isGroupChat?: boolean;
  groupName?: string;
  userTimezone?: string;
  metadata?: Record<string, string>;
  // Note: abortSignal, onCronMutation, attachments, _invocationContext are NOT serialized
}

// ============================================================================
// Durable Functions Event Names
// ============================================================================

/** External event name used by Durable Functions waitForExternalEvent(). */
export const HITL_INPUT_EVENT = "hitl_input_response";

/** Durable Functions orchestration name. */
export const HITL_ORCHESTRATION_NAME = "HitlAwaitInput";

/** Activity name for resuming the runner after user input. */
export const HITL_RESUME_ACTIVITY = "HitlResumeRun";

/** Activity name for pushing the input request to the client. */
export const HITL_PUSH_REQUEST_ACTIVITY = "HitlPushInputRequest";

/** Activity name for handling timeout (no LLM call — just cleanup + notify). */
export const HITL_TIMEOUT_ACTIVITY = "HitlTimeout";
