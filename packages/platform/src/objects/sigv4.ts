/**
 * AgentForEach Platform — AWS Signature Version 4
 *
 * Signs S3-compatible requests with nothing but the web platform: `fetch`,
 * `crypto.subtle` and `TextEncoder`. That keeps the `s3` object-store provider
 * dependency-free and runnable in Node and in Workers alike.
 *
 * Two forms:
 *   - `signRequest` adds `authorization`, `x-amz-date` and
 *     `x-amz-content-sha256` headers to a request.
 *   - `presignUrl` returns a URL whose query string carries the signature
 *     (`X-Amz-*`), for handing to a browser or a sandbox.
 *
 * Paths are canonicalised the S3 way: each segment is URI-encoded once, never
 * twice, and `/` separators are kept.
 */

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary-credential session token, sent as `x-amz-security-token`. */
  sessionToken?: string;
  /**
   * When temporary credentials stop working. Links presigned with them stop
   * then too, so the `s3` provider signs links to end 60 s before.
   */
  expiration?: Date;
};

export type SigningScope = {
  credentials: AwsCredentials;
  /** Signing region; `auto` for Cloudflare R2. */
  region: string;
  /** Service name in the credential scope; `s3` for object storage. */
  service: string;
};

/** Payload hash S3 accepts when the body is not hashed. */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

function asBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

/** Hex SHA-256 of a string or bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", asBytes(data) as BufferSource));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/**
 * RFC 3986 encoding as SigV4 defines it: only `A-Z a-z 0-9 - _ . ~` stay
 * literal. `encodeURIComponent` also leaves `! ' ( ) *`, so those are encoded.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** S3 canonical path: each segment encoded once, separators kept. */
export function canonicalPath(pathname: string): string {
  // `URL` has already percent-encoded the path; decode it so that each
  // segment is encoded exactly once with SigV4's rules.
  return pathname
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** `20130524T000000Z` */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function signature(scope: SigningScope, stamp: string, canonicalRequest: string): Promise<{ signature: string; credentialScope: string }> {
  const day = stamp.slice(0, 8);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, credentialScope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmac(encoder.encode("AWS4" + scope.credentials.secretAccessKey), day);
  const kRegion = await hmac(kDate, scope.region);
  const kService = await hmac(kRegion, scope.service);
  const kSigning = await hmac(kService, "aws4_request");
  return { signature: toHex(await hmac(kSigning, stringToSign)), credentialScope };
}

export type SignRequestInput = {
  method: string;
  url: URL;
  /** Headers to send and sign. Names are matched case-insensitively. */
  headers?: Record<string, string>;
  /** Body to hash. Ignored when `payloadHash` is given. */
  body?: string | Uint8Array;
  /** Precomputed payload hash, or `UNSIGNED_PAYLOAD`. */
  payloadHash?: string;
  now?: Date;
};

/**
 * Returns the headers to send: the input headers plus `host`, `x-amz-date`,
 * `x-amz-content-sha256`, `x-amz-security-token` (if any) and `authorization`.
 */
export async function signRequest(scope: SigningScope, input: SignRequestInput): Promise<Record<string, string>> {
  const stamp = amzDate(input.now ?? new Date());
  const payloadHash = input.payloadHash ?? (await sha256Hex(input.body ?? ""));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
  headers["host"] = input.url.host;
  headers["x-amz-date"] = stamp;
  headers["x-amz-content-sha256"] = payloadHash;
  if (scope.credentials.sessionToken) headers["x-amz-security-token"] = scope.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url.pathname),
    canonicalQuery(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const { signature: sig, credentialScope } = await signature(scope, stamp, canonicalRequest);
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${scope.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return headers;
}

export type PresignInput = {
  method: string;
  url: URL;
  expiresInSeconds: number;
  now?: Date;
};

/**
 * Returns `url` with the SigV4 query parameters added. Only `host` is signed,
 * so any client can use the URL. Extra query parameters already on `url`
 * (for example `response-content-disposition`) are covered by the signature.
 */
export async function presignUrl(scope: SigningScope, input: PresignInput): Promise<URL> {
  if (!(input.expiresInSeconds >= 1 && input.expiresInSeconds <= 604800)) {
    throw new RangeError("expiresInSeconds must be between 1 and 604800 (7 days)");
  }
  const stamp = amzDate(input.now ?? new Date());
  const url = new URL(input.url.toString());
  const day = stamp.slice(0, 8);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${scope.credentials.accessKeyId}/${day}/${scope.region}/${scope.service}/aws4_request`);
  url.searchParams.set("X-Amz-Date", stamp);
  url.searchParams.set("X-Amz-Expires", String(Math.floor(input.expiresInSeconds)));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  if (scope.credentials.sessionToken) url.searchParams.set("X-Amz-Security-Token", scope.credentials.sessionToken);

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const { signature: sig } = await signature(scope, stamp, canonicalRequest);
  url.searchParams.set("X-Amz-Signature", sig);
  return url;
}

/** When a presigned URL stops working: its `X-Amz-Date` plus `X-Amz-Expires` seconds. */
export function presignedUrlExpiry(url: string | URL): Date {
  const params = new URL(url).searchParams;
  const stamp = params.get("X-Amz-Date") ?? "";
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!match) throw new RangeError(`Not a presigned URL: X-Amz-Date is "${stamp}"`);
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) + Number(params.get("X-Amz-Expires")) * 1000);
}
