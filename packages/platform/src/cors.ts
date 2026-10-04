/**
 * The gateway's CORS policy, shared by its handlers and by hosts that have to
 * answer for routes that don't handle CORS themselves.
 *
 * The policy comes from one setting, CORS_ALLOWED_ORIGINS (comma-separated):
 * - With origins listed, a listed origin is allowed with credentials (App
 *   Service sign-in cookies). Any other origin is answered with the first
 *   listed one, so the browser refuses it.
 * - With none listed, any origin is allowed, without credentials (bearer
 *   tokens).
 * Azure's Functions host is configured the same way (infra/functions.ts) and
 * answers preflights before the gateway runs; a Worker answers them itself
 * with this helper.
 */

export interface CorsPolicy {
  /** Allowed origins; empty allows any origin, without credentials. */
  readonly origins: readonly string[];
}

/** The policy from a CORS_ALLOWED_ORIGINS value. */
export function corsPolicy(allowedOrigins: string | undefined): CorsPolicy {
  return {
    origins: (allowedOrigins ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
}

/**
 * The CORS headers for a request from `origin` (its Origin header, if any),
 * allowing `methods` and `headers` (comma-separated header values).
 */
export function corsHeaders(
  policy: CorsPolicy,
  origin: string | null | undefined,
  allow: { methods: string; headers: string },
): Record<string, string> {
  const configured = policy.origins;
  const allowOrigin = !origin || configured.length === 0 ? "*" : configured.includes(origin) ? origin : configured[0];
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": allow.methods,
    "Access-Control-Allow-Headers": allow.headers,
  };
  if (allowOrigin !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }
  return headers;
}
