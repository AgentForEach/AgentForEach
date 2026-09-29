/**
 * AgentForEach Auth Provider — JWT Bearer Token
 *
 * Validates JWT bearer tokens from the Authorization header.
 * Supports RS256 (JWKS URI) and HS256 (shared secret) algorithms.
 *
 * For RS256, public keys are fetched from the configured JWKS endpoint
 * and cached in memory with automatic refresh.
 *
 * For HS256, a shared secret (optionally from an env var) is used.
 */

import { createHmac, createVerify, timingSafeEqual } from "node:crypto";
import type { HttpRequest } from "@azure/functions";
import { resolveEnvValue } from "../../utils/index.js";
import { loadAuthConfig } from "../config.js";
import type { AuthProvider, AuthContext, JwtProviderConfig } from "../types.js";

// ============================================================================
// JWT Decode (minimal, no external dependencies)
// ============================================================================

type JwtHeader = {
  alg: string;
  typ?: string;
  kid?: string;
};

type JwtPayload = Record<string, unknown> & {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
};

function base64UrlDecode(str: string): Buffer {
  // Replace URL-safe chars and pad
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function decodeJwtParts(token: string): {
  header: JwtHeader;
  payload: JwtPayload;
  signatureInput: string;
  signature: Buffer;
} | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(
      base64UrlDecode(parts[0]!).toString("utf8"),
    ) as JwtHeader;
    const payload = JSON.parse(
      base64UrlDecode(parts[1]!).toString("utf8"),
    ) as JwtPayload;
    const signatureInput = `${parts[0]}.${parts[1]}`;
    const signature = base64UrlDecode(parts[2]!);
    return { header, payload, signatureInput, signature };
  } catch {
    return null;
  }
}

// ============================================================================
// HS256 Verification
// ============================================================================

function verifyHS256(
  signatureInput: string,
  signature: Buffer,
  secret: string,
): boolean {
  const expected = createHmac("sha256", secret).update(signatureInput).digest();

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(expected, signature);
}

// ============================================================================
// JWKS Cache for RS256
// ============================================================================

type JwksKey = {
  kid?: string;
  kty: string;
  use?: string;
  n: string;
  e: string;
  alg?: string;
};

type JwksCache = {
  keys: JwksKey[];
  fetchedAt: number;
};

const jwksCaches = new Map<string, JwksCache>();
const jwksInflight = new Map<string, Promise<JwksKey[]>>();
const DEFAULT_JWKS_CACHE_TTL_MS = 3600_000; // 1 hour
/** A key rotation is picked up at most this often per JWKS URI. */
const JWKS_MIN_REFETCH_MS = 60_000;
const JWKS_FETCH_TIMEOUT_MS = 10_000;
/** After a failed fetch, don't try again for this long (serve stale keys). */
const JWKS_FAILURE_BACKOFF_MS = 30_000;

const jwksLastForcedRefetch = new Map<string, number>();
const jwksLastFailure = new Map<string, { at: number; error: Error }>();

/** Keys usable for RS256 signatures; others (EC, encryption keys) are skipped. */
function isRs256SigningKey(key: JwksKey): boolean {
  return (
    key.kty === "RSA" &&
    (!key.use || key.use === "sig") &&
    (!key.alg || key.alg === "RS256") &&
    typeof key.n === "string" &&
    typeof key.e === "string"
  );
}

/**
 * Get the JWKS keys for a URI, cached. `force` refetches before the cache
 * expires (a token named an unknown `kid`: keys probably rotated), at most
 * once per JWKS_MIN_REFETCH_MS so bogus kids can't hammer the issuer.
 * Concurrent callers share one request.
 *
 * When the issuer is down, the last keys keep being served (an outage
 * shouldn't log everyone out), and fetches back off for
 * JWKS_FAILURE_BACKOFF_MS instead of making every login wait for a timeout.
 */
async function fetchJwks(uri: string, force = false): Promise<JwksKey[]> {
  const jwksCacheTtlMs = loadAuthConfig().jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  const cached = jwksCaches.get(uri);
  const now = Date.now();
  const forcedRecently = now - (jwksLastForcedRefetch.get(uri) ?? 0) < JWKS_MIN_REFETCH_MS;
  if (cached && (force ? forcedRecently : now - cached.fetchedAt < jwksCacheTtlMs)) {
    return cached.keys;
  }
  const failure = jwksLastFailure.get(uri);
  if (failure && now - failure.at < JWKS_FAILURE_BACKOFF_MS) {
    if (cached) return cached.keys;
    throw failure.error;
  }
  if (force) jwksLastForcedRefetch.set(uri, now);

  let pending = jwksInflight.get(uri);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(uri, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
        if (!response.ok) {
          throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`);
        }
        const data = (await response.json()) as { keys?: JwksKey[] };
        const keys = (Array.isArray(data.keys) ? data.keys : []).filter(isRs256SigningKey);
        jwksCaches.set(uri, { keys, fetchedAt: Date.now() });
        jwksLastFailure.delete(uri);
        return keys;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        jwksLastFailure.set(uri, { at: Date.now(), error });
        const stale = jwksCaches.get(uri);
        if (!stale) throw error;
        console.warn(`[auth] JWKS fetch failed, serving cached keys: ${error.message}`);
        return stale.keys;
      }
    })().finally(() => jwksInflight.delete(uri));
    jwksInflight.set(uri, pending);
  }
  return pending;
}

/** Test helper: forget cached JWKS keys. */
export function resetJwksCache(): void {
  jwksCaches.clear();
  jwksInflight.clear();
  jwksLastForcedRefetch.clear();
  jwksLastFailure.clear();
}

function jwkToPem(jwk: JwksKey): string {
  // Convert JWK RSA public key to PEM format
  const n = base64UrlDecode(jwk.n);
  const e = base64UrlDecode(jwk.e);

  // Build ASN.1 DER encoding for RSA public key
  const encodedN = encodeUnsignedInteger(n);
  const encodedE = encodeUnsignedInteger(e);

  const rsaPublicKey = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(encodedN.length + encodedE.length),
    encodedN,
    encodedE,
  ]);

  // RSA OID: 1.2.840.113549.1.1.1
  const rsaOid = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);

  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    encodeLength(rsaPublicKey.length + 1),
    Buffer.from([0x00]),
    rsaPublicKey,
  ]);

  const spki = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(rsaOid.length + bitString.length),
    rsaOid,
    bitString,
  ]);

  const b64 = spki.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

function encodeLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeUnsignedInteger(buf: Buffer): Buffer {
  // Ensure positive (prepend 0x00 if high bit set)
  let data = buf;
  if (data[0]! & 0x80) {
    data = Buffer.concat([Buffer.from([0x00]), data]);
  }
  return Buffer.concat([Buffer.from([0x02]), encodeLength(data.length), data]);
}

async function verifyRS256(
  signatureInput: string,
  signature: Buffer,
  kid: string | undefined,
  jwksUri: string,
): Promise<boolean> {
  let keys = await fetchJwks(jwksUri);
  if (kid && !keys.some((k) => k.kid === kid)) {
    // Unknown key id: the issuer probably rotated keys. Refetch (at most
    // once a minute) instead of failing every login until the cache expires.
    keys = await fetchJwks(jwksUri, true);
  }
  // With a kid, only that key; without one, any of the issuer's signing keys.
  const candidates = kid ? keys.filter((k) => k.kid === kid) : keys;
  return candidates.some((jwk) => {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signatureInput);
    return verifier.verify(jwkToPem(jwk), signature);
  });
}

// ============================================================================
// Claim Extraction
// ============================================================================

function extractClaim(
  payload: JwtPayload,
  claimName: string,
): string | undefined {
  const value = payload[claimName];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function extractRoles(payload: JwtPayload, roleClaims: string[]): string[] {
  const roles: string[] = [];
  for (const claim of roleClaims) {
    const value = payload[claim];
    if (typeof value === "string" && !roles.includes(value)) {
      roles.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string" && !roles.includes(v)) {
          roles.push(v);
        }
      }
    }
  }
  return roles;
}

// ============================================================================
// Provider
// ============================================================================

/** Allowed clock difference for exp/nbf checks. */
const CLOCK_SKEW_SECONDS = 60;

export function createJwtProvider(config: JwtProviderConfig): AuthProvider {
  const headerName = (config.headerName ?? "authorization").toLowerCase();
  const algorithm = config.algorithm ?? "RS256";
  const userIdClaim = config.userIdClaim ?? "sub";
  const tenantIdClaim = config.tenantIdClaim ?? "tid";
  const roleClaims = config.roleClaims ?? ["roles"];
  const emailClaim = config.emailClaim ?? "email";
  const secret = resolveEnvValue(config.secret) ?? "";
  const requireExp = config.requireExp ?? true;

  if (algorithm === "RS256" && !config.jwksUri) {
    throw new Error("JWT provider: jwksUri is required for RS256 algorithm");
  }
  if (algorithm === "HS256" && !secret) {
    throw new Error("JWT provider: secret is required for HS256 algorithm");
  }
  if (algorithm === "RS256" && (!config.issuer || !config.audience)) {
    // Shared JWKS endpoints (Entra "common", Firebase) sign tokens for every
    // tenant/project; without iss and aud checks, all of them are accepted.
    console.warn("[auth] JWT provider: set issuer and audience, or tokens from any tenant using this JWKS are accepted");
  }

  return {
    id: "jwt",
    label: "JWT Bearer Token",

    async resolve(request: HttpRequest): Promise<AuthContext | null> {
      let rawToken = request.headers.get(headerName);
      if (!rawToken) return null;

      // Strip "Bearer " prefix
      rawToken = rawToken.trim();
      if (rawToken.toLowerCase().startsWith("bearer ")) {
        rawToken = rawToken.slice(7).trim();
      }

      if (!rawToken) return null;

      // Decode JWT
      const decoded = decodeJwtParts(rawToken);
      if (!decoded) return null;

      const { header, payload, signatureInput, signature } = decoded;

      // The token must use the configured algorithm ("none", or HS256 signed
      // with a public key as the secret, would otherwise be tried).
      if (header.alg !== algorithm) return null;

      // Verify signature
      if (algorithm === "HS256") {
        if (!verifyHS256(signatureInput, signature, secret)) return null;
      } else if (algorithm === "RS256") {
        const valid = await verifyRS256(
          signatureInput,
          signature,
          header.kid,
          config.jwksUri!,
        );
        if (!valid) return null;
      } else {
        return null; // Unsupported algorithm
      }

      // Validate standard claims
      const now = Math.floor(Date.now() / 1000);

      // Tokens must expire unless explicitly configured otherwise.
      if (payload.exp === undefined) {
        if (requireExp) return null;
      } else if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < now) {
        return null; // Malformed or expired
      }
      if (payload.nbf !== undefined) {
        if (typeof payload.nbf !== "number" || payload.nbf > now + CLOCK_SKEW_SECONDS) return null; // Not yet valid
      }

      if (config.issuer && payload.iss !== config.issuer) return null;

      if (config.audience) {
        const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!aud.includes(config.audience)) return null;
      }

      // Extract user identity
      const userId = extractClaim(payload, userIdClaim);
      if (!userId) return null;

      return {
        userId,
        tenantId: extractClaim(payload, tenantIdClaim),
        email: extractClaim(payload, emailClaim),
        roles: extractRoles(payload, roleClaims),
        source: "jwt",
        provider: payload.iss ? String(payload.iss) : undefined,
      };
    },
  };
}
