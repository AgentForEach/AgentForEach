/**
 * AgentForEach Platform — Object store errors
 *
 * Providers map their vendor errors onto these codes, so callers branch on
 * `isObjectNotFound(err)` rather than on an S3 or Azure status.
 */

import { MAX_SIGNED_URL_SECONDS, type ObjectStore, type SignedUrl, type SignedUrlOptions } from "./types.js";

export type ObjectStoreErrorCode =
  /** The object does not exist. */
  | "not_found"
  /** The object is larger than the caller's `maxBytes`. */
  | "too_large"
  /** The key or an argument is invalid. */
  | "invalid"
  /** The credentials were refused. */
  | "unauthorized"
  /** The service is throttling or unavailable; safe to retry later. */
  | "unavailable"
  /** Anything else the provider reported. */
  | "provider_error";

const STATUS: Record<ObjectStoreErrorCode, number> = {
  not_found: 404,
  too_large: 413,
  invalid: 400,
  unauthorized: 403,
  unavailable: 503,
  provider_error: 502,
};

export class ObjectStoreError extends Error {
  readonly code: ObjectStoreErrorCode;
  readonly statusCode: number;

  constructor(code: ObjectStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ObjectStoreError";
    this.code = code;
    this.statusCode = STATUS[code];
  }
}

function hasCode(err: unknown, code: ObjectStoreErrorCode): boolean {
  return (
    (err instanceof ObjectStoreError || (err instanceof Error && err.name === "ObjectStoreError")) &&
    (err as ObjectStoreError).code === code
  );
}

export const isObjectNotFound = (err: unknown): boolean => hasCode(err, "not_found");
export const isObjectTooLarge = (err: unknown): boolean => hasCode(err, "too_large");

/** Maps an HTTP status from an object service to a code. */
export function codeForStatus(status: number): ObjectStoreErrorCode {
  if (status === 404) return "not_found";
  if (status === 400) return "invalid";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429 || status === 503 || status === 500) return "unavailable";
  return "provider_error";
}

/**
 * Rejects keys that are empty, absolute, longer than 1024 bytes, or that
 * have an empty, `.` or `..` segment (so also a trailing `/`), a backslash
 * or a control character. Spaces and Unicode are allowed.
 */
export function assertValidKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new ObjectStoreError("invalid", "Object key is empty");
  if (key.startsWith("/")) throw new ObjectStoreError("invalid", `Object key must not start with "/": ${key}`);
  if (new TextEncoder().encode(key).length > 1024) throw new ObjectStoreError("invalid", "Object key is longer than 1024 bytes");
  if (/[\x00-\x1f\x7f\\]/.test(key)) throw new ObjectStoreError("invalid", `Object key has a backslash or a control character: ${JSON.stringify(key)}`);
  if (key.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new ObjectStoreError("invalid", `Object key has an empty, "." or ".." segment: ${key}`);
  }
}

/**
 * A directory marker: the empty object some tools (the S3 console, Azure
 * Storage Explorer) create for a folder. `list` skips them.
 */
export const isDirectoryMarker = (key: string): boolean => key.endsWith("/");

/** Reads a body stream, failing with `too_large` as soon as `maxBytes` is passed. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number | undefined, key: string): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ObjectStoreError("too_large", `Object ${key} is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Seconds from `now` to `expiresAt`, rejecting a past expiry and one more
 * than `maxSeconds` ahead (default: 7 days, the SigV4 limit).
 */
export function signedUrlSeconds(expiresAt: Date, now: Date, maxSeconds: number = MAX_SIGNED_URL_SECONDS): number {
  const seconds = Math.ceil((expiresAt.getTime() - now.getTime()) / 1000);
  if (!(seconds >= 1)) throw new ObjectStoreError("invalid", "Signed URL expiry must be in the future");
  if (seconds > maxSeconds) throw new ObjectStoreError("invalid", `Signed URL expiry must be at most ${maxSeconds} seconds ahead`);
  return seconds;
}

/** How long before temporary credentials expire the links they sign stop. */
export const CREDENTIAL_EXPIRY_MARGIN_MS = 60_000;

/**
 * The lifetime of a link signed at `now` for `expiresAt`: the seconds to
 * sign it for, and when it then really expires (`now` to the second, as
 * signatures date it, plus those seconds; never after `expiresAt` by more
 * than the one second a link needs at least). Rejects what
 * `signedUrlSeconds` rejects. A link is cut short to `capSeconds`, when
 * given (a deployment's own limit), and with `credentialsExpireAt` it stops
 * 60 s before the credentials that sign it; credentials that leave no time
 * at all are `unavailable` (fresh ones are on the way).
 */
export function signedUrlLifetime(
  expiresAt: Date,
  now: Date,
  options: { maxSeconds?: number; capSeconds?: number; credentialsExpireAt?: Date } = {},
): { seconds: number; expiresAt: Date } {
  signedUrlSeconds(expiresAt, now, options.maxSeconds);
  const signedAt = Math.floor(now.getTime() / 1000) * 1000;
  let seconds = Math.max(1, Math.floor((expiresAt.getTime() - signedAt) / 1000));
  if (options.capSeconds !== undefined) seconds = Math.min(seconds, Math.max(1, Math.floor(options.capSeconds)));
  if (options.credentialsExpireAt) {
    const limit = Math.floor((options.credentialsExpireAt.getTime() - CREDENTIAL_EXPIRY_MARGIN_MS - signedAt) / 1000);
    if (limit < 1) throw new ObjectStoreError("unavailable", "The signing credentials expire too soon to sign a link");
    seconds = Math.min(seconds, limit);
  }
  return { seconds, expiresAt: new Date(signedAt + seconds * 1000) };
}

/**
 * A signed link from any store, with its real expiry: the store's own
 * `signedUrlWithExpiry`, or `signedUrl` and the expiry asked for when the
 * store has no such method.
 */
export async function signLink(store: ObjectStore, key: string, options: SignedUrlOptions): Promise<SignedUrl> {
  if (store.signedUrlWithExpiry) return store.signedUrlWithExpiry(key, options);
  return { url: await store.signedUrl(key, options), expiresAt: options.expiresAt };
}
