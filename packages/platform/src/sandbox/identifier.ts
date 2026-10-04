/**
 * Sandbox identifiers: one sandbox per user (`["userId"]`) or per
 * conversation (`["userId","sessionId"]`). JSON, so a user id containing ":"
 * (or anything else) can't collide with a user and session pair, and the
 * owner reads back unambiguously.
 */

/** The identifier of a user's sandbox, or of one conversation's when `sessionId` is given. */
export function encodeSandboxIdentifier(userId: string, sessionId?: string): string {
  return JSON.stringify(sessionId ? [userId, sessionId] : [userId]);
}

/** The user an identifier belongs to; throws for one this module didn't make. */
export function sandboxIdentifierOwner(identifier: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(identifier);
  } catch {
    throw new Error("Invalid sandbox identifier");
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || parsed.length > 2) {
    throw new Error("Invalid sandbox identifier");
  }
  return parsed[0];
}
