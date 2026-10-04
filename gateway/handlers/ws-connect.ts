/**
 * AgentForEach Gateway — WebSocket Connect Handler
 *
 * Handles Web PubSub CloudEvents "connect" event — called when a client
 * opens a WebSocket connection. Validates the user identity from the
 * ce-userId header and returns a successful connect response.
 *
 * Also provides a "negotiate" endpoint for clients to obtain a
 * Web PubSub access URL with an embedded token.
 *
 */

import type { HandlerContext, HttpRequestLike, HttpResult, RouteDef } from "@agentforeach/platform";

import { handleCorsHeaders, handleAbuseProtection } from "../utils/index.js";

import { generateClientToken, getDefaultGroups } from "../websocket/index.js";
import { resolveAuthContext } from "../auth/index.js";
import {
  verifyCloudEventHeaders,
  verifyUpstreamSecret,
} from "./ws-security.js";
import { redactId } from "../utils/redact.js";

/**
 * Web PubSub "connect" event handler — called when a client opens a WebSocket.
 *
 * Validates the user identity from CloudEvents headers (ce-userId, ce-connectionId).
 * Returns a 200 with the userId to confirm the connection.
 */
async function wsConnect(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  const abuse = handleAbuseProtection(request);
  if (abuse) return abuse;
  const upstream = verifyUpstreamSecret(request);
  if (upstream) return upstream;
  const cloudEvent = verifyCloudEventHeaders(request);
  if (cloudEvent) return cloudEvent;

  try {
    const connectionId =
      request.headers.get("ce-connectionId") ??
      request.headers.get("ce-connectionid");
    const userId =
      request.headers.get("ce-userId") ?? request.headers.get("ce-userid");

    if (!connectionId || !userId) {
      context.warn("wsConnect: missing ce-connectionId or ce-userId headers");
      return {
        status: 401,
        body: JSON.stringify({ error: "Missing user identity" }),
      };
    }

    context.log(`wsConnect: user=${redactId(userId)} connection=${connectionId}`);

    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    };
  } catch (err) {
    context.error("wsConnect error:", err);
    return {
      status: 500,
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// Negotiate Endpoint
// ============================================================================

/**
 * WebSocket negotiate endpoint — clients call this to get a Web PubSub
 * connection URL with an embedded access token.
 *
 * GET /negotiate
 */
async function negotiate(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
  if (request.method === "OPTIONS") {
    return { status: 204, headers: handleCorsHeaders(request) };
  }

  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return {
        status: 401,
        headers: {
          ...handleCorsHeaders(request),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
    const userId = auth.userId;

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
      headers: {
        ...handleCorsHeaders(request),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: token.url }),
    };
  } catch (err) {
    context.error("negotiate error:", err);
    return {
      status: 500,
      headers: {
        ...handleCorsHeaders(request),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: "Internal error" }),
    };
  }
}

// ============================================================================
// Function Registrations
// ============================================================================

export const routes: RouteDef[] = [];

routes.push({
  name: "negotiate",
  methods: ["GET", "OPTIONS"],
  route: "negotiate",
  handler: negotiate,
});

routes.push({
  name: "wsConnect",
  methods: ["GET", "OPTIONS", "POST"],
  route: "ws/connect",
  handler: wsConnect,
});

/**
 * Catch-all route for Web PubSub abuse protection validation.
 * Web PubSub sends OPTIONS to unexpanded URL templates and events
 * we haven't explicitly registered. Without this, abuse protection
 * fails with 404 and all connections are rejected.
 */
routes.push({
  name: "wsCatchAll",
  methods: ["OPTIONS"],
  route: "ws/{*catchAllEvent}",
  handler: async (request: HttpRequestLike): Promise<HttpResult> => {
    const origin = request.headers.get("WebHook-Request-Origin");
    return {
      status: 200,
      headers: { "WebHook-Allowed-Origin": origin ?? "*" },
    };
  },
});
