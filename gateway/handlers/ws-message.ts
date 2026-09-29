/**
 * AgentForEach Gateway — WebSocket Message Handler
 *
 * Handles Web PubSub CloudEvents "message" event — called when a client
 * sends a message through the WebSocket connection.
 *
 * Parses the client message, routes it through AgentClient.send(),
 * and streams the response back to the user via Web PubSub.
 *
 * Client message format (JSON):
 *   { type: "chat", message: string, sessionId?: string, model?: string }
 *
 */

import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import * as df from "durable-functions";
import { getAgentClient } from "../shared.js";
import { sendEventToUser, EVENTS } from "../websocket/index.js";
import { abortActiveRequest, type SharedAbortStore } from "./active-request-store.js";
import {
  verifyCloudEventHeaders,
  verifyUpstreamSecret,
} from "./ws-security.js";
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
// Abuse Protection
// ============================================================================

function handleAbuseProtection(request: HttpRequest): HttpResponseInit | null {
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("WebHook-Request-Origin");
    return {
      status: 200,
      headers: { "WebHook-Allowed-Origin": origin ?? "*" },
    };
  }
  return null;
}

// ============================================================================
// WebSocket Message Handler
// ============================================================================

async function wsMessage(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const abuse = handleAbuseProtection(request);
  if (abuse) return abuse;
  const upstream = verifyUpstreamSecret(request);
  if (upstream) return upstream;
  const cloudEvent = verifyCloudEventHeaders(request);
  if (cloudEvent) return cloudEvent;

  const connectionId =
    request.headers.get("ce-connectionId") ??
    request.headers.get("ce-connectionid");
  const userId =
    request.headers.get("ce-userId") ?? request.headers.get("ce-userid");
  const requestTimezone =
    request.headers.get("x-user-timezone")?.trim() || undefined;

  if (!connectionId || !userId) {
    return {
      status: 401,
      body: JSON.stringify({ error: "Missing user identity" }),
    };
  }

  context.log(
    `wsMessage start id=${context.invocationId} user=${redactId(userId)} conn=${connectionId} tz=${requestTimezone ?? ""}`.trim(),
  );

  try {
    const body = await request.text();
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
        return await handleChat(userId, msg, context, requestTimezone);

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
  context: InvocationContext,
  requestTimezone?: string,
): Promise<HttpResponseInit> {
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
    const { duplicate } = await startChatTurn(context, instanceId, turn);
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
  context: InvocationContext,
): Promise<HttpResponseInit> {
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
 * When the runner paused for human input, it started a Durable Functions
 * orchestrator that is sleeping on waitForExternalEvent("hitl_input_response").
 * This handler:
 *   1. Validates the requestId
 *   2. Raises the external event on the orchestration instance
 *   3. The orchestration wakes up and resumes the run (in a new invocation)
 *
 * The key insight: this handler does NOT resume the runner directly.
 * It simply signals the Durable orchestrator, which handles resumption.
 * This keeps the handler fast and stateless.
 */
async function handleInputResponse(
  userId: string,
  msg: ClientInputResponseMessage,
  context: InvocationContext,
): Promise<HttpResponseInit> {
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

    const durableClient = df.getClient(context);

    // Check that the orchestration exists and is running
    const status = await durableClient.getStatus(orchestrationId);
    if (!status || !["Running", "Pending"].includes(status.runtimeStatus ?? "")) {
      context.warn(
        `[hitl] Orchestration ${orchestrationId} not running (status=${status?.runtimeStatus ?? "not-found"})`,
      );
      return notFound;
    }

    // Raise the event — the orchestration wakes up and processes the input
    await durableClient.raiseEvent(
      orchestrationId,
      "hitl_input_response",
      {
        requestId: msg.requestId,
        data: msg.data ?? {},
        cancelled: msg.cancelled ?? false,
      },
    );

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
// Function Registration
// ============================================================================

app.http("wsMessage", {
  methods: ["GET", "OPTIONS", "POST"],
  authLevel: "anonymous",
  route: "ws/message",
  extraInputs: [df.input.durableClient()],
  handler: wsMessage,
});
