/**
 * AgentForEach Gateway — WebSocket Disconnect Handler
 *
 * Handles Web PubSub CloudEvents "disconnected" event — called when
 * a client closes the WebSocket connection.
 *
 * Mirrors @serverless-openclaw/gateway ws-disconnect.ts pattern.
 */

import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from "@azure/functions";
import { verifyCloudEventHeaders, verifyUpstreamSecret } from "./ws-security.js";
import { redactId } from "../utils/redact.js";

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
// WebSocket Disconnect
// ============================================================================

/**
 * Web PubSub "disconnected" event handler — called when a client closes
 * the WebSocket. Logs the disconnection for observability.
 *
 * Unlike OpenClaw's gateway which tracks connections in Cosmos DB,
 * AgentForEach relies on Web PubSub's built-in connection tracking
 * (userExists, sendToUser). No explicit cleanup needed.
 */
async function wsDisconnect(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
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
      request.headers.get("ce-userId") ??
      request.headers.get("ce-userid");

    context.log(
      `wsDisconnect: user=${redactId(userId ?? "unknown")} connection=${connectionId ?? "unknown"}`,
    );

    return { status: 200, body: "Disconnected" };
  } catch (err) {
    context.error("wsDisconnect error:", err);
    return { status: 200, body: "OK" }; // Always 200 for disconnect
  }
}

// ============================================================================
// Function Registration
// ============================================================================

app.http("wsDisconnect", {
  methods: ["GET", "OPTIONS", "POST"],
  authLevel: "anonymous",
  route: "ws/disconnected",
  handler: wsDisconnect,
});
