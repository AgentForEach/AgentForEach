/**
 * AgentForEach Sessions Module — client-supplied session ids
 *
 * Session ids from API, WebSocket and cron callers are stored in document ids
 * and partition keys, so they are limited to a plain charset. Ownership is
 * enforced by the data model (sessions and messages are scoped to the
 * authenticated user), not by this check.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_PATTERN.test(id);
}

export const INVALID_SESSION_ID_MESSAGE =
  "sessionId must be 1-128 characters of letters, digits, '.', '_' or '-'";
