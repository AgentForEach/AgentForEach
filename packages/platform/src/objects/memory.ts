/**
 * AgentForEach Platform — In-memory object store
 *
 * For tests and local runs without a cloud. It passes the same conformance
 * suite as the cloud providers; its signed URLs are well-formed but point at
 * a reserved `.invalid` host, so nothing can fetch them. A link's `expires`
 * parameter is when it would stop working.
 */

import { assertValidKey, isDirectoryMarker, ObjectStoreError, signedUrlLifetime } from "./errors.js";
import type { GetObjectOptions, ObjectInfo, ObjectStore, PutObjectOptions, SignedUrl, SignedUrlOptions } from "./types.js";

type StoredObject = {
  bytes: Uint8Array;
  lastModified: Date;
  contentType?: string;
  contentDisposition?: string;
};

export type MemoryObjectStoreOptions = {
  /** Bucket name used in signed URLs. Default "memory". */
  bucket?: string;
  /**
   * When the (pretend) signing credentials expire, if they do: links are
   * cut short to end 60 s before, as the s3 provider's are.
   */
  credentialsExpireAt?: () => Date | undefined;
  now?: () => Date;
};

export class MemoryObjectStore implements ObjectStore {
  readonly provider = "memory";
  private readonly objects = new Map<string, StoredObject>();
  private readonly bucket: string;
  private readonly credentialsExpireAt: () => Date | undefined;
  private readonly now: () => Date;

  constructor(options: MemoryObjectStoreOptions = {}) {
    this.bucket = options.bucket ?? "memory";
    this.credentialsExpireAt = options.credentialsExpireAt ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  async *list(prefix = ""): AsyncIterable<ObjectInfo> {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && !isDirectoryMarker(k)).sort();
    for (const key of keys) {
      const object = this.objects.get(key);
      if (object) yield { key, size: object.bytes.byteLength, lastModified: object.lastModified };
    }
  }

  async get(key: string, options: GetObjectOptions = {}): Promise<Uint8Array> {
    assertValidKey(key);
    const object = this.objects.get(key);
    if (!object) throw new ObjectStoreError("not_found", `Object not found: ${key}`);
    if (options.maxBytes !== undefined && object.bytes.byteLength > options.maxBytes) {
      throw new ObjectStoreError("too_large", `Object ${key} is larger than ${options.maxBytes} bytes`);
    }
    return object.bytes.slice();
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    return this.objects.has(key);
  }

  async put(key: string, body: Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    assertValidKey(key);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body.slice();
    this.objects.set(key, { bytes, lastModified: this.now(), ...options });
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix) throw new ObjectStoreError("invalid", "deletePrefix needs a non-empty prefix");
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix) && this.objects.delete(key)) deleted++;
    }
    return deleted;
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    return (await this.signedUrlWithExpiry(key, options)).url;
  }

  async signedUrlWithExpiry(key: string, options: SignedUrlOptions): Promise<SignedUrl> {
    assertValidKey(key);
    const { expiresAt } = signedUrlLifetime(options.expiresAt, this.now(), { credentialsExpireAt: this.credentialsExpireAt() });
    const path = key.split("/").map(encodeURIComponent).join("/");
    return { url: `https://objects.memory.invalid/${encodeURIComponent(this.bucket)}/${path}?expires=${expiresAt.toISOString()}`, expiresAt };
  }
}
