/**
 * AgentForEach Real-Time System — Server Push (Provider-Agnostic Facade)
 *
 * Server-side module for pushing events to connected clients.
 * Delegates to the active WebSocket provider resolved from agentforeach.json.
 *
 * Previously coupled to Azure Web PubSub directly — now a thin facade
 * over the provider registry. The same public API is preserved so
 * existing callers (handlers, cron executor, push-adapter) don't change.
 *
 * Key operations:
 *   - sendToUser()   — deliver to a specific user's connected devices
 *   - sendToGroup()  — broadcast to all clients in a topic group
 *   - sendToAll()    — broadcast to all connected clients
 *
 * @see websocket/providers/ — registered provider implementations
 */

import { getActiveProvider } from "./providers/index.js";
import type {
  EventFrame,
  ResponseFrame,
  EventName,
  GroupName,
  Frame,
} from "./types.js";

// ============================================================================
// Event Push — Send to User
// ============================================================================

/**
 * Push an event frame to a specific user.
 *
 * All of the user's connected devices (iOS, Android, Web) receive the event.
 *
 * @param userId - AgentForEach user ID.
 * @param event  - Event name (from EVENTS constant).
 * @param payload - Event-specific data.
 * @param seq    - Optional sequence number for gap detection.
 */
export async function sendEventToUser(
  userId: string,
  event: EventName | string,
  payload?: unknown,
  seq?: number,
): Promise<void> {
  const provider = getActiveProvider();
  const frame: EventFrame = { type: "event", event, payload, seq };
  await provider.sendToUser(userId, frame);
}

/**
 * Push a response frame to a specific user (in reply to a request).
 *
 * Used when clients send requests via upstream event handlers.
 */
export async function sendResponseToUser(
  userId: string,
  response: ResponseFrame,
): Promise<void> {
  const provider = getActiveProvider();
  await provider.sendToUser(userId, response);
}

// ============================================================================
// Event Push — Send to Group
// ============================================================================

/**
 * Push an event to all clients in a group.
 *
 * Groups provide topic-based routing:
 *   - "cron" group → cron job results
 *   - "chat" group → LLM streaming events
 *   - "system" group → health/admin events
 *
 * @param group   - Group name (from GROUPS constant).
 * @param event   - Event name.
 * @param payload - Event-specific data.
 * @param seq     - Optional sequence number.
 */
export async function sendEventToGroup(
  group: GroupName | string,
  event: EventName | string,
  payload?: unknown,
  seq?: number,
): Promise<void> {
  const provider = getActiveProvider();
  const frame: EventFrame = { type: "event", event, payload, seq };
  await provider.sendToGroup(group, frame);
}

// ============================================================================
// Event Push — Broadcast to All
// ============================================================================

/**
 * Push an event to ALL connected clients.
 *
 * Use sparingly — prefer sendToGroup() or sendToUser() for targeted delivery.
 * Useful for system-wide announcements (shutdown, maintenance, version update).
 */
export async function sendEventToAll(
  event: EventName | string,
  payload?: unknown,
  seq?: number,
): Promise<void> {
  const provider = getActiveProvider();
  const frame: EventFrame = { type: "event", event, payload, seq };
  await provider.sendToAll(frame);
}

// ============================================================================
// Raw Frame Push (for custom frames)
// ============================================================================

/**
 * Send a raw frame to a user. Use this when you need full control
 * over the frame type (e.g., sending ResponseFrames).
 */
export async function sendFrameToUser(
  userId: string,
  frame: Frame,
): Promise<void> {
  const provider = getActiveProvider();
  await provider.sendToUser(userId, frame);
}

// ============================================================================
// Group Management
// ============================================================================

/**
 * Add a user to a group.
 *
 * Called during client connection setup — the server decides which
 * groups the user should be in based on their role and preferences.
 */
export async function addUserToGroup(
  userId: string,
  group: GroupName | string,
): Promise<void> {
  const provider = getActiveProvider();
  await provider.addUserToGroup(userId, group);
}

/**
 * Remove a user from a group.
 */
export async function removeUserFromGroup(
  userId: string,
  group: GroupName | string,
): Promise<void> {
  const provider = getActiveProvider();
  await provider.removeUserFromGroup(userId, group);
}

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Check if a user has any active connections.
 *
 * Useful for deciding whether to push events or skip
 * (avoid wasted API calls for offline users).
 */
export async function isUserOnline(userId: string): Promise<boolean> {
  const provider = getActiveProvider();
  return provider.isUserOnline(userId);
}

/**
 * Close all connections for a user.
 *
 * Used for force-logout, security incidents, or when a user's
 * auth is revoked.
 */
export async function disconnectUser(
  userId: string,
  reason?: string,
): Promise<void> {
  const provider = getActiveProvider();
  await provider.disconnectUser(userId, reason);
}
