/**
 * AgentForEach Gateway — WebSocket Security Helpers
 *
 * Shared validation functions for Web PubSub CloudEvents handlers:
 *   - Upstream secret verification (prevents unauthorized webhook calls)
 *   - CloudEvents header validation (ce-connectionId, ce-userId)
 *   - Abuse protection (Web PubSub validation handshake)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { isCloudRuntime, parseEnvBool } from "../utils/index.js";
import { resolveConnectionString } from "../websocket/config.js";

const UPSTREAM_SECRET_QUERY_KEYS = [
  "upstreamSecret",
  "upstream_secret",
] as const;
const UPSTREAM_SECRET_HEADER_KEYS = [
  "x-webpubsub-upstream-secret",
  "x-agentforeach-upstream-secret",
] as const;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolveProvidedSecret(request: HttpRequest): string | undefined {
  for (const key of UPSTREAM_SECRET_HEADER_KEYS) {
    const value = request.headers.get(key)?.trim();
    if (value) return value;
  }
  // Query strings end up in access logs, so only local development may use them.
  if (!isCloudRuntime()) {
    for (const key of UPSTREAM_SECRET_QUERY_KEYS) {
      const value = request.query.get(key)?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

/** AccessKey from a Web PubSub connection string, if present. */
export function accessKeyFromConnectionString(connectionString: string | undefined): string | undefined {
  const match = connectionString?.match(/(?:^|;)\s*AccessKey=([^;]+)/i);
  return match?.[1]?.trim() || undefined;
}

/**
 * Web PubSub signs every upstream call: `ce-signature` holds one or more
 * `sha256=<hex HMAC-SHA256(accessKey, ce-connectionId)>` values (one per
 * key, so it keeps working through a key rotation).
 */
export function isValidWebPubSubSignature(
  signatureHeader: string,
  connectionId: string,
  accessKeys: readonly string[],
): boolean {
  const provided = signatureHeader.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  return accessKeys.some((key) => {
    const expected = `sha256=${createHmac("sha256", key).update(connectionId).digest("hex")}`;
    return provided.some((p) => safeEqual(p, expected));
  });
}

/**
 * Access keys that may sign upstream calls: the key in the Web PubSub
 * connection string, plus WEBPUBSUB_SECONDARY_ACCESS_KEY so a key
 * regeneration doesn't reject events signed with the other key.
 */
export function upstreamAccessKeys(): string[] {
  return [
    accessKeyFromConnectionString(resolveConnectionString()),
    process.env.WEBPUBSUB_SECONDARY_ACCESS_KEY?.trim(),
  ].filter((k): k is string => Boolean(k));
}

/**
 * Upstream verification for Web PubSub CloudEvent handlers.
 *
 * When an access key is known, the `ce-signature` Web PubSub adds to every
 * call is required; nothing else is accepted.
 *
 * Only without an access key (identity-based connection) is the shared
 * secret WEBPUBSUB_UPSTREAM_SHARED_SECRET accepted, in an
 * x-webpubsub-upstream-secret / x-agentforeach-upstream-secret header (or, locally
 * only, the query string). In the cloud that secret is then required
 * (WEBPUBSUB_REQUIRE_UPSTREAM_SECRET=false opts out).
 */
export function verifyUpstreamSecret(
  request: HttpRequest,
): HttpResponseInit | null {
  const unauthorized = {
    status: 401,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Unauthorized upstream caller" }),
  };

  const accessKeys = upstreamAccessKeys();
  if (accessKeys.length > 0) {
    const signature = request.headers.get("ce-signature");
    const connectionId = request.headers.get("ce-connectionid");
    return signature && connectionId && isValidWebPubSubSignature(signature, connectionId, accessKeys)
      ? null
      : unauthorized;
  }

  const requireSecret = parseEnvBool(
    "WEBPUBSUB_REQUIRE_UPSTREAM_SECRET",
    isCloudRuntime(),
  );
  const expected = process.env.WEBPUBSUB_UPSTREAM_SHARED_SECRET?.trim();
  if (!expected) {
    if (requireSecret) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "WebSocket upstream verification is not configured" }),
      };
    }
    return null;
  }

  const provided = resolveProvidedSecret(request);
  if (!provided || !safeEqual(provided, expected)) return unauthorized;
  return null;
}

/**
 * Basic CloudEvent header validation to reject plain HTTP spoof traffic.
 */
export function verifyCloudEventHeaders(
  request: HttpRequest,
): HttpResponseInit | null {
  const specVersion = request.headers.get("ce-specversion");
  const eventType = request.headers.get("ce-type");

  if (!specVersion || !eventType) {
    return {
      status: 401,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing CloudEvent metadata" }),
    };
  }
  return null;
}
