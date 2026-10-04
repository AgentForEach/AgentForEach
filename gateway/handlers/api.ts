/**
 * AgentForEach Gateway — HTTP API Handler
 *
 * REST API endpoints for clients that don't use WebSocket
 * (e.g., CLI tools, server-to-server, mobile quick actions).
 *
 * Endpoints:
 *   POST /api/chat              — Send a message and get a response
 *   POST /api/chat/abort        — Abort the current chat request
 *   GET  /api/sessions          — List user's sessions
 *   GET  /api/sessions/{id}     — Get a specific session
 *   DELETE /api/sessions/{id}   — Delete a session
 *   GET  /api/usage             — Aggregated usage summary
 *   GET  /api/usage/records     — Individual usage records
 *   POST /api/token             — Generate a WebSocket access token
 *   GET  /api/health            — Health check
 */

import { corsHeaders as sharedCorsHeaders, corsPolicy, type HandlerContext, type HttpRequestLike, type HttpResult, type RouteDef } from "@agentforeach/platform";
import { getAgentClient } from "../shared.js";
import { generateClientToken, getDefaultGroups } from "../websocket/index.js";
import { sendEventToUser, EVENTS } from "../websocket/index.js";
import { isAdmin, resolveAuthContext } from "../auth/index.js";
import {
  backgroundTurnsEnabled,
  chatTurnIds,
  executeChatTurn,
  HTTP_RUN_DEADLINE_MS,
  refuseIfRateLimited,
  startChatTurn,
  type ChatTurnRequest,
} from "./chat-turn.js";
import { ensureIdentityStore, getIdentityStore } from "../channels/index.js";
import { INVALID_SESSION_ID_MESSAGE, isValidSessionId } from "../sessions/ids.js";
import { isModelAllowed } from "../llms/model-policy.js";
import { resolveDefaultProviderId } from "../llms/config.js";
import {
  IdentityStore,
  TooManyPairingCodesError,
  authorizeLinkCreate,
  type LinkCreateBody,
} from "../identity/index.js";
import { abortActiveRequest, type SharedAbortStore } from "./active-request-store.js";
import {
  loadAttachmentConfig,
  validateAttachments,
} from "../attachments/index.js";
import { redactId } from "../utils/redact.js";

const MAX_CHAT_MESSAGE_CHARS = parsePositiveInt(
  process.env.CHAT_MAX_MESSAGE_CHARS,
  8000,
);
const VALID_REASONING_EFFORT = new Set(["none", "low", "medium", "high"]);
const VALID_PROVIDER_IDS = new Set(["openai", "anthropic"]);
// Attachment limits and format rules live in the attachments module, so this
// handler and the WebSocket handler can't drift apart on what they accept.

// When true, include the raw error message in responses (for local/dev only).
// Keep this OFF in production.
const RETURN_ERROR_DETAILS =
  (process.env.AGENTFOREACH_RETURN_ERROR_DETAILS ?? "").toLowerCase() === "true";

function toErrorParts(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: typeof err === "string" ? err : JSON.stringify(err) };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripCosmosInternals<T extends Record<string, unknown>>(doc: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (!key.startsWith("_")) {
      result[key] = value;
    }
  }
  return result as Partial<T>;
}

// ============================================================================
// CORS
// ============================================================================

/** CORS headers by the gateway's policy (CORS_ALLOWED_ORIGINS; see @agentforeach/platform's cors.ts). */
function corsHeaders(request: HttpRequestLike): Record<string, string> {
  return sharedCorsHeaders(corsPolicy(process.env.CORS_ALLOWED_ORIGINS), request.headers.get("origin"), {
    methods: "GET,POST,DELETE,OPTIONS",
    headers: "Content-Type, Authorization, x-user-id",
  });
}

// ============================================================================
// Auth Helper
// ============================================================================

function unauthorized(request: HttpRequestLike): HttpResult {
  return {
    status: 401,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Unauthorized" }),
  };
}

// ============================================================================
// POST /api/chat
// ============================================================================

async function apiChat(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);
  const userId = auth.userId;

  // Capture a minimal request summary for error logs.
  const requestMeta = {
    invocationId: context.invocationId,
    userId,
    method: request.method,
    route: "api/chat",
    tzHeader: request.headers.get("x-user-timezone")?.trim() || undefined,
  };

  context.log(
    `apiChat start id=${requestMeta.invocationId} user=${redactId(userId)} tz=${requestMeta.tzHeader ?? ""}`.trim(),
  );

  try {
    const body = (await request.json()) as {
      message: string;
      sessionId?: string;
      idempotencyKey?: string;
      model?: string;
      providerId?: string;
      temperature?: number;
      reasoningEffort?: "none" | "low" | "medium" | "high";
      userTimezone?: string;
      hitlInputResponse?: {
        requestId?: string;
        data?: Record<string, unknown>;
        cancelled?: boolean;
      };
      /** Base64-encoded attachments — images for vision, documents for extraction. */
      attachments?: Array<{
        mimeType: string;
        base64: string;
        fileName?: string;
      }>;
      /** Run the turn in this request and return the reply (default in local dev). */
      wait?: boolean;
    };

    if (!body.message?.trim()) {
      return {
        status: 400,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "message is required" }),
      };
    }
    if (body.message.length > MAX_CHAT_MESSAGE_CHARS) {
      return {
        status: 413,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          error: `message exceeds max length (${MAX_CHAT_MESSAGE_CHARS} chars)`,
        }),
      };
    }
    if (body.sessionId !== undefined && !isValidSessionId(body.sessionId)) {
      return {
        status: 400,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: INVALID_SESSION_ID_MESSAGE }),
      };
    }
    if (body.providerId && !VALID_PROVIDER_IDS.has(body.providerId)) {
      return {
        status: 400,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "unsupported providerId" }),
      };
    }
    if (
      body.model !== undefined &&
      (typeof body.model !== "string" ||
        !isModelAllowed(body.providerId ?? resolveDefaultProviderId(), body.model))
    ) {
      return {
        status: 400,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Model is not allowed" }),
      };
    }
    if (
      body.reasoningEffort &&
      !VALID_REASONING_EFFORT.has(body.reasoningEffort)
    ) {
      return {
        status: 400,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "invalid reasoningEffort" }),
      };
    }
    if (
      typeof body.temperature === "number" &&
      (!Number.isFinite(body.temperature) ||
        body.temperature < 0 ||
        body.temperature > 2)
    ) {
      return {
        status: 400,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "temperature must be between 0 and 2" }),
      };
    }
    if (body.attachments) {
      const validation = validateAttachments(
        body.attachments,
        loadAttachmentConfig(),
      );
      if (validation.error) {
        return {
          status: validation.error.statusCode,
          headers: {
            ...corsHeaders(request),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ error: validation.error.message }),
        };
      }
    }

    const userTimezone =
      body.userTimezone?.trim() ||
      request.headers.get("x-user-timezone")?.trim() ||
      undefined;

    const { runId, instanceId, newSessionId } = chatTurnIds(userId, body.idempotencyKey);
    const turn: ChatTurnRequest = {
      runId,
      userId,
      message: body.message,
      sessionId: body.sessionId,
      idempotencyKey: body.idempotencyKey,
      model: body.model,
      providerId: body.providerId as "openai" | "anthropic" | undefined,
      temperature: body.temperature,
      reasoningEffort: body.reasoningEffort,
      userTimezone,
      channelName: "web",
      attachments: body.attachments,
      hitlInputResponse: body.hitlInputResponse?.requestId
        ? {
            requestId: body.hitlInputResponse.requestId,
            data: body.hitlInputResponse.data,
            cancelled: body.hitlInputResponse.cancelled,
          }
        : undefined,
    };

    // Background: accept now, reply over Web PubSub (see chat-turn.ts).
    if (backgroundTurnsEnabled() && body.wait !== true) {
      const refused = await refuseIfRateLimited(userId, "web");
      if (refused) {
        return {
          status: 429,
          headers: {
            ...corsHeaders(request),
            "Content-Type": "application/json",
            "Retry-After": String(refused.retryAfterSeconds),
          },
          body: JSON.stringify(refused),
        };
      }
      turn.sessionId ??= newSessionId;
      turn.rateLimitChecked = true;
      turn.acceptedAtMs = Date.now();
      const { duplicate } = await startChatTurn(instanceId, turn);
      context.log(
        `apiChat accepted user=${redactId(userId)} run=${runId} session=${redactId(turn.sessionId)}` +
          (duplicate ? " (duplicate of a running turn)" : ""),
      );
      return {
        status: 202,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ runId, sessionId: turn.sessionId, status: "accepted", duplicate }),
      };
    }

    // Azure's front end drops HTTP requests after 230 s.
    const response = await executeChatTurn(context, turn, Date.now() + HTTP_RUN_DEADLINE_MS);
    if (!response) {
      context.log(`apiChat: user=${redactId(userId)} — aborted by client`);
      return {
        status: 200,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, aborted: true }),
      };
    }

    if (response.status === "aborted") {
      context.log(`apiChat: user=${redactId(userId)} — aborted by client`);
    } else {
      context.log(
        `apiChat: user=${redactId(userId)} session=${redactId(response.sessionId)} ` +
          `model=${response.model} duration=${response.durationMs}ms`,
      );
    }

    const refusedStatus =
      response.error === "RATE_LIMITED" ? 429 : response.error === "SESSION_BUSY" ? 409 : undefined;
    return {
      status: refusedStatus ?? 200,
      headers: {
        ...corsHeaders(request),
        "Content-Type": "application/json",
        ...(response.retryAfterSeconds ? { "Retry-After": String(response.retryAfterSeconds) } : {}),
      },
      body: JSON.stringify(response),
    };
  } catch (err) {
    const { message, stack } = toErrorParts(err);
    const errorId = context.invocationId;
    context.error(
      `apiChat failed errorId=${errorId} user=${redactId(userId)} msg=${message}`,
    );
    if (stack) {
      // Stack is valuable in logs but should not be returned to clients by default.
      context.error(stack);
    }

    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Internal error",
        errorId,
        details: RETURN_ERROR_DETAILS ? message : undefined,
      }),
    };
  }
}

// ============================================================================
// POST /api/chat/abort
// ============================================================================

async function apiChatAbort(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS") {
    return { status: 204, headers: corsHeaders(request) };
  }

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);

  const didAbort = abortActiveRequest(auth.userId);
  if (didAbort) {
    context.log(`[apiChatAbort] Aborting active request for user=${redactId(auth.userId)}`);
  } else {
    context.log(`[apiChatAbort] No active request on this instance for user=${redactId(auth.userId)}`);
  }

  // Always write the shared marker too: the run may be executing on a
  // different function instance, where only the store can reach it.
  try {
    const client = await getAgentClient();
    const abortStore = (client as unknown as { _abortStore?: SharedAbortStore })
      ._abortStore;
    await abortStore?.requestAbort(auth.userId);
  } catch (err) {
    context.warn(`[apiChatAbort] Failed to write shared abort marker: ${err}`);
  }

  try {
    await sendEventToUser(auth.userId, EVENTS.CHAT, { state: "aborted" });
  } catch {
    // Non-fatal
  }

  return {
    status: 200,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, aborted: didAbort }),
  };
}

// ============================================================================
// GET /api/sessions
// ============================================================================

async function apiSessions(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);
  const userId = auth.userId;

  try {
    const agentId = request.query.get("agentId") || undefined;
    const limitParam = request.query.get("limit");
    const limit = limitParam ? parsePositiveInt(limitParam, 50) : undefined;

    const client = await getAgentClient();
    const sessions = await client.listSessions(userId, agentId, { limit });

    return {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ sessions }),
    };
  } catch (err) {
    context.error("apiSessions error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// GET /api/sessions/{id}
// ============================================================================

async function apiSessionById(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);
  const userId = auth.userId;

  const sessionId = request.params.id;
  if (!sessionId) {
    return {
      status: 400,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing session id" }),
    };
  }

  try {
    const client = await getAgentClient();

    if (request.method === "DELETE") {
      const deleted = await client.deleteSession(userId, sessionId);
      return {
        status: deleted ? 200 : 404,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ deleted }),
      };
    }

    // GET
    const session = await client.getSession(userId, sessionId);
    if (!session) {
      return {
        status: 404,
        headers: {
          ...corsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Session not found" }),
      };
    }

    // Load messages from the separate messages container
    const messages = await client.getSessionMessages(userId, sessionId);

    return {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({
        ...stripCosmosInternals(session),
        messages: messages.map(({ pk: _pk, ttl: _ttl, ...m }) => stripCosmosInternals(m)),
      }),
    };
  } catch (err) {
    context.error("apiSessionById error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// POST /api/token
// ============================================================================

async function apiToken(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);
  const userId = auth.userId;

  try {
    const groups = getDefaultGroups("user", "agentforeach-client");
    const token = await generateClientToken(
      {
        userId,
        clientId: "agentforeach-client",
        platform: request.headers.get("x-client-platform") ?? "unknown",
        version: request.headers.get("x-client-version") ?? "0.0.0",
        groups,
        role: "user",
      },
      { groups },
    );

    return {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({
        url: token.url,
        expiresAtMs: token.expiresAtMs,
      }),
    };
  } catch (err) {
    context.error("apiToken error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// GET /api/usage
// ============================================================================

async function apiUsage(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);

  try {
    const from = request.query.get("from") ?? undefined;
    const to = request.query.get("to") ?? undefined;

    const client = await getAgentClient();
    const summary = await client.getUsageSummary(auth.userId, { from, to });

    return {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    };
  } catch (err) {
    context.error("apiUsage error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// GET /api/usage/records
// ============================================================================

async function apiUsageRecords(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);

  try {
    const from = request.query.get("from") ?? undefined;
    const to = request.query.get("to") ?? undefined;
    const limitStr = request.query.get("limit");
    const limit = limitStr
      ? Math.min(Math.max(1, parseInt(limitStr, 10) || 50), 200)
      : 50;

    const client = await getAgentClient();
    const records = await client.getUsageRecords(auth.userId, {
      from,
      to,
      limit,
    });

    return {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify(records.map(stripCosmosInternals)),
    };
  } catch (err) {
    context.error("apiUsageRecords error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// GET /api/health
// ============================================================================

async function apiHealth(
  _request: HttpRequestLike,
  _context: HandlerContext,
): Promise<HttpResult> {
  return {
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "ok",
      service: "agentforeach-gateway",
      ts: new Date().toISOString(),
    }),
  };
}

// ============================================================================
// POST /api/identity/pair
// ============================================================================

async function apiIdentityPair(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);

  try {
    await ensureIdentityStore();
    const store = getIdentityStore();
    if (!store) {
      return {
        status: 503,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Identity system not available" }),
      };
    }

    let pairing;
    try {
      pairing = await store.createPairingCode(auth.userId);
    } catch (err) {
      if (err instanceof TooManyPairingCodesError) {
        return {
          status: 429,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          body: JSON.stringify({ error: err.message }),
        };
      }
      throw err;
    }

    return {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pairing.code,
        expiresIn: store.getConfig().pairingCodeTtlSeconds,
        expiresAt: pairing.expiresAt,
      }),
    };
  } catch (err) {
    context.error("apiIdentityPair error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// GET /api/identity/links — list links
// POST /api/identity/links — create link (admin role only)
// ============================================================================

async function apiIdentityLinks(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);

  try {
    await ensureIdentityStore();
    const store = getIdentityStore();
    if (!store) {
      return {
        status: 503,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Identity system not available" }),
      };
    }

    if (request.method === "POST") {
      const body = (await request.json()) as LinkCreateBody;
      const decision = authorizeLinkCreate(auth, body);
      if (!decision.ok) {
        return {
          status: decision.status,
          headers: { ...corsHeaders(request), "Content-Type": "application/json" },
          body: JSON.stringify({ error: decision.error }),
        };
      }

      const link = await store.upsertLink({
        id: IdentityStore.buildLinkId(decision.channel, decision.channelUserId),
        userId: decision.targetUserId,
        channel: decision.channel,
        channelUserId: decision.channelUserId,
        linkedVia: "admin",
        linkedAt: new Date().toISOString(),
      });

      return {
        status: 200,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ link: stripCosmosInternals(link as unknown as Record<string, unknown>) }),
      };
    }

    // GET — list links for the authenticated user
    const links = await store.getLinksForUser(auth.userId);

    return {
      status: 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({
        links: links.map((l) => stripCosmosInternals(l as unknown as Record<string, unknown>)),
      }),
    };
  } catch (err) {
    context.error("apiIdentityLinks error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// POST /api/identity/backfill-index — admin: index pre-upgrade links once
// ============================================================================

async function apiIdentityBackfillIndex(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);
  const json = (status: number, body: unknown): HttpResult => ({
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!isAdmin(auth)) return json(403, { error: "Admin role required" });

  try {
    await ensureIdentityStore();
    const store = getIdentityStore();
    if (!store) return json(503, { error: "Identity system not available" });
    const result = await store.backfillChannelIndex();
    context.log(`[identity] channel index backfill: ${JSON.stringify(result)}`);
    return json(200, result);
  } catch (err) {
    context.error("apiIdentityBackfillIndex error:", err);
    return json(500, { error: "Internal error" });
  }
}

// ============================================================================
// DELETE /api/identity/links/{linkId}
// ============================================================================

async function apiIdentityDeleteLink(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS")
    return { status: 204, headers: corsHeaders(request) };

  const auth = await resolveAuthContext(request);
  if (!auth) return unauthorized(request);

  const linkId = request.params.linkId;
  if (!linkId) {
    return {
      status: 400,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing linkId" }),
    };
  }

  try {
    await ensureIdentityStore();
    const store = getIdentityStore();
    if (!store) {
      return {
        status: 503,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Identity system not available" }),
      };
    }

    // linkId format: "channel:channelUserId" (e.g., "telegram:12345")
    const colonIdx = linkId.indexOf(":");
    if (colonIdx < 1) {
      return {
        status: 400,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid linkId format (expected channel:channelUserId)" }),
      };
    }

    const channel = linkId.slice(0, colonIdx);
    const channelUserId = linkId.slice(colonIdx + 1);

    if (!channel || !channelUserId) {
      return {
        status: 400,
        headers: { ...corsHeaders(request), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Invalid linkId format (expected channel:channelUserId)" }),
      };
    }

    const deleted = await store.deleteLink(channel, channelUserId, auth.userId);

    return {
      status: deleted ? 200 : 404,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ deleted }),
    };
  } catch (err) {
    context.error("apiIdentityDeleteLink error:", err);
    return {
      status: 500,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// Function Registrations
// ============================================================================

export const routes: RouteDef[] = [];

routes.push({
  name: "apiChat",
  methods: ["POST", "OPTIONS"],
  route: "api/chat",
  durable: true,
  handler: apiChat,
});

routes.push({
  name: "apiChatAbort",
  methods: ["POST", "OPTIONS"],
  route: "api/chat/abort",
  handler: apiChatAbort,
});

routes.push({
  name: "apiSessions",
  methods: ["GET", "OPTIONS"],
  route: "api/sessions",
  handler: apiSessions,
});

routes.push({
  name: "apiSessionById",
  methods: ["GET", "DELETE", "OPTIONS"],
  route: "api/sessions/{id}",
  handler: apiSessionById,
});

routes.push({
  name: "apiUsage",
  methods: ["GET", "OPTIONS"],
  route: "api/usage",
  handler: apiUsage,
});

routes.push({
  name: "apiUsageRecords",
  methods: ["GET", "OPTIONS"],
  route: "api/usage/records",
  handler: apiUsageRecords,
});

routes.push({
  name: "apiToken",
  methods: ["POST", "OPTIONS"],
  route: "api/token",
  handler: apiToken,
});

routes.push({
  name: "apiHealth",
  methods: ["GET"],
  route: "api/health",
  handler: apiHealth,
});

routes.push({
  name: "apiIdentityPair",
  methods: ["POST", "OPTIONS"],
  route: "api/identity/pair",
  handler: apiIdentityPair,
});

routes.push({
  name: "apiIdentityLinks",
  methods: ["GET", "POST", "OPTIONS"],
  route: "api/identity/links",
  handler: apiIdentityLinks,
});

routes.push({
  name: "apiIdentityBackfillIndex",
  methods: ["POST", "OPTIONS"],
  route: "api/identity/backfill-index",
  handler: apiIdentityBackfillIndex,
});

routes.push({
  name: "apiIdentityDeleteLink",
  methods: ["DELETE", "OPTIONS"],
  route: "api/identity/links/{linkId}",
  handler: apiIdentityDeleteLink,
});
