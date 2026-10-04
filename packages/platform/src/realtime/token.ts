/**
 * AgentForEach Platform — Realtime access tokens
 *
 * Tokens for providers that run their own sockets (in-memory, Cloudflare
 * Durable Objects), with Web PubSub's claims: `sub` is the user id, `role`
 * the Web PubSub role strings, `aud` the URL path the token is for.
 *
 * The token travels in the WebSocket URL, and request logs record URLs, so
 * it is sealed rather than just signed: AES-256-GCM over the JSON claims. A
 * logged URL shows nothing about its user, and any change to a token fails
 * its authentication tag. WebCrypto only, so it runs in Node and Workers
 * alike.
 *
 * Each token has its own key: HKDF-SHA256 of the deployment's secret with
 * 16 random bytes of salt carried in the token. A key is used for one seal,
 * so random 96-bit IVs never meet the per-key limit on GCM, however many
 * URLs a deployment hands out.
 *
 *   token = "v2." + base64url(salt[16] || iv[12] || ciphertext || tag[16])
 *
 * Older formats are refused: tokens live for minutes, so none outlive an
 * upgrade.
 */

export type RealtimeTokenClaims = {
  /** The user id the service stamps on everything the connection sends. */
  sub: string;
  /** The URL path the token is valid for, e.g. `/realtime/relay`. */
  aud: string;
  /** Hub name; connections on different hubs never see each other. */
  hub: string;
  /** Web PubSub role strings (`webpubsub.joinLeaveGroup.<g>`, ...). */
  role: string[];
  /** Groups the connection starts in. */
  groups?: string[];
  /** Expiry, seconds since the epoch. */
  exp: number;
  iat?: number;
  /** Ticket id: the token connects once (see ./tickets.ts). */
  jti?: string;
};

const VERSION = "v2.";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Longer tokens are refused before any decoding (a real one is a few hundred characters). */
const MAX_TOKEN_CHARS = 8192;
const encoder = new TextEncoder();
const secrets = new Map<string, Promise<CryptoKey>>();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The deployment secret as HKDF key material, imported once per secret (a failed import isn't kept). */
function secretKey(secret: string): Promise<CryptoKey> {
  let key = secrets.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    secrets.set(secret, key);
    key.catch(() => secrets.delete(secret));
  }
  return key;
}

/** The AES-256-GCM key for one token: the secret with the token's own salt. */
async function tokenKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: encoder.encode("agentforeach-realtime token-v2") },
    await secretKey(secret),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals `claims` with `secret`. */
export async function sealRealtimeToken(claims: RealtimeTokenClaims, secret: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await tokenKey(secret, salt), encoder.encode(JSON.stringify(claims))),
  );
  const out = new Uint8Array(SALT_BYTES + IV_BYTES + sealed.byteLength);
  out.set(salt);
  out.set(iv, SALT_BYTES);
  out.set(sealed, SALT_BYTES + IV_BYTES);
  return VERSION + base64url(out);
}

/**
 * The token's claims if it was sealed with `secret`, is unexpired, and is
 * meant for `audience`; otherwise undefined.
 */
export async function openRealtimeToken(
  token: string,
  secret: string,
  audience: string,
  now: Date = new Date(),
): Promise<RealtimeTokenClaims | undefined> {
  if (token.length > MAX_TOKEN_CHARS || !token.startsWith(VERSION)) return undefined;
  try {
    const body = token.slice(VERSION.length);
    const bytes = fromBase64url(body);
    // Only the canonical encoding: a token has exactly one spelling (the last character's spare bits are zero).
    if (base64url(bytes) !== body) return undefined;
    if (bytes.byteLength <= SALT_BYTES + IV_BYTES + TAG_BYTES) return undefined;
    const salt = bytes.slice(0, SALT_BYTES);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(SALT_BYTES, SALT_BYTES + IV_BYTES) },
      await tokenKey(secret, salt),
      bytes.slice(SALT_BYTES + IV_BYTES),
    );
    const claims = JSON.parse(new TextDecoder().decode(plain)) as Partial<RealtimeTokenClaims>;
    if (typeof claims.sub !== "string" || !claims.sub || typeof claims.hub !== "string" || !Array.isArray(claims.role)) return undefined;
    if (claims.aud !== audience) return undefined;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) return undefined;
    return {
      sub: claims.sub,
      aud: claims.aud,
      hub: claims.hub,
      role: claims.role.map(String),
      ...(Array.isArray(claims.groups) ? { groups: claims.groups.map(String) } : {}),
      exp: claims.exp,
      ...(typeof claims.iat === "number" ? { iat: claims.iat } : {}),
      ...(typeof claims.jti === "string" && claims.jti ? { jti: claims.jti } : {}),
    };
  } catch {
    return undefined;
  }
}
