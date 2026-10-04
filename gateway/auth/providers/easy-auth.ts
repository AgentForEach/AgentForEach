/**
 * AgentForEach Auth Provider — Azure Easy Auth
 *
 * Decodes the Azure App Service Easy Auth `x-ms-client-principal` header
 * and extracts user identity from claims.
 *
 * This is the primary auth provider for production Azure deployments.
 */

import type { HttpRequestLike } from "@agentforeach/platform";
import { isCloudRuntime, parseEnvBool } from "../../utils/index.js";
import { hostInfo } from "../../runtime/host.js";
import type {
  AuthProvider,
  AuthContext,
  EasyAuthProviderConfig,
} from "../types.js";

// ============================================================================
// Internal Types
// ============================================================================

type ClientPrincipalClaim = {
  typ?: string;
  val?: string;
};

type ClientPrincipal = {
  auth_typ?: string;
  /** Claim type that carries roles (App Service sets this). */
  role_typ?: string;
  identityProvider?: string;
  userId?: string;
  userDetails?: string;
  userRoles?: string[];
  claims?: ClientPrincipalClaim[];
};

// ============================================================================
// Claim Keys
// ============================================================================

const USER_ID_CLAIMS = [
  "sub",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
  "nameidentifier",
  "oid",
  "nameid",
];

const TENANT_ID_CLAIMS = [
  "tid",
  "tenantid",
  "http://schemas.microsoft.com/identity/claims/tenantid",
];

const ROLE_CLAIMS = [
  "roles",
  "role",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
];

const EMAIL_CLAIMS = [
  "email",
  "preferred_username",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
];

// ============================================================================
// Helpers
// ============================================================================

function claimMap(principal: ClientPrincipal): Map<string, string> {
  const map = new Map<string, string>();
  for (const claim of principal.claims ?? []) {
    const key = claim.typ?.trim().toLowerCase();
    const value = claim.val?.trim();
    if (!key || !value) continue;
    if (!map.has(key)) {
      map.set(key, value);
    }
  }
  return map;
}

function pickClaim(
  map: Map<string, string>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = map.get(key.toLowerCase());
    if (value) return value;
  }
  return undefined;
}

/**
 * The `x-ms-client-principal*` headers are only trustworthy when App Service
 * Authentication is on, because the platform then strips client-sent copies.
 * Azure sets WEBSITE_AUTH_ENABLED=True in that case. Anywhere else (local
 * dev, Docker, AKS) they are ordinary client headers, so they are trusted
 * only with an explicit AUTH_TRUST_EASY_AUTH_HEADERS=true, e.g. behind a
 * proxy that sets them, or to emulate Easy Auth locally. On a production
 * host that isn't Azure they are never trusted.
 */
function easyAuthHeadersTrusted(): boolean {
  if (isCloudRuntime()) {
    // Only App Service strips client-sent copies; on any other production
    // host these headers are whatever the client sent.
    if (hostInfo().platform !== "azure") return false;
    return parseEnvBool("WEBSITE_AUTH_ENABLED", false);
  }
  return parseEnvBool("AUTH_TRUST_EASY_AUTH_HEADERS", false);
}

function decodeClientPrincipal(request: HttpRequestLike): ClientPrincipal | null {
  const encoded = request.headers.get("x-ms-client-principal");
  if (!encoded) return null;
  try {
    const json = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as ClientPrincipal;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ============================================================================
// Provider
// ============================================================================

export function createEasyAuthProvider(
  _config: EasyAuthProviderConfig,
): AuthProvider {
  return {
    id: "easy-auth",
    label: "Azure Easy Auth",

    resolve(request: HttpRequestLike): AuthContext | null {
      if (!easyAuthHeadersTrusted()) return null;

      const principal = decodeClientPrincipal(request);
      if (!principal) return null;

      const claims = claimMap(principal);
      const userId =
        request.headers.get("x-ms-client-principal-id") ??
        principal.userId ??
        pickClaim(claims, USER_ID_CLAIMS);

      if (!userId?.trim()) return null;

      const tenantId = pickClaim(claims, TENANT_ID_CLAIMS);
      const email = pickClaim(claims, EMAIL_CLAIMS);

      // Entra app roles arrive as one claim per role, so collect every
      // value (claimMap keeps only the first of each type).
      const roleTypes = new Set(
        [...ROLE_CLAIMS, principal.role_typ ?? ""].map((t) => t.toLowerCase()).filter(Boolean),
      );
      const roles: string[] = [];
      for (const claim of principal.claims ?? []) {
        const typ = claim.typ?.trim().toLowerCase();
        const v = claim.val?.trim();
        if (typ && v && roleTypes.has(typ) && !roles.includes(v)) roles.push(v);
      }
      for (const role of principal.userRoles ?? []) {
        if (role && !roles.includes(role)) roles.push(role);
      }

      return {
        userId: userId.trim(),
        tenantId: tenantId?.trim(),
        email: email?.trim(),
        provider:
          principal.identityProvider ??
          request.headers.get("x-ms-client-principal-idp") ??
          principal.auth_typ,
        roles,
        source: "easy-auth",
      };
    },
  };
}
