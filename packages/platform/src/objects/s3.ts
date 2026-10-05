/**
 * AgentForEach Platform — S3-compatible object store
 *
 * One provider for every service that speaks the S3 API: Amazon S3,
 * Cloudflare R2 (region `auto`), Google Cloud Storage through its
 * interoperability endpoint (HMAC keys), and MinIO. It uses `fetch` and
 * SigV4 from `./sigv4.ts` and nothing else, so it runs in Node and in Workers.
 *
 * ```ts
 * const store = new S3ObjectStore({
 *   endpoint: "https://<account>.r2.cloudflarestorage.com",
 *   region: "auto",
 *   bucket: "user-exports",
 *   credentials: { accessKeyId, secretAccessKey },
 * });
 * ```
 *
 * Operations map to ListObjectsV2, GetObject, HeadObject, PutObject,
 * DeleteObject and a presigned GetObject; with `deleteVersions`,
 * `deletePrefix` uses ListObjectVersions and deletes each version.
 * `deletePrefix` deletes objects one by one: the batch DeleteObjects call
 * needs a `Content-MD5` header, and WebCrypto has no MD5.
 *
 * Every request is retried on a network error, a timeout, 429 or a 5xx, a
 * few times with backoff, and re-signed each time, so credentials that were
 * refreshed meanwhile are used.
 */

import {
  assertValidKey,
  codeForStatus,
  isDirectoryMarker,
  isObjectNotFound,
  ObjectStoreError,
  readCapped,
  signedUrlLifetime,
} from "./errors.js";
import { presignUrl, sha256Hex, signRequest, uriEncode, type AwsCredentials, type SigningScope } from "./sigv4.js";
import type { GetObjectOptions, ObjectInfo, ObjectStore, PutObjectOptions, SignedUrl, SignedUrlOptions } from "./types.js";

export type S3ObjectStoreOptions = {
  /** Service origin, e.g. `https://s3.us-west-2.amazonaws.com` or `http://localhost:9000`. */
  endpoint: string;
  bucket: string;
  /** Signing region; `auto` for R2. Default `us-east-1`. */
  region?: string;
  /**
   * Static keys, or a function returning fresh ones (temporary credentials).
   * Links are signed to end 60 s before the credentials' `expiration`.
   */
  credentials: AwsCredentials | (() => Promise<AwsCredentials>);
  /**
   * `path` sends `<endpoint>/<bucket>/<key>`; `virtual` sends
   * `<bucket>.<endpoint host>/<key>`. Default `path`, which every
   * S3-compatible service accepts.
   */
  addressing?: "path" | "virtual";
  /**
   * Where this store's objects live in the bucket, e.g. `exports/`: empty
   * (the default) or ending in `/`. Keys the store takes and returns are
   * relative to it, so two stores can share a bucket without overlapping.
   */
  prefix?: string;
  /**
   * The bucket owner's 12-digit account ID, sent as
   * `x-amz-expected-bucket-owner` on every request, so S3 refuses them (403)
   * if the bucket now belongs to another account. Amazon S3 only.
   */
  expectedBucketOwner?: string;
  /**
   * Sign links for at most this many seconds (1–604800), whatever expiry is
   * asked for; `signedUrlWithExpiry` reports the shorter one. For hosts
   * whose temporary credentials carry no expiration (AWS Lambda's role
   * credentials), so a link can't outlive them unnoticed. Default: no cap
   * beyond SigV4's 7 days.
   */
  maxSignedUrlSeconds?: number;
  /** Encrypt uploads with this KMS key (SSE-KMS); default: the bucket's own encryption. */
  kmsKeyId?: string;
  /**
   * `deletePrefix` deletes every version and delete marker under the prefix
   * (ListObjectVersions), so nothing survives on a versioned bucket. Needs
   * `s3:ListBucketVersions` and `s3:DeleteObjectVersion`. Default false.
   */
  deleteVersions?: boolean;
  /** How long each attempt waits for the response headers. Default 30 s. */
  timeoutMs?: number;
  /** Attempts per request, counting the first. Default 3. */
  maxAttempts?: number;
  /** Backoff before the first retry, doubled for each one after (with jitter). Default 200 ms. */
  retryDelayMs?: number;
  /** Create the bucket on the first `put` that finds it missing. Default false. */
  createBucket?: boolean;
  /** Objects per ListObjectsV2 page (1–1000). Default 1000. */
  listPageSize?: number;
  /** Parallel DELETEs in `deletePrefix`. Default 8. */
  deleteConcurrency?: number;
  fetch?: typeof fetch;
  now?: () => Date;
};

type SendInput = {
  method: "GET" | "HEAD" | "PUT" | "DELETE";
  /** The full key in the bucket (the store's prefix included). */
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Leave out `x-amz-expected-bucket-owner` (bucket creation takes none). */
  noOwner?: boolean;
};

/** Statuses worth another attempt: throttling and server errors. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5_000;

export class S3ObjectStore implements ObjectStore {
  readonly provider = "s3";
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly credentials: S3ObjectStoreOptions["credentials"];
  private readonly addressing: "path" | "virtual";
  private readonly prefix: string;
  private readonly ownerHeaders: Record<string, string>;
  private readonly kmsKeyId?: string;
  private readonly maxSignedUrlSeconds?: number;
  private readonly deleteVersions: boolean;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly createBucket: boolean;
  private readonly listPageSize: number;
  private readonly deleteConcurrency: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(options: S3ObjectStoreOptions) {
    this.endpoint = new URL(options.endpoint);
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new ObjectStoreError("invalid", `Invalid bucket name: ${options.bucket}`);
    }
    this.bucket = options.bucket;
    this.region = options.region ?? "us-east-1";
    this.credentials = options.credentials;
    this.addressing = options.addressing ?? "path";
    this.prefix = options.prefix ?? "";
    if (this.prefix) {
      if (!this.prefix.endsWith("/")) throw new ObjectStoreError("invalid", `S3 prefix must end with "/": ${this.prefix}`);
      assertValidKey(this.prefix.slice(0, -1));
    }
    if (options.expectedBucketOwner !== undefined && !/^\d{12}$/.test(options.expectedBucketOwner)) {
      throw new ObjectStoreError("invalid", "expectedBucketOwner must be a 12-digit AWS account ID");
    }
    this.ownerHeaders = options.expectedBucketOwner ? { "x-amz-expected-bucket-owner": options.expectedBucketOwner } : {};
    this.kmsKeyId = options.kmsKeyId || undefined;
    if (options.maxSignedUrlSeconds !== undefined && !(Number.isInteger(options.maxSignedUrlSeconds) && options.maxSignedUrlSeconds >= 1 && options.maxSignedUrlSeconds <= 604800)) {
      throw new ObjectStoreError("invalid", "maxSignedUrlSeconds must be a whole number of seconds from 1 to 604800");
    }
    this.maxSignedUrlSeconds = options.maxSignedUrlSeconds;
    this.deleteVersions = options.deleteVersions ?? false;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 200);
    this.createBucket = options.createBucket ?? false;
    this.listPageSize = Math.min(1000, Math.max(1, options.listPageSize ?? 1000));
    this.deleteConcurrency = Math.max(1, options.deleteConcurrency ?? 8);
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  async *list(prefix = ""): AsyncIterable<ObjectInfo> {
    for await (const object of this.listKeys(this.prefix + prefix)) {
      if (!isDirectoryMarker(object.key)) yield { ...object, key: object.key.slice(this.prefix.length) };
    }
  }

  async get(key: string, options: GetObjectOptions = {}): Promise<Uint8Array> {
    const response = await this.send({ method: "GET", key: this.fullKey(key) });
    if (!response.ok) throw await this.error(response, "get", key);
    const length = Number(response.headers.get("content-length"));
    if (options.maxBytes !== undefined && Number.isFinite(length) && length > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ObjectStoreError("too_large", `Object ${key} is larger than ${options.maxBytes} bytes`);
    }
    return readCapped(response.body, options.maxBytes, key);
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.send({ method: "HEAD", key: this.fullKey(key) });
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw await this.error(response, "exists", key);
  }

  async put(key: string, body: Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    const fullKey = this.fullKey(key);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const headers: Record<string, string> = {};
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.contentDisposition) headers["content-disposition"] = options.contentDisposition;
    if (this.kmsKeyId) {
      headers["x-amz-server-side-encryption"] = "aws:kms";
      headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.kmsKeyId;
    }

    let response = await this.send({ method: "PUT", key: fullKey, headers, body: bytes });
    if (response.status === 404 && this.createBucket) {
      const text = await response.text();
      if (errorCode(text) !== "NoSuchBucket") throw await this.error(response, "put", key, text);
      await this.ensureBucket();
      response = await this.send({ method: "PUT", key: fullKey, headers, body: bytes });
    }
    if (!response.ok) throw await this.error(response, "put", key);
    await response.body?.cancel().catch(() => {});
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix) throw new ObjectStoreError("invalid", "deletePrefix needs a non-empty prefix");
    const targets: Array<{ key: string; versionId?: string }> = [];
    try {
      if (this.deleteVersions) {
        for await (const version of this.listVersions(this.prefix + prefix)) targets.push(version);
      } else {
        // Directory markers and keys from before the current key rules too.
        for await (const object of this.listKeys(this.prefix + prefix)) targets.push({ key: object.key });
      }
    } catch (err) {
      if (isObjectNotFound(err)) return 0; // no bucket, nothing to delete
      throw err;
    }

    // Each object counts once, however many of its versions go.
    const deleted = new Set<string>();
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        const { key, versionId } = targets[next++];
        const response = await this.send({ method: "DELETE", key, query: versionId ? { versionId } : undefined });
        await response.body?.cancel().catch(() => {});
        if (response.ok) deleted.add(key);
        else if (response.status !== 404) throw await this.error(response, "delete", key);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.deleteConcurrency, targets.length) }, worker));
    return deleted.size;
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return (await this.signedUrlWithExpiry(key, options)).url;
  }

  async signedUrlWithExpiry(key: string, options: SignedUrlOptions): Promise<SignedUrl> {
    const fullKey = this.fullKey(key);
    const now = this.now();
    const scope = await this.scope();
    const { seconds, expiresAt } = signedUrlLifetime(options.expiresAt, now, {
      capSeconds: this.maxSignedUrlSeconds,
      credentialsExpireAt: scope.credentials.expiration,
    });
    const url = await presignUrl(scope, { method: "GET", url: this.url(fullKey), expiresInSeconds: seconds, now });
    return { url: url.toString(), expiresAt };
  }

  /** `key` checked, under the store's prefix. */
  private fullKey(key: string): string {
    assertValidKey(key);
    return this.prefix + key;
  }

  /** Every object under `prefix` (a full one), with full keys, markers included. */
  private async *listKeys(prefix: string): AsyncIterable<ObjectInfo> {
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", "max-keys": String(this.listPageSize) };
      if (prefix) query.prefix = prefix;
      if (continuationToken) query["continuation-token"] = continuationToken;
      const response = await this.send({ method: "GET", query });
      const xml = await response.text();
      if (!response.ok) throw await this.error(response, "list", prefix, xml);
      const page = parseListObjectsV2(xml);
      for (const object of page.objects) if (object.key.startsWith(prefix)) yield object;
      continuationToken = page.truncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
  }

  /** Every version and delete marker under `prefix` (a full one). */
  private async *listVersions(prefix: string): AsyncIterable<{ key: string; versionId: string }> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    for (;;) {
      const query: Record<string, string> = { versions: "", "max-keys": String(this.listPageSize), prefix };
      if (keyMarker !== undefined) query["key-marker"] = keyMarker;
      if (versionIdMarker !== undefined) query["version-id-marker"] = versionIdMarker;
      const response = await this.send({ method: "GET", query });
      const xml = await response.text();
      if (!response.ok) throw await this.error(response, "list versions", prefix, xml);
      const page = parseListObjectVersions(xml);
      for (const version of page.versions) if (version.key.startsWith(prefix)) yield version;
      if (!page.truncated) return;
      if (!page.nextKeyMarker || (page.nextKeyMarker === keyMarker && page.nextVersionIdMarker === versionIdMarker)) {
        throw new ObjectStoreError("provider_error", `S3 list versions ${prefix} returned a truncated page without new markers`);
      }
      keyMarker = page.nextKeyMarker;
      versionIdMarker = page.nextVersionIdMarker;
    }
  }

  private async ensureBucket(): Promise<void> {
    // us-east-1 and R2's `auto` take no location; everywhere else needs one.
    const body =
      this.region === "us-east-1" || this.region === "auto"
        ? undefined
        : new TextEncoder().encode(
            `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.region}</LocationConstraint></CreateBucketConfiguration>`,
          );
    const response = await this.send({ method: "PUT", body, noOwner: true });
    const text = await response.text();
    if (response.ok) return;
    const code = errorCode(text);
    if (code === "BucketAlreadyOwnedByYou" || code === "BucketAlreadyExists") return;
    throw await this.error(response, "create bucket", this.bucket, text);
  }

  private async scope(): Promise<SigningScope> {
    const credentials = typeof this.credentials === "function" ? await this.credentials() : this.credentials;
    return { credentials, region: this.region, service: "s3" };
  }

  private url(key?: string, query: Record<string, string> = {}): URL {
    const path = key ? "/" + key.split("/").map(uriEncode).join("/") : "/";
    const url =
      this.addressing === "virtual"
        ? new URL(`${this.endpoint.protocol}//${this.bucket}.${this.endpoint.host}${path}`)
        : new URL(`${this.endpoint.origin}/${this.bucket}${key ? path : ""}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  /**
   * Sends one request, retrying network errors, timeouts, 429 and 5xx with
   * backoff. Returns the last response, whatever its status; throws
   * `unavailable` when the last attempt got none.
   */
  private async send(input: SendInput): Promise<Response> {
    const url = this.url(input.key, input.query);
    const body = input.body ?? new Uint8Array(0);
    const payloadHash = await sha256Hex(body);
    for (let attempt = 1; ; attempt++) {
      const headers = await signRequest(await this.scope(), {
        method: input.method,
        url,
        headers: { ...(input.noOwner ? {} : this.ownerHeaders), ...input.headers },
        payloadHash,
        now: this.now(),
      });
      delete headers["host"]; // fetch sets it, and refuses it from callers

      const controller = new AbortController();
      const timer = this.timeoutMs > 0 && Number.isFinite(this.timeoutMs) ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
      let response: Response | undefined;
      let failure: unknown;
      try {
        response = await this.fetchFn(url, {
          method: input.method,
          headers,
          body: input.method === "PUT" ? (body as BodyInit) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        failure = err;
      } finally {
        clearTimeout(timer);
      }

      const retry = response ? RETRY_STATUSES.has(response.status) : true;
      if (!retry || attempt >= this.maxAttempts) {
        if (response) return response;
        const reason = controller.signal.aborted ? `timed out after ${this.timeoutMs} ms` : String(failure);
        throw new ObjectStoreError("unavailable", `S3 ${input.method} ${url.pathname} failed: ${reason}`, { cause: failure });
      }
      await response?.body?.cancel().catch(() => {});
      const delay = Math.min(MAX_RETRY_DELAY_MS, this.retryDelayMs * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay / 2 + Math.random() * (delay / 2)));
    }
  }

  private async error(response: Response, operation: string, target: string, text?: string): Promise<ObjectStoreError> {
    const body = text ?? (await response.text().catch(() => ""));
    const code = errorCode(body);
    const detail = code ? ` (${code}${errorMessage(body) ? `: ${errorMessage(body)}` : ""})` : "";
    return new ObjectStoreError(codeForStatus(response.status), `S3 ${operation} ${target} failed with ${response.status}${detail}`);
  }
}

// ── XML ─────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the five XML entities and numeric character references. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity];
  });
}

function element(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decodeXml(match[1]) : undefined;
}

function errorCode(xml: string): string | undefined {
  return element(xml, "Code");
}

function errorMessage(xml: string): string | undefined {
  return element(xml, "Message");
}

export type ListObjectsV2Page = {
  objects: ObjectInfo[];
  truncated: boolean;
  nextContinuationToken?: string;
};

/** Parses a ListObjectsV2 response body. */
export function parseListObjectsV2(xml: string): ListObjectsV2Page {
  const objects: ObjectInfo[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = element(match[1], "Key");
    if (key === undefined) continue;
    const lastModified = element(match[1], "LastModified");
    objects.push({
      key,
      size: Number(element(match[1], "Size") ?? 0),
      ...(lastModified ? { lastModified: new Date(lastModified) } : {}),
    });
  }
  return {
    objects,
    truncated: element(xml, "IsTruncated") === "true",
    nextContinuationToken: element(xml, "NextContinuationToken"),
  };
}

export type ListObjectVersionsPage = {
  /** Versions and delete markers alike: deleting either takes its key and version ID. */
  versions: Array<{ key: string; versionId: string }>;
  truncated: boolean;
  nextKeyMarker?: string;
  nextVersionIdMarker?: string;
};

/** Parses a ListObjectVersions response body. */
export function parseListObjectVersions(xml: string): ListObjectVersionsPage {
  const versions: ListObjectVersionsPage["versions"] = [];
  for (const match of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const key = element(match[2], "Key");
    const versionId = element(match[2], "VersionId");
    if (key !== undefined && versionId) versions.push({ key, versionId });
  }
  return {
    versions,
    truncated: element(xml, "IsTruncated") === "true",
    nextKeyMarker: element(xml, "NextKeyMarker"),
    nextVersionIdMarker: element(xml, "NextVersionIdMarker"),
  };
}
