/**
 * AgentForEach Gateway — WebSocket Message Handler
 *
 * Handles Web PubSub CloudEvents "message" event — called when a client
 * sends a message through the WebSocket connection.
 *
 * Checks that the call comes from this deployment's Web PubSub, takes the
 * user and connection from the CloudEvent headers, and hands the message to
 * the transport-neutral client event handler (client-events.ts). Web PubSub
 * sends the response body back to the connection.
 */

import type { HandlerContext, HttpRequestLike, HttpResult, RouteDef } from "@agentforeach/platform";
import {
  verifyCloudEventHeaders,
  verifyUpstreamSecret,
} from "./ws-security.js";
import { handleAbuseProtection } from "../utils/request-http.js";
import { handleClientEvent } from "./client-events.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// WebSocket Message Handler
// ============================================================================

async function wsMessage(
  request: HttpRequestLike,
  context: HandlerContext,
): Promise<HttpResult> {
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

  return handleClientEvent(
    { userId, connectionId, timezone: requestTimezone, text: () => request.text() },
    context,
  );
}

// ============================================================================
// Function Registration
// ============================================================================

export const routes: RouteDef[] = [];

routes.push({
  name: "wsMessage",
  methods: ["GET", "OPTIONS", "POST"],
  route: "ws/message",
  durable: true,
  handler: wsMessage,
});
