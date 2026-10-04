/**
 * AgentForEach Gateway — Client events
 *
 * What a connected client sends over its realtime connection (protocol v1
 * `event` frames on the client hub), handled the same whatever carries it:
 * Web PubSub's upstream webhook (ws-message.ts) or a socket the platform
 * holds itself. The transport authenticates the connection and passes the
 * user, the connection and the event's data; the reply goes back to that
 * connection as a `from: "server"` message.
 *
 * Client message format (JSON):
 *   { type: "chat", message: string, sessionId?: string, model?: string }
 *   { type: "input_response", requestId: string, data?: {...}, cancelled?: boolean }
 *   { type: "abort" }
 *   { type: "ping" }
 */

import { openScope, type HandlerContext, type HttpResult, type HubEventHandler } from "@agentforeach/platform";
import { durable } from "../runtime/durable.js";
import { HITL_INPUT_EVENT } from "../hitl/types.js";
import { getAgentClient } from "../shared.js";
import { sendEventToUser, EVENTS } from "../websocket/index.js";
import { abortActiveRequest, type SharedAbortStore } from "./active-request-store.js";
import {
  loadAttachmentConfig,
  validateAttachments,
} from "../attachments/index.js";
import { INVALID_SESSION_ID_MESSAGE, isValidSessionId } from "../sessions/ids.js";
import { isModelAllowed } from "../llms/model-policy.js";
import { resolveDefaultProviderId } from "../llms/config.js";
import { authorizeHitlResponse, getHitlStore } from "../hitl/authorize.js";
import {
  backgroundTurnsEnabled,
  chatTurnIds,
  executeChatTurn,
  HTTP_RUN_DEADLINE_MS,
  refuseIfRateLimited,
  startChatTurn,
  type ChatTurnRequest,
} from "./chat-turn.js";
import { redactId } from "../utils/redact.js";

const RETURN_ERROR_DETAILS =
  (process.env.AGENTFOREACH_RETURN_ERROR_DETAILS ?? "").toLowerCase() === "true";

function toErrorParts(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: typeof err === "string" ? err : JSON.stringify(err) };
}

// ============================================================================
// Client Message Types
// ============================================================================

interface ClientChatMessage {
  type: "chat";
  message: string;
  sessionId?: string;
  idempotencyKey?: string;
  model?: string;
  providerId?: string;
  temperature?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  userTimezone?: string;
  /** Base64-encoded attachments — images for vision, documents for extraction. */
  attachments?: Array<{ mimeType: string; base64: string; fileName?: string }>;
}

interface ClientPingMessage {
  type: "ping";
}

interface ClientInputResponseMessage {
  type: "input_response";
  /** Matches the requestId from the input_request event. */
  requestId: string;
  /** User-provided data matching the form schema. */
  data?: Record<string, unknown>;
  /** True if the user dismissed/cancelled the form. */
  cancelled?: boolean;
}

interface ClientAbortMessage {
  type: "abort";
}

type ClientMessage = ClientChatMessage | ClientPingMessage | ClientInputResponseMessage | ClientAbortMessage;

const MAX_CHAT_MESSAGE_CHARS = Number.parseInt(
  process.env.CHAT_MAX_MESSAGE_CHARS ?? "",
  10,
);
const MAX_WS_PAYLOAD_BYTES = Number.parseInt(
  process.env.WS_MAX_PAYLOAD_BYTES ?? "",
  10,
);
const VALID_REASONING_EFFORT = new Set(["none", "low", "medium", "high"]);
const VALID_PROVIDER_IDS = new Set(["openai", "anthropic"]);
// Attachment limits and format rules live in the attachments module, shared
// with the REST handler.

const EFFECTIVE_MAX_CHAT_MESSAGE_CHARS =
  Number.isFinite(MAX_CHAT_MESSAGE_CHARS) && MAX_CHAT_MESSAGE_CHARS > 0
    ? MAX_CHAT_MESSAGE_CHARS
    : 8000;
// Default raised from 32KB to 4MB to accommodate base64 image attachments.
// Note this caps the whole frame, so it sits below the attachment module's
// document limits — large documents need the REST path, or a raised
// WS_MAX_PAYLOAD_BYTES if this transport ever carries them.
const EFFECTIVE_MAX_WS_PAYLOAD_BYTES =
  Number.isFinite(MAX_WS_PAYLOAD_BYTES) && MAX_WS_PAYLOAD_BYTES > 0
    ? MAX_WS_PAYLOAD_BYTES
    : 4 * 1024 * 1024;

// ============================================================================
// Client Event Handler
// ============================================================================

/** One client event, as the transport received it. */
export type ClientEventInput = {
  /** The authenticated user the connection belongs to. */
  userId: string;
  connectionId: string;
  /** The client's IANA timezone, if the transport carries one. */
  timezone?: string;
  /** The event's data (a JSON client message), read when needed. */
  text: () => Promise<string>;
};

/**
 * Handles one client event. The result's body is the reply to send back to
 * the connection; its status says how it went (400 for a bad message, 413
 * when too large, 500 after an error that was also pushed to the user).
 */
export async function handleClientEvent(
  input: ClientEventInput,
  context: HandlerContext,
): Promise<HttpResult> {
  const { userId } = input;
  try {
    const body = await input.text();
    if (Buffer.byteLength(body, "utf8") > EFFECTIVE_MAX_WS_PAYLOAD_BYTES) {
      return {
        status: 413,
        body: JSON.stringify({ error: "Payload too large" }),
      };
    }
    const msg = JSON.parse(body) as ClientMessage | null;
    if (
      !msg ||
      typeof msg !== "object" ||
      typeof (msg as { type?: unknown }).type !== "string"
    ) {
      return {
        status: 400,
        body: JSON.stringify({ error: "Invalid message payload" }),
      };
    }

    switch (msg.type) {
      case "ping":
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "pong", ts: Date.now() }),
        };

      case "chat":
        return await handleChat(userId, msg, context, input.timezone);

      case "input_response":
        return await handleInputResponse(userId, msg as ClientInputResponseMessage, context);

      case "abort":
        return await handleAbort(userId, context);

      default:
        return {
          status: 400,
          body: JSON.stringify({ error: `Unknown message type` }),
        };
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        status: 400,
        body: JSON.stringify({ error: "Invalid JSON payload" }),
      };
    }
    const { message, stack } = toErrorParts(err);
    const errorId = context.invocationId;
    context.error(
      `wsMessage failed errorId=${errorId} user=${redactId(userId)} msg=${message}`,
    );
    if (stack) context.error(stack);

    // Push error to the user's connected clients
    try {
      await sendEventToUser(userId, "error", {
        error: "Internal error",
        errorId,
        details: RETURN_ERROR_DETAILS ? message : undefined,
      });
    } catch {
      // Non-fatal push failure
    }

    return {
      status: 500,
      body: JSON.stringify({
        error: "Internal error",
        errorId,
        details: RETURN_ERROR_DETAILS ? message : undefined,
      }),
    };
  }
}

// ============================================================================
// Chat Handler
// ============================================================================

async function handleChat(
  userId: string,
  msg: ClientChatMessage,
  context: HandlerContext,
  requestTimezone?: string,
): Promise<HttpResult> {
  if (!msg.message?.trim()) {
    return {
      status: 400,
      body: JSON.stringify({ error: "Empty message" }),
    };
  }
  if (msg.message.length > EFFECTIVE_MAX_CHAT_MESSAGE_CHARS) {
    return {
      status: 413,
      body: JSON.stringify({
        error: `Message exceeds max length (${EFFECTIVE_MAX_CHAT_MESSAGE_CHARS} chars)`,
      }),
    };
  }
  if (msg.sessionId !== undefined && !isValidSessionId(msg.sessionId)) {
    return {
      status: 400,
      body: JSON.stringify({ error: INVALID_SESSION_ID_MESSAGE }),
    };
  }
  if (msg.providerId && !VALID_PROVIDER_IDS.has(msg.providerId)) {
    return {
      status: 400,
      body: JSON.stringify({ error: "Unsupported providerId" }),
    };
  }
  if (
    msg.model !== undefined &&
    (typeof msg.model !== "string" ||
      !isModelAllowed(msg.providerId ?? resolveDefaultProviderId(), msg.model))
  ) {
    return {
      status: 400,
      body: JSON.stringify({ error: "Model is not allowed" }),
    };
  }
  if (msg.reasoningEffort && !VALID_REASONING_EFFORT.has(msg.reasoningEffort)) {
    return {
      status: 400,
      body: JSON.stringify({ error: "Invalid reasoningEffort" }),
    };
  }
  if (
    typeof msg.temperature === "number" &&
    (!Number.isFinite(msg.temperature) ||
      msg.temperature < 0 ||
      msg.temperature > 2)
  ) {
    return {
      status: 400,
      body: JSON.stringify({ error: "temperature must be between 0 and 2" }),
    };
  }
  if (msg.attachments) {
    const validation = validateAttachments(
      msg.attachments,
      loadAttachmentConfig(),
    );
    if (validation.error) {
      return {
        status: validation.error.statusCode,
        body: JSON.stringify({ error: validation.error.message }),
      };
    }
  }

  const { runId, instanceId, newSessionId } = chatTurnIds(userId, msg.idempotencyKey);
  const turn: ChatTurnRequest = {
    runId,
    userId,
    message: msg.message,
    sessionId: msg.sessionId,
    idempotencyKey: msg.idempotencyKey,
    model: msg.model,
    providerId: msg.providerId as "openai" | "anthropic" | undefined,
    temperature: msg.temperature,
    reasoningEffort: msg.reasoningEffort,
    userTimezone: msg.userTimezone?.trim() || requestTimezone,
    channelName: "push",
    attachments: msg.attachments,
  };

  // The reply always travels over the socket, so the upstream call from Web
  // PubSub only needs to hand the turn off (see chat-turn.ts).
  if (backgroundTurnsEnabled()) {
    const refused = await refuseIfRateLimited(userId, "push");
    if (refused) {
      await sendEventToUser(userId, EVENTS.CHAT, {
        state: "error",
        runId,
        sessionId: msg.sessionId,
        error: refused.message,
        code: "rate_limited",
        retryable: true,
        retryAfterSeconds: refused.retryAfterSeconds,
      }).catch(() => {});
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, ...refused }),
      };
    }
    turn.sessionId ??= newSessionId;
    turn.rateLimitChecked = true;
    turn.acceptedAtMs = Date.now();
    const { duplicate } = await startChatTurn(instanceId, turn);
    context.log(
      `chat: accepted user=${redactId(userId)} run=${runId}` + (duplicate ? " (duplicate of a running turn)" : ""),
    );
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, accepted: true, runId, sessionId: turn.sessionId }),
    };
  }

  // Azure's front end drops HTTP requests after 230 s.
  const response = await executeChatTurn(context, turn, Date.now() + HTTP_RUN_DEADLINE_MS);
  if (!response) {
    context.log(`chat: user=${redactId(userId)} — aborted by client`);
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, aborted: true }),
    };
  }
  context.log(
    `chat: user=${redactId(userId)} session=${redactId(response.sessionId)} ` +
      `model=${response.model} duration=${response.durationMs}ms`,
  );
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true }),
  };
}

// ============================================================================
// Abort Handler
// ============================================================================

/**
 * Handle an "abort" message from the client.
 *
 * Signals the active AbortController for this user (if any), which
 * propagates through to the LLM provider call causing it to terminate.
 * Also pushes an "aborted" event to the user's connected clients so
 * the UI can clear streaming indicators.
 */
async function handleAbort(
  userId: string,
  context: HandlerContext,
): Promise<HttpResult> {
  const didAbort = abortActiveRequest(userId);
  if (didAbort) {
    context.log(`[abort] Aborting active request for user=${redactId(userId)}`);
  } else {
    context.log(`[abort] No active request on this instance for user=${redactId(userId)} — sending aborted event anyway`);
  }

  // Always write the shared marker too: the run may be executing on a
  // different function instance, where only the store can reach it.
  try {
    const client = await getAgentClient();
    const abortStore = (client as unknown as { _abortStore?: SharedAbortStore })
      ._abortStore;
    await abortStore?.requestAbort(userId);
  } catch (err) {
    context.warn(`[abort] Failed to write shared abort marker: ${err}`);
  }

  // Always push the aborted event so the client clears its UI state,
  // even if the controller wasn't found (e.g., multi-instance scenario).
  sendEventToUser(userId, EVENTS.CHAT, {
    state: "aborted",
  }).catch(() => { /* non-fatal */ });

  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, aborted: true }),
  };
}

// ============================================================================
// Input Response Handler (HITL)
// ============================================================================

/**
 * Handle an input_response message from the client.
 *
 * When the runner paused for human input, it started a durable wait that is
 * sleeping until the "hitl_input_response" event or its timeout.
 * This handler:
 *   1. Validates the requestId
 *   2. Signals the wait with the answer
 *   3. The wait wakes up and resumes the run (in a new invocation)
 *
 * The key insight: this handler does NOT resume the runner directly.
 * It simply signals the durable wait, which handles resumption.
 * This keeps the handler fast and stateless.
 */
async function handleInputResponse(
  userId: string,
  msg: ClientInputResponseMessage,
  context: HandlerContext,
): Promise<HttpResult> {
  if (!msg.requestId || typeof msg.requestId !== "string") {
    return {
      status: 400,
      body: JSON.stringify({ error: "Missing or invalid requestId" }),
    };
  }

  const orchestrationId = `hitl-${msg.requestId}`;
  const notFound = {
    status: 404,
    body: JSON.stringify({
      error: "No pending input request with this ID (may have timed out)",
    }),
  };

  try {
    // Only the owner of a pending request may answer it: the answer resumes
    // the run as that user, with this data merged into the tool call.
    const hitlStore = getHitlStore(await getAgentClient());
    if (!hitlStore) {
      context.error("[hitl] input_response received but the HITL store isn't configured");
      return { status: 503, body: JSON.stringify({ error: "Input requests are not available" }) };
    }
    if (!(await authorizeHitlResponse(hitlStore, msg.requestId, userId))) {
      context.warn(`[hitl] input_response for request ${msg.requestId}: not this user's, or not pending`);
      return notFound;
    }

    const raised = await raiseHitlInputResponse(context, orchestrationId, {
      requestId: msg.requestId,
      data: msg.data ?? {},
      cancelled: msg.cancelled ?? false,
    });
    if (!raised) return notFound;

    context.log(
      `[hitl] Raised input_response for user=${redactId(userId)} request=${msg.requestId}`,
    );

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    const { message } = toErrorParts(err);
    context.error(
      `[hitl] Failed to raise input_response for request=${msg.requestId}: ${message}`,
    );
    return {
      status: 500,
      body: JSON.stringify({
        error: "Failed to deliver input response",
        details: RETURN_ERROR_DETAILS ? message : undefined,
      }),
    };
  }
}

// ============================================================================
// Realtime hubs the platform runs itself
// ============================================================================

/**
 * Client events from a realtime hub the platform runs itself (Cloudflare's
 * UserSocket objects), as Web PubSub's upstream delivers them: each event
 * is one invocation, in its own scope, and a 2xx result's body is the reply
 * to the connection. Any other result fails the event (an
 * `InternalServerError` ack carrying the body).
 *
 * @param keepAlive - What keeps background work alive (`ctx.waitUntil`).
 */
export function realtimeClientEvents(keepAlive?: (work: Promise<unknown>) => void): HubEventHandler {
  return async (event) => {
    const invocationId = crypto.randomUUID();
    const opened = openScope({ invocationId, kind: "http", keepAlive });
    const context: HandlerContext = {
      invocationId,
      log: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
      trace: (...args) => console.debug(...args),
    };
    try {
      const text = async (): Promise<string> =>
        event.dataType === "text" && typeof event.data === "string" ? event.data : JSON.stringify(event.data ?? null);
      const result = await opened.run(() =>
        handleClientEvent({ userId: event.userId, connectionId: event.connectionId, text }, context),
      );
      const status = result.status ?? 200;
      const body = result.body ?? "";
      if (status < 200 || status >= 300) throw new Error(body || `Client event failed with ${status}`);
      if (!body) return {};
      try {
        return { reply: JSON.parse(body) as unknown };
      } catch {
        return { reply: body };
      }
    } finally {
      void opened.settle();
    }
  };
}

// ============================================================================
// Durable work
// ============================================================================
//
// A chat turn starts as a durable job (startChatTurn, chat-turn.ts); a HITL
// answer is the event its wait is waiting for.

/**
 * Delivers the HITL input response to the wait for it. False when that wait
 * isn't running (timed out, or never started).
 */
async function raiseHitlInputResponse(
  context: HandlerContext,
  orchestrationId: string,
  response: { requestId: string; data: Record<string, unknown>; cancelled: boolean },
): Promise<boolean> {
  const delivered = await durable().signal(orchestrationId, HITL_INPUT_EVENT, response);
  if (!delivered) context.warn(`[hitl] Orchestration ${orchestrationId} not running`);
  return delivered;
}
