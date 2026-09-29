/**
 * AgentForEach Auth System — Role checks
 *
 * Providers fill AuthContext.roles from claims, API key metadata or config.
 * Operator-only actions check the configured admin role here.
 */

import { loadAuthConfig } from "./config.js";
import type { AuthContext } from "./types.js";

export function hasRole(auth: AuthContext, role: string): boolean {
  return auth.roles.includes(role);
}

/** Holds the operator role (auth.settings.adminRole, default "admin"). */
export function isAdmin(auth: AuthContext): boolean {
  return hasRole(auth, loadAuthConfig().settings?.adminRole ?? "admin");
}
