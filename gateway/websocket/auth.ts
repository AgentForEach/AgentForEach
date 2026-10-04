/**
 * AgentForEach Real-Time System — Client Token Generation
 *
 * Generates short-lived WebSocket access tokens for clients (iOS, Android, Web).
 * Clients use these tokens to connect to the active WebSocket provider.
 *
 * Flow:
 *   1. Client authenticates with AgentForEach's API (OAuth, device token, etc.)
 *   2. Client calls POST /api/realtime/token with its credentials
 *   3. Server generates a client access token (via this module)
 *   4. Client opens WebSocket to the token URL
 *   5. Provider authenticates the connection using the embedded claims
 *
 * Delegates to the active WebSocket provider's clientAccess() method.
 * Previously coupled to Azure Web PubSub directly — now provider-agnostic.
 *
 * @see docs/Architecture.md#real-time-protocol
 */

import type {
  ClientTokenClaims,
  GroupName,
  ClientRole,
  ClientId,
  ClientAccessToken,
} from "./types.js";
import { GROUPS } from "./types.js";
import {
  resolveDefaultTokenTtl,
  resolveMaxTokenTtl,
  resolveDefaultGroups,
} from "./config.js";
import { getActiveProvider } from "./providers/index.js";

// ============================================================================
// Token Configuration
// ============================================================================

export type TokenOptions = {
  /** Token time-to-live in minutes. Default from config (60). */
  ttlMinutes?: number;
  /** Groups the client should auto-join on connect. */
  groups?: GroupName[];
  /** Roles to grant (maps to provider-specific permissions). */
  roles?: string[];
};

// ============================================================================
// Token Generation
// ============================================================================

/**
 * Generate a client access token for WebSocket connection.
 *
 * Delegates to the active provider's clientAccess() method.
 * The provider handles the actual token creation and URL construction.
 *
 * @param claims - Client identity claims.
 * @param options - Token configuration.
 * @returns Access token with WebSocket URL.
 *
 * @example
 * ```typescript
 * const token = await generateClientToken({
 *   userId: "user-123",
 *   clientId: "agentforeach-ios",
 *   platform: "iOS 18",
 *   version: "1.0.0",
 *   groups: ["cron", "chat"],
 *   role: "user",
 * });
 * // Client connects: new WebSocket(token.url)
 * ```
 */
export async function generateClientToken(
  claims: ClientTokenClaims,
  options?: TokenOptions,
): Promise<ClientAccessToken> {
  const provider = await getActiveProvider();

  const ttlMinutes = Math.min(
    options?.ttlMinutes ?? resolveDefaultTokenTtl(),
    resolveMaxTokenTtl(),
  );

  // Build provider-specific roles/permissions
  const roles = buildRoles(claims, options);

  return provider.clientAccess(claims.userId, {
    ttlMinutes,
    groups: claims.groups,
    roles,
  });
}

// ============================================================================
// Role Mapping
// ============================================================================

/**
 * Map client claims to provider roles/permissions.
 *
 * For Azure Web PubSub these map to:
 *   - "webpubsub.joinLeaveGroup.<group>" — join/leave a group
 *   - "webpubsub.sendToGroup.<group>"    — send to a group
 *
 * Other providers may interpret roles differently.
 */
function buildRoles(
  claims: ClientTokenClaims,
  options?: TokenOptions,
): string[] {
  const roles: string[] = [];

  // Allow joining requested groups
  for (const group of claims.groups) {
    roles.push(`webpubsub.joinLeaveGroup.${group}`);
  }

  // Admin gets access to the system group
  if (claims.role === "admin") {
    roles.push(`webpubsub.joinLeaveGroup.${GROUPS.SYSTEM}`);
  }

  // Merge any additional custom roles
  if (options?.roles) {
    roles.push(...options.roles);
  }

  return roles;
}

// ============================================================================
// Default Group Resolution
// ============================================================================

/**
 * Determine which groups a client should join based on its role.
 *
 * Resolves from agentforeach.json "websocket.groupDefaults" section,
 * falling back to built-in defaults.
 */
export function getDefaultGroups(
  role: ClientRole,
  _clientId: ClientId,
): GroupName[] {
  return resolveDefaultGroups(role) as GroupName[];
}
