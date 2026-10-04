/**
 * AgentForEach — Object storage
 *
 * Where the gateway keeps blobs: skill definitions (`skills`) and sandbox
 * exports (`user-exports`). Each is one container of an `ObjectStore`
 * (`@agentforeach/platform`), and `OBJECT_STORE_PROVIDER` picks the provider:
 *
 *   - `azure-blob` (default): the Functions host's storage account, from a
 *     connection string or `AzureWebJobsStorage__accountName` (+ `__clientId`)
 *     with a managed identity.
 *   - `s3`: any S3-compatible service (Amazon S3, Cloudflare R2, GCS
 *     interoperability, MinIO), configured with `OBJECT_STORE_S3_*`:
 *       ENDPOINT            e.g. https://<account>.r2.cloudflarestorage.com
 *       REGION              default `auto` for R2 endpoints, us-east-1 otherwise
 *       ACCESS_KEY_ID, SECRET_ACCESS_KEY
 *       BUCKETS             optional JSON map from container to bucket,
 *                           e.g. {"skills":"acme-skills"}; default: the container name
 *       ADDRESSING          `path` (default) or `virtual`
 */

import type { TokenCredential } from "@azure/core-auth";
import { S3ObjectStore, type ObjectInfo, type ObjectStore } from "@agentforeach/platform";

/** Storage account reached with a managed identity instead of a key. */
export type StorageIdentity = { accountName: string; credential: TokenCredential };

/** Opens one container of a non-Azure provider. */
export interface ObjectStorageOpener {
  readonly provider: string;
  open(container: string, options?: OpenObjectStoreOptions): ObjectStore;
}

/** A connection string or identity (Azure Blob Storage), or another provider. */
export type ObjectStorage = string | StorageIdentity | ObjectStorageOpener;

export type OpenObjectStoreOptions = {
  /** Create the container or bucket on write if it is missing. */
  createContainer?: boolean;
};

/**
 * The storage account as the Functions host sees it: a key connection string
 * (AzureWebJobsStorage) or, with identity-based connections,
 * AzureWebJobsStorage__accountName (+ __clientId for a user-assigned identity).
 */
export function resolveRuntimeStorage(connectionString?: string): string | StorageIdentity | undefined {
  if (connectionString) return connectionString;
  const accountName = process.env.AzureWebJobsStorage__accountName;
  if (!accountName) return undefined;
  return {
    accountName,
    credential: lazyAzureCredential("https://storage.azure.com", process.env.AzureWebJobsStorage__clientId || undefined),
  };
}

/**
 * A managed-identity credential whose token code (which can shell out to
 * the Azure CLI locally) loads on the first token request, so hosts that
 * never reach Azure never bundle it.
 */
function lazyAzureCredential(resource: string, clientId?: string): TokenCredential {
  let credential: Promise<TokenCredential> | undefined;
  return {
    async getToken(scopes, options) {
      credential ??= import("@agentforeach/platform-azure/identity").then(
        (m) => m.createAzureTokenCredential(resource, clientId) as unknown as TokenCredential,
      );
      return (await credential).getToken(scopes, options);
    },
  };
}

/**
 * The configured object storage, or undefined when none is configured.
 * `connectionString` is the Azure one from config, used by `azure-blob`.
 */
export function resolveObjectStorage(connectionString?: string): ObjectStorage | undefined {
  const provider = process.env.OBJECT_STORE_PROVIDER?.trim() || "azure-blob";
  if (provider === "azure-blob") return resolveRuntimeStorage(connectionString);
  if (provider === "s3") return s3ObjectStorage();
  console.warn(`[objects] unknown OBJECT_STORE_PROVIDER "${provider}" (expected azure-blob or s3); object storage is off`);
  return undefined;
}

type AzureBlobConstructor = (storage: string | StorageIdentity, container: string, options: OpenObjectStoreOptions) => ObjectStore;
let azureBlob: AzureBlobConstructor | undefined;

/**
 * Builds azure-blob stores eagerly. The Azure entry installs this, so a store
 * is built (and a malformed connection string fails) when it's opened, as it
 * always has been. Elsewhere the Azure SDK loads on first use, so hosts that
 * never use Azure never bundle it.
 */
export function installAzureBlob(create: AzureBlobConstructor | undefined): void {
  azureBlob = create;
}

/** One container of `storage`. */
export function openObjectStore(storage: ObjectStorage, container: string, options: OpenObjectStoreOptions = {}): ObjectStore {
  if (typeof storage === "object" && "open" in storage) return storage.open(container, options);
  if (azureBlob) return azureBlob(storage, container, options);
  return new LazyObjectStore("azure-blob", async () => {
    const { AzureBlobObjectStore } = await import("@agentforeach/platform-azure/objects");
    return new AzureBlobObjectStore(storage, container, { createContainer: options.createContainer });
  });
}

/** An object store built on first use. */
export class LazyObjectStore implements ObjectStore {
  private store?: Promise<ObjectStore>;

  constructor(
    readonly provider: string,
    private readonly create: () => Promise<ObjectStore>,
  ) {}

  /** The underlying store, built once. */
  resolve(): Promise<ObjectStore> {
    this.store ??= this.create();
    return this.store;
  }

  async *list(prefix?: string): AsyncIterable<ObjectInfo> {
    yield* (await this.resolve()).list(prefix);
  }

  async get(...args: Parameters<ObjectStore["get"]>): ReturnType<ObjectStore["get"]> {
    return (await this.resolve()).get(...args);
  }

  async exists(...args: Parameters<ObjectStore["exists"]>): ReturnType<ObjectStore["exists"]> {
    return (await this.resolve()).exists(...args);
  }

  async put(...args: Parameters<ObjectStore["put"]>): ReturnType<ObjectStore["put"]> {
    return (await this.resolve()).put(...args);
  }

  async deletePrefix(...args: Parameters<ObjectStore["deletePrefix"]>): ReturnType<ObjectStore["deletePrefix"]> {
    return (await this.resolve()).deletePrefix(...args);
  }

  async signedUrl(...args: Parameters<ObjectStore["signedUrl"]>): ReturnType<ObjectStore["signedUrl"]> {
    return (await this.resolve()).signedUrl(...args);
  }
}

/** The `s3` provider from `OBJECT_STORE_S3_*`, or undefined (with a warning) when the endpoint or keys are missing. */
export function s3ObjectStorage(env: Record<string, string | undefined> = process.env): ObjectStorageOpener | undefined {
  const endpoint = env.OBJECT_STORE_S3_ENDPOINT?.trim();
  const accessKeyId = env.OBJECT_STORE_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.OBJECT_STORE_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    console.warn("[objects] OBJECT_STORE_PROVIDER=s3 needs OBJECT_STORE_S3_ENDPOINT, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY; object storage is off");
    return undefined;
  }
  let buckets: Record<string, string> = {};
  if (env.OBJECT_STORE_S3_BUCKETS?.trim()) {
    try {
      buckets = JSON.parse(env.OBJECT_STORE_S3_BUCKETS) as Record<string, string>;
    } catch {
      console.warn("[objects] OBJECT_STORE_S3_BUCKETS is not valid JSON; using the container names as bucket names");
    }
  }
  const addressing = env.OBJECT_STORE_S3_ADDRESSING?.trim() === "virtual" ? "virtual" : "path";
  return {
    provider: "s3",
    open: (container, options = {}) =>
      new S3ObjectStore({
        endpoint,
        bucket: buckets[container] ?? container,
        region: env.OBJECT_STORE_S3_REGION?.trim() || (new URL(endpoint).hostname.endsWith(".r2.cloudflarestorage.com") ? "auto" : undefined),
        credentials: { accessKeyId, secretAccessKey },
        addressing,
        createBucket: options.createContainer,
      }),
  };
}
