/**
 * AgentForEach Gateway — WebSocket Disconnect Handler
 *
 * Handles Web PubSub CloudEvents "disconnected" event — called when
 * a client closes the WebSocket connection.
 *
 */

import type { HandlerContext, HttpRequestLike, HttpResult, RouteDef } from "@agentforeach/platform";
import { verifyCloudEventHeaders, verifyUpstreamSecret } from "./ws-security.js";
import { redactId } from "../utils/redact.js";
import { handleAbuseProtection } from "../utils/request-http.js";

// ============================================================================
// WebSocket Disconnect
// ============================================================================

/**
 * Web PubSub "disconnected" event handler — called when a client closes
 * the WebSocket. Logs the disconnection for observability.
 *
 * Connections aren't tracked in a database: AgentForEach relies on Web
 * PubSub's built-in connection tracking
 * (userExists, sendToUser). No explicit cleanup needed.
 */
async function wsDisconnect(
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

export const routes: RouteDef[] = [];

routes.push({
  name: "wsDisconnect",
  methods: ["GET", "OPTIONS", "POST"],
  route: "ws/disconnected",
  handler: wsDisconnect,
});
