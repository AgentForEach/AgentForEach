import { corsHeaders, corsPolicy, type HttpRequestLike, type HttpResult } from "@agentforeach/platform";

/** CORS headers by the gateway's policy (CORS_ALLOWED_ORIGINS; see @agentforeach/platform's cors.ts). */
export function handleCorsHeaders(
  request: HttpRequestLike,
): Record<string, string> {
  return corsHeaders(corsPolicy(process.env.CORS_ALLOWED_ORIGINS), request.headers.get("origin"), {
    methods: "GET,OPTIONS",
    headers: "Content-Type, Authorization, x-user-id",
  });
}

// ============================================================================
// Abuse Protection (Web PubSub CloudEvents)
// ============================================================================

export function handleAbuseProtection(
  request: HttpRequestLike,
): HttpResult | null {
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("WebHook-Request-Origin");
    return {
      status: 200,
      headers: { "WebHook-Allowed-Origin": origin ?? "*" },
    };
  }
  return null;
}
