/**
 * AgentForEach Auth System — Type Definitions
 *
 * Modular auth system with multiple providers.
 * Supports multiple auth providers configured via agentforeach.json.
 *
 * Each provider implements the AuthProvider interface and is resolved
 * in priority order via the chain-of-responsibility pattern.
 */

import type { HttpRequest } from "@azure/functions";

// ============================================================================
// Auth Provider Identity
// ============================================================================

/**
 * Supported auth provider types.
 *
 * - easy-auth:      Azure App Service Easy Auth (x-ms-client-principal header)
 * - api-key:        Static API key via configurable header (e.g., x-api-key)
 * - jwt:            JWT bearer token validation (RS256/HS256)
 * - trusted-proxy:  Reverse proxy identity headers (Pomerium, Caddy, etc.)
 * - insecure-header: Dev/local fallback via x-user-id header or ?userId= query
 */
export type AuthProviderId =
  | "easy-auth"
  | "api-key"
  | "jwt"
  | "trusted-proxy"
  | "insecure-header"
  | (string & {});

// ============================================================================
// Auth Context (result of successful authentication)
// ============================================================================

export type AuthContext = {
  /** Unique user identifier resolved from the auth provider. */
  userId: string;
  /** Tenant / organization ID (Azure AD, JWT claim, etc.). */
  tenantId?: string;
  /** Identity provider name (e.g., "aad", "google", "github"). */
  provider?: string;
  /** Roles extracted from claims, API key metadata, or JWT. */
  roles: string[];
  /** Which auth provider resolved this context. */
  source: AuthProviderId;
  /** Optional email address from claims. */
  email?: string;
  /** Additional metadata from the provider. */
  metadata?: Record<string, string>;
};

// ============================================================================
// Auth Provider Interface
// ============================================================================

/**
 * Auth provider interface — each provider implements this to participate
 * in the authentication chain.
 *
 */
export interface AuthProvider {
  /** Unique provider identifier. */
  readonly id: AuthProviderId;
  /** Human-readable label for logging / diagnostics. */
  readonly label: string;
  /**
   * Attempt to resolve an auth context from the request.
   * Returns null if this provider cannot authenticate the request
   * (the next provider in the chain will be tried).
   */
  resolve(
    request: HttpRequest,
  ): Promise<AuthContext | null> | AuthContext | null;
}

// ============================================================================
// Auth Configuration (agentforeach.json → "auth" section)
// ============================================================================

/** Configuration for an individual auth provider instance. */
export type AuthProviderConfig =
  | EasyAuthProviderConfig
  | ApiKeyProviderConfig
  | JwtProviderConfig
  | TrustedProxyProviderConfig
  | InsecureHeaderProviderConfig;

/** Azure Easy Auth — no additional config needed beyond enabling. */
export type EasyAuthProviderConfig = {
  type: "easy-auth";
  /** Whether this provider is active. Defaults to true. */
  enabled?: boolean;
};

/** API key auth — clients send a static key via a header. */
export type ApiKeyProviderConfig = {
  type: "api-key";
  enabled?: boolean;
  /**
   * Header name to read the API key from.
   * Defaults to "x-api-key".
   */
  headerName?: string;
  /**
   * Map of API key → user identity.
   * Keys can also be stored in env vars (reference via "$ENV_VAR_NAME").
   */
  keys: Record<string, ApiKeyIdentity>;
};

export type ApiKeyIdentity = {
  userId: string;
  roles?: string[];
  email?: string;
  metadata?: Record<string, string>;
};

/** JWT bearer token validation. */
export type JwtProviderConfig = {
  type: "jwt";
  enabled?: boolean;
  /**
   * Header name to read the bearer token from.
   * Defaults to "authorization" (expects "Bearer <token>").
   */
  headerName?: string;
  /** JWT issuer (iss claim) to validate. */
  issuer?: string;
  /** JWT audience (aud claim) to validate. */
  audience?: string;
  /**
   * Algorithm: "RS256" (public key / JWKS) or "HS256" (shared secret).
   * Defaults to "RS256".
   */
  algorithm?: "RS256" | "HS256";
  /**
   * JWKS URI for RS256 validation (e.g., "https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys").
   * Required when algorithm is "RS256".
   */
  jwksUri?: string;
  /**
   * Shared secret for HS256 validation.
   * Can be an env var reference ("$JWT_SECRET").
   * Required when algorithm is "HS256".
   */
  secret?: string;
  /** Claim name to extract userId from. Defaults to "sub". */
  userIdClaim?: string;
  /** Claim name to extract tenantId from. Defaults to "tid". */
  tenantIdClaim?: string;
  /** Claim name(s) to extract roles from. Defaults to ["roles"]. */
  roleClaims?: string[];
  /** Claim name to extract email from. Defaults to "email". */
  emailClaim?: string;
  /** Reject tokens without an `exp` claim. Defaults to true. */
  requireExp?: boolean;
};

/** Trusted reverse proxy — identity is passed via headers from an auth-aware proxy. */
export type TrustedProxyProviderConfig = {
  type: "trusted-proxy";
  enabled?: boolean;
  /**
   * Header name containing the authenticated user identity.
   * E.g., "x-forwarded-user", "x-remote-user", "x-pomerium-claim-email".
   */
  userHeader: string;
  /**
   * Additional headers that MUST be present for the request to be trusted.
   * Example: ["x-forwarded-proto", "x-forwarded-host"]
   */
  requiredHeaders?: string[];
  /**
   * Allowlist of user identities. If empty/omitted, all proxy-authenticated
   * users are allowed.
   */
  allowUsers?: string[];
  /** Roles to assign to all users authenticated via this proxy. */
  defaultRoles?: string[];
  /**
   * Secret the proxy sends on every request (a "$ENV_VAR" reference). The
   * gateway's hostname is public, so identity headers alone prove nothing:
   * without this secret the provider refuses every request.
   */
  sharedSecret?: string;
  /** Header carrying the shared secret. Default "x-proxy-secret". */
  sharedSecretHeader?: string;
};

/** Dev/local fallback — insecure header or query param. */
export type InsecureHeaderProviderConfig = {
  type: "insecure-header";
  enabled?: boolean;
  /**
   * Deprecated and ignored: the provider now always requires
   * AUTH_ALLOW_INSECURE_USER_ID_HEADER=true, and is always off on Azure.
   */
  requireEnvOptIn?: boolean;
};

// ============================================================================
// Top-Level Auth Config (agentforeach.json → "auth")
// ============================================================================

export type AuthConfig = {
  /**
   * Ordered list of auth provider configurations.
   * Providers are tried in order; the first successful match wins.
   * If omitted, falls back to ["easy-auth", "insecure-header"] (legacy behavior).
   */
  providers?: AuthProviderConfig[];

  /**
   * JWKS key cache TTL in milliseconds for RS256 JWT providers.
   * Defaults to 3_600_000 (1 hour).
   */
  jwksCacheTtlMs?: number;

  /**
   * Global settings.
   */
  settings?: AuthGlobalSettings;
};

export type AuthGlobalSettings = {
  /**
   * If true, a failed auth returns 401 immediately without trying
   * remaining providers. If false (default), all providers are tried.
   */
  failFast?: boolean;
  /**
   * If true, log successful auth resolutions (useful for debugging).
   * Defaults to false.
   */
  logSuccesses?: boolean;
  /**
   * Role that grants operator actions (linking another
   * user's channel identity; global cron control once wired). Defaults to "admin".
   */
  adminRole?: string;
};
