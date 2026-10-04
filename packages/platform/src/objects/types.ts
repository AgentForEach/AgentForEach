/**
 * AgentForEach Platform — Object store port
 *
 * The cloud-neutral interface the gateway uses for blobs: skill files and
 * skill zips (read), and sandbox exports (write, signed download link,
 * delete on account erasure). One store is one bucket or container.
 *
 * Providers: `memory` (tests), `s3` (S3, R2, GCS interoperability, MinIO) and
 * `azure-blob` (platform-azure). Every provider passes the conformance suite
 * in `./conformance.ts`.
 *
 * Keys are `/`-separated paths with no leading `/`. Missing objects and
 * oversize reads raise `ObjectStoreError` (see `./errors.ts`), never return
 * partial data.
 */

/** One object in a listing. */
export type ObjectInfo = {
  key: string;
  /** Size in bytes. */
  size: number;
  lastModified?: Date;
};

export type GetObjectOptions = {
  /**
   * Refuse objects larger than this, with code `too_large`. The read stops
   * as soon as the limit is passed, so an oversize object is never buffered.
   */
  maxBytes?: number;
};

export type PutObjectOptions = {
  /** Stored and returned as `Content-Type` on download. */
  contentType?: string;
  /** Stored and returned as `Content-Disposition` on download. */
  contentDisposition?: string;
};

export type SignedUrlOptions = {
  /**
   * When the link stops working. Every provider signs links up to 7 days
   * ahead; some go further (a key-signed Azure SAS has no limit).
   */
  expiresAt: Date;
};

export interface ObjectStore {
  /** Provider name, for logs: `memory`, `s3`, `azure-blob`. */
  readonly provider: string;

  /**
   * Every object whose key starts with `prefix` (all objects when omitted),
   * in key order. Pages are fetched lazily. Throws `not_found` when the
   * bucket or container does not exist.
   */
  list(prefix?: string): AsyncIterable<ObjectInfo>;

  /** The object's bytes. Throws `not_found` or `too_large`. */
  get(key: string, options?: GetObjectOptions): Promise<Uint8Array>;

  exists(key: string): Promise<boolean>;

  /**
   * Creates or replaces the object. Creates the bucket or container first if
   * the provider can and it does not exist yet.
   */
  put(key: string, body: Uint8Array | string, options?: PutObjectOptions): Promise<void>;

  /**
   * Deletes every object under `prefix` and returns how many were deleted.
   * A missing bucket or an object that disappears meanwhile is not an error.
   * `prefix` must be non-empty, so a bug cannot empty the whole store.
   */
  deletePrefix(prefix: string): Promise<number>;

  /**
   * A read-only URL for the object, valid until `expiresAt`. An expiry in
   * the past, or further ahead than the provider can sign, is `invalid`.
   */
  signedUrl(key: string, options: SignedUrlOptions): Promise<string>;
}

/**
 * Longest signed-URL lifetime every provider supports: SigV4 presigned URLs
 * (and so the s3 provider) stop here, and so does an Azure user delegation key.
 */
export const MAX_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
