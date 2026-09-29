import { type HttpRequest, type HttpResponseInit } from "@azure/functions";

export function handleCorsHeaders(
  request: HttpRequest,
): Record<string, string> {
  const origin = request.headers.get("origin");
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const allowOrigin = (() => {
    if (!origin) return "*";
    if (configured.length === 0) return "*";
    return configured.includes(origin) ? origin : configured[0];
  })();

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id",
  };

  if (allowOrigin !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }

  return headers;
}

// ============================================================================
// Abuse Protection (Web PubSub CloudEvents)
// ============================================================================

export function handleAbuseProtection(
  request: HttpRequest,
): HttpResponseInit | null {
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("WebHook-Request-Origin");
    return {
      status: 200,
      headers: { "WebHook-Allowed-Origin": origin ?? "*" },
    };
  }
  return null;
}
