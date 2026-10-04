/**
 * AgentForEach Auth Provider — Insecure Header (Dev/Local Fallback)
 *
 * Authenticates requests via a plain `x-user-id` header or `?userId=` query param.
 * Off unless AUTH_ALLOW_INSECURE_USER_ID_HEADER=true, and always off on
 * Azure App Service / Functions (WEBSITE_SITE_NAME set), because it lets any
 * caller act as any user. Other hosts (Docker, AKS, ...) can't be detected,
 * so the opt-in is explicit rather than "on when local".
 */

import type { HttpRequestLike } from "@agentforeach/platform";
import { isCloudRuntime, parseEnvBool } from "../../utils/index.js";
import type {
  AuthProvider,
  AuthContext,
  InsecureHeaderProviderConfig,
} from "../types.js";

// ============================================================================
// Provider
// ============================================================================

export function createInsecureHeaderProvider(
  _config: InsecureHeaderProviderConfig,
): AuthProvider {
  return {
    id: "insecure-header",
    label: "Insecure Header (Dev)",

    resolve(request: HttpRequestLike): AuthContext | null {
      // Never trust a client-supplied user id on App Service, whatever the flag says.
      if (isCloudRuntime()) return null;
      if (!parseEnvBool("AUTH_ALLOW_INSECURE_USER_ID_HEADER", false)) return null;

      const userId =
        request.headers.get("x-user-id") ?? request.query.get("userId") ?? null;

      if (!userId?.trim()) return null;

      return {
        userId: userId.trim(),
        roles: [],
        source: "insecure-header",
      };
    },
  };
}
