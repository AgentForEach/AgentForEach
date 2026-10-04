/**
 * AgentForEach Platform Azure — Azure Blob Storage object store
 *
 * The `ObjectStore` port over one blob container. This is the code that was
 * in the gateway's `SkillBlobStore` and `ExportBlobStore`, moved here with
 * the same requests:
 *
 *   - `put` runs `createIfNotExists()` before every upload when
 *     `createContainer` is set, as exports always have.
 *   - SAS links are read-only and HTTPS-only, with no start time. A key
 *     account signs them with its key, for any expiry; an account reached
 *     with a managed identity signs them with a user delegation key, cached
 *     while it outlives the link, and the key itself lasts at most 7 days.
 *   - `deletePrefix` deletes blobs with their snapshots, ignores blobs that
 *     vanish meanwhile, and returns 0 when the container does not exist.
 */

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  type ContainerClient,
  type UserDelegationKey,
} from "@azure/storage-blob";
import type { TokenCredential } from "@azure/core-auth";
import {
  assertValidKey,
  codeForStatus,
  ObjectStoreError,
  readCapped,
  signedUrlSeconds,
  type GetObjectOptions,
  type ObjectInfo,
  type ObjectStore,
  type PutObjectOptions,
  type SignedUrlOptions,
} from "@agentforeach/platform";

/** A storage account reached with a managed identity instead of a key. */
export type AzureStorageIdentity = { accountName: string; credential: TokenCredential };

export type AzureBlobObjectStoreOptions = {
  /** Create the container (if missing) before every `put`. Default false. */
  createContainer?: boolean;
  now?: () => Date;
};

const DAY_MS = 86_400_000;

export class AzureBlobObjectStore implements ObjectStore {
  readonly provider = "azure-blob";
  private readonly service: BlobServiceClient;
  private readonly container: ContainerClient;
  private readonly accountName: string;
  private readonly sharedKey?: StorageSharedKeyCredential;
  private readonly createContainer: boolean;
  private readonly now: () => Date;
  private delegationKey?: { key: UserDelegationKey; expiresAt: number };

  /**
   * @param storage - A connection string, or an account reached with a
   *        managed identity (which needs a blob data role).
   * @param containerName - The blob container this store reads and writes.
   */
  constructor(storage: string | AzureStorageIdentity, containerName: string, options: AzureBlobObjectStoreOptions = {}) {
    if (typeof storage === "string") {
      this.service = BlobServiceClient.fromConnectionString(storage);
      if (this.service.credential instanceof StorageSharedKeyCredential) this.sharedKey = this.service.credential;
    } else {
      this.service = new BlobServiceClient(`https://${storage.accountName}.blob.core.windows.net`, storage.credential);
    }
    this.accountName = this.service.accountName;
    this.container = this.service.getContainerClient(containerName);
    this.createContainer = options.createContainer ?? false;
    this.now = options.now ?? (() => new Date());
  }

  /** The container's URL, without credentials. */
  get containerUrl(): string {
    return this.container.url;
  }

  async *list(prefix?: string): AsyncIterable<ObjectInfo> {
    try {
      for await (const blob of this.container.listBlobsFlat(prefix ? { prefix } : undefined)) {
        yield {
          key: blob.name,
          size: blob.properties.contentLength ?? 0,
          ...(blob.properties.lastModified ? { lastModified: blob.properties.lastModified } : {}),
        };
      }
    } catch (err) {
      throw mapError(err, "list", prefix ?? "");
    }
  }

  async get(key: string, options: GetObjectOptions = {}): Promise<Uint8Array> {
    assertValidKey(key);
    let response;
    try {
      response = await this.container.getBlobClient(key).download(0);
    } catch (err) {
      throw mapError(err, "get", key);
    }
    const stream = response.readableStreamBody;
    if (!stream) throw new ObjectStoreError("provider_error", `Empty blob: ${key}`);
    if (options.maxBytes !== undefined && (response.contentLength ?? 0) > options.maxBytes) {
      stream.resume();
      throw new ObjectStoreError("too_large", `Object ${key} is larger than ${options.maxBytes} bytes`);
    }
    try {
      return await readCapped(toWebStream(stream), options.maxBytes, key);
    } catch (err) {
      if (err instanceof ObjectStoreError) throw err;
      throw mapError(err, "get", key);
    }
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    try {
      return await this.container.getBlobClient(key).exists();
    } catch (err) {
      throw mapError(err, "exists", key);
    }
  }

  async put(key: string, body: Uint8Array | string, options: PutObjectOptions = {}): Promise<void> {
    assertValidKey(key);
    const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    try {
      if (this.createContainer) await this.container.createIfNotExists();
      await this.container.getBlockBlobClient(key).upload(bytes, bytes.length, {
        blobHTTPHeaders: {
          ...(options.contentType ? { blobContentType: options.contentType } : {}),
          ...(options.contentDisposition ? { blobContentDisposition: options.contentDisposition } : {}),
        },
      });
    } catch (err) {
      throw mapError(err, "put", key);
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix) throw new ObjectStoreError("invalid", "deletePrefix needs a non-empty prefix");
    try {
      if (!(await this.container.exists())) return 0; // nothing written yet
      let deleted = 0;
      for await (const blob of this.container.listBlobsFlat({ prefix })) {
        try {
          await this.container.deleteBlob(blob.name, { deleteSnapshots: "include" });
          deleted++;
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode !== 404) throw err;
        }
      }
      return deleted;
    } catch (err) {
      throw mapError(err, "deletePrefix", prefix);
    }
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    assertValidKey(key);
    // No upper limit: a key-signed SAS has none, and a delegation-signed one
    // is issued as before even though its key stops at 7 days.
    signedUrlSeconds(options.expiresAt, this.now(), Number.POSITIVE_INFINITY);
    const blob = this.container.getBlobClient(key);
    const values = {
      containerName: this.container.containerName,
      blobName: key,
      permissions: BlobSASPermissions.parse("r"),
      expiresOn: options.expiresAt,
      protocol: SASProtocol.Https,
    };
    try {
      const sas = this.sharedKey
        ? generateBlobSASQueryParameters(values, this.sharedKey)
        : generateBlobSASQueryParameters(values, await this.userDelegationKey(options.expiresAt), this.accountName);
      return `${blob.url}?${sas.toString()}`;
    } catch (err) {
      throw mapError(err, "signedUrl", key);
    }
  }

  /** A user delegation key valid past `until`. Keys last up to 7 days; take a day past the link's expiry. */
  private async userDelegationKey(until: Date): Promise<UserDelegationKey> {
    if (this.delegationKey && this.delegationKey.expiresAt > until.getTime()) return this.delegationKey.key;
    const now = this.now().getTime();
    const startsOn = new Date(now - 5 * 60_000);
    const expiresOn = new Date(Math.min(until.getTime() + DAY_MS, now + 7 * DAY_MS - 60_000));
    const key = await this.service.getUserDelegationKey(startsOn, expiresOn);
    this.delegationKey = { key, expiresAt: expiresOn.getTime() };
    return key;
  }
}

function mapError(err: unknown, operation: string, target: string): ObjectStoreError {
  if (err instanceof ObjectStoreError) return err;
  const e = err as { statusCode?: number; code?: string; message?: string };
  const code = typeof e?.statusCode === "number" ? codeForStatus(e.statusCode) : "unavailable";
  const detail = e?.code ? ` (${e.code})` : "";
  return new ObjectStoreError(code, `Azure Blob ${operation} ${target} failed${detail}: ${e?.message ?? String(err)}`, { cause: err });
}

/** Adapts the SDK's Node stream to the web stream `readCapped` reads. */
function toWebStream(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  const iterator = (stream as AsyncIterable<Buffer | string>)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(typeof value === "string" ? Buffer.from(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
