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
 * DeleteObject and a presigned GetObject. `deletePrefix` deletes objects one
 * by one: the batch DeleteObjects call needs a `Content-MD5` header, and
 * WebCrypto has no MD5.
 */

import { assertValidKey, codeForStatus, isObjectNotFound, ObjectStoreError, readCapped, signedUrlSeconds } from "./errors.js";
import { presignUrl, sha256Hex, signRequest, uriEncode, type AwsCredentials, type SigningScope } from "./sigv4.js";
import type { GetObjectOptions, ObjectInfo, ObjectStore, PutObjectOptions, SignedUrlOptions } from "./types.js";

export type S3ObjectStoreOptions = {
  /** Service origin, e.g. `https://s3.us-west-2.amazonaws.com` or `http://localhost:9000`. */
  endpoint: string;
  bucket: string;
  /** Signing region; `auto` for R2. Default `us-east-1`. */
  region?: string;
  /** Static keys, or a function returning fresh ones (temporary credentials). */
  credentials: AwsCredentials | (() => Promise<AwsCredentials>);
  /**
   * `path` sends `<endpoint>/<bucket>/<key>`; `virtual` sends
   * `<bucket>.<endpoint host>/<key>`. Default `path`, which every
   * S3-compatible service accepts.
   */
  addressing?: "path" | "virtual";
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
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
};

export class S3ObjectStore implements ObjectStore {
  readonly provider = "s3";
  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly credentials: S3ObjectStoreOptions["credentials"];
  private readonly addressing: "path" | "virtual";
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
    this.createBucket = options.createBucket ?? false;
    this.listPageSize = Math.min(1000, Math.max(1, options.listPageSize ?? 1000));
    this.deleteConcurrency = Math.max(1, options.deleteConcurrency ?? 8);
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  async *list(prefix = ""): AsyncIterable<ObjectInfo> {
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", "max-keys": String(this.listPageSize) };
      if (prefix) query.prefix = prefix;
      if (continuationToken) query["continuation-token"] = continuationToken;
      const response = await this.send({ method: "GET", query });
      const xml = await response.text();
      if (!response.ok) throw await this.error(response, "list", prefix, xml);
      const page = parseListObjectsV2(xml);
      for (const object of page.objects) yield object;
      continuationToken = page.truncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
  }

  async get(key: string, options: GetObjectOptions = {}): Promise<Uint8Array> {
    assertValidKey(key);
    const response = await this.send({ method: "GET", key });
    if (!response.ok) throw await this.error(response, "get", key);
    const length = Number(response.headers.get("content-length"));
    if (options.maxBytes !== undefined && Number.isFinite(length) && length > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new ObjectStoreError("too_large", `Object ${key} is larger than ${options.maxBytes} bytes`);
    }
    return readCapped(response.body, options.maxBytes, key);
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    const response = await this.send({ method: "HEAD", key });
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw await this.error(response, "exists", key);
  }

  async put(key: string, body: Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    assertValidKey(key);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const headers: Record<string, string> = {};
    if (options.contentType) headers["content-type"] = options.contentType;
    if (options.contentDisposition) headers["content-disposition"] = options.contentDisposition;

    let response = await this.send({ method: "PUT", key, headers, body: bytes });
    if (response.status === 404 && this.createBucket) {
      const text = await response.text();
      if (errorCode(text) !== "NoSuchBucket") throw await this.error(response, "put", key, text);
      await this.ensureBucket();
      response = await this.send({ method: "PUT", key, headers, body: bytes });
    }
    if (!response.ok) throw await this.error(response, "put", key);
    await response.body?.cancel().catch(() => {});
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix) throw new ObjectStoreError("invalid", "deletePrefix needs a non-empty prefix");
    const keys: string[] = [];
    try {
      for await (const object of this.list(prefix)) keys.push(object.key);
    } catch (err) {
      if (isObjectNotFound(err)) return 0; // no bucket, nothing to delete
      throw err;
    }

    let deleted = 0;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < keys.length) {
        const key = keys[next++];
        const response = await this.send({ method: "DELETE", key });
        await response.body?.cancel().catch(() => {});
        if (response.ok) deleted++;
        else if (response.status !== 404) throw await this.error(response, "delete", key);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.deleteConcurrency, keys.length) }, worker));
    return deleted;
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    assertValidKey(key);
    const now = this.now();
    const expiresInSeconds = signedUrlSeconds(options.expiresAt, now);
    const url = await presignUrl(await this.scope(), { method: "GET", url: this.url(key), expiresInSeconds, now });
    return url.toString();
  }

  private async ensureBucket(): Promise<void> {
    // us-east-1 and R2's `auto` take no location; everywhere else needs one.
    const body =
      this.region === "us-east-1" || this.region === "auto"
        ? undefined
        : new TextEncoder().encode(
            `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${this.region}</LocationConstraint></CreateBucketConfiguration>`,
          );
    const response = await this.send({ method: "PUT", body });
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

  private async send(input: SendInput): Promise<Response> {
    const url = this.url(input.key, input.query);
    const body = input.body ?? new Uint8Array(0);
    const headers = await signRequest(await this.scope(), {
      method: input.method,
      url,
      headers: input.headers,
      payloadHash: await sha256Hex(body),
      now: this.now(),
    });
    delete headers["host"]; // fetch sets it, and refuses it from callers
    try {
      return await this.fetchFn(url, {
        method: input.method,
        headers,
        body: input.method === "PUT" ? (body as BodyInit) : undefined,
      });
    } catch (err) {
      throw new ObjectStoreError("unavailable", `S3 ${input.method} ${url.pathname} failed: ${String(err)}`, { cause: err });
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
