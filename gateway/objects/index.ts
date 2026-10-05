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
 *       BUCKETS             optional JSON map from container to bucket, or to
 *                           bucket/prefix/ to share one bucket, e.g.
 *                           {"skills":"acme/skills/","user-exports":"acme/exports/"};
 *                           default: the container name
 *       ADDRESSING          `path` (default) or `virtual`
 *       EXPECTED_BUCKET_OWNER  the buckets' AWS account ID, checked by S3 on every request
 *       KMS_KEY_ID          encrypt uploads with this KMS key (SSE-KMS)
 *       DELETE_VERSIONS     `true`: erasure deletes every version (versioned buckets)
 *       TIMEOUT_MS          per attempt; default 30000
 *       MAX_SIGNED_URL_SECONDS  sign download links for at most this long
 *     A host with an identity of its own (AWS Lambda) installs it with
 *     `installS3Defaults`; then the keys, and the endpoint and region, may
 *     be left out. The provider is never chosen for it: on AWS,
 *     OBJECT_STORE_PROVIDER=s3 must be set, and leaving it unset is an error.
 */

import type { TokenCredential } from "@azure/core-auth";
import { hostInfo } from "../runtime/host.js";
import { S3ObjectStore, signLink, type AwsCredentials, type ObjectInfo, type ObjectStore } from "@agentforeach/platform";

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
  const configured = process.env.OBJECT_STORE_PROVIDER?.trim();
  // On AWS the Azure default can only be a missing setting: fail, never fall back.
  if (!configured && (hostInfo().platform === "aws" || process.env.AWS_LAMBDA_FUNCTION_NAME)) {
    throw new Error("[objects] OBJECT_STORE_PROVIDER is not set on this AWS host: set OBJECT_STORE_PROVIDER=s3");
  }
  const provider = configured || "azure-blob";
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

  async signedUrlWithExpiry(...args: Parameters<NonNullable<ObjectStore["signedUrlWithExpiry"]>>): ReturnType<NonNullable<ObjectStore["signedUrlWithExpiry"]>> {
    return signLink(await this.resolve(), ...args);
  }
}

/**
 * What the host itself brings to the `s3` provider: its own credentials
 * (the AWS pack's credential chain on Lambda), and the endpoint and region
 * they are for. Used when the `OBJECT_STORE_S3_*` keys are not set.
 */
export type S3Defaults = {
  credentials: () => Promise<AwsCredentials>;
  endpoint?: string;
  region?: string;
  addressing?: "path" | "virtual";
  /** Erasure deletes every version unless OBJECT_STORE_S3_DELETE_VERSIONS says otherwise. */
  deleteVersions?: boolean;
  /**
   * The longest download link, unless OBJECT_STORE_S3_MAX_SIGNED_URL_SECONDS
   * says otherwise: for credentials that carry no expiration.
   */
  maxSignedUrlSeconds?: number;
};
let s3Defaults: S3Defaults | undefined;

/**
 * Installs the host's own S3 access. The AWS entry installs the pack's
 * credential chain, so the gateway never imports an AWS SDK itself. It does
 * not choose the provider: OBJECT_STORE_PROVIDER does.
 */
export function installS3Defaults(defaults: S3Defaults | undefined): void {
  s3Defaults = defaults;
}

/**
 * The `s3` provider from `OBJECT_STORE_S3_*` and the host's `S3Defaults`, or
 * undefined (with a warning) when the endpoint or keys are missing, or two
 * containers would share objects.
 */
export function s3ObjectStorage(env: Record<string, string | undefined> = process.env, defaults: S3Defaults | undefined = s3Defaults): ObjectStorageOpener | undefined {
  const endpoint = env.OBJECT_STORE_S3_ENDPOINT?.trim() || defaults?.endpoint;
  const accessKeyId = env.OBJECT_STORE_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.OBJECT_STORE_S3_SECRET_ACCESS_KEY?.trim();
  const credentials = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : defaults?.credentials;
  if (!endpoint || !credentials) {
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
  /** "bucket" or "bucket/prefix/" → its bucket and prefix. */
  const location = (container: string) => {
    const value = buckets[container] ?? container;
    const slash = value.indexOf("/");
    if (slash < 0) return { bucket: value, prefix: "" };
    const prefix = value.slice(slash + 1);
    return { bucket: value.slice(0, slash), prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix };
  };
  const locations = Object.keys(buckets).map((container) => ({ container, ...location(container) }));
  for (const a of locations) {
    for (const b of locations) {
      if (a.container < b.container && a.bucket === b.bucket && (a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix))) {
        console.warn(`[objects] OBJECT_STORE_S3_BUCKETS puts "${a.container}" and "${b.container}" in overlapping places of bucket ${a.bucket}; give them separate buckets or prefixes. Object storage is off`);
        return undefined;
      }
    }
  }
  const addressing = (env.OBJECT_STORE_S3_ADDRESSING?.trim() || defaults?.addressing) === "virtual" ? "virtual" : "path";
  const region = env.OBJECT_STORE_S3_REGION?.trim() || defaults?.region || (new URL(endpoint).hostname.endsWith(".r2.cloudflarestorage.com") ? "auto" : undefined);
  const deleteVersions = env.OBJECT_STORE_S3_DELETE_VERSIONS?.trim() ? env.OBJECT_STORE_S3_DELETE_VERSIONS.trim() === "true" : defaults?.deleteVersions;
  const timeoutMs = Number(env.OBJECT_STORE_S3_TIMEOUT_MS) || undefined;
  const maxSignedUrlSeconds = Number(env.OBJECT_STORE_S3_MAX_SIGNED_URL_SECONDS) || defaults?.maxSignedUrlSeconds;
  return {
    provider: "s3",
    open: (container, options = {}) =>
      new S3ObjectStore({
        endpoint,
        ...location(container),
        region,
        credentials,
        addressing,
        expectedBucketOwner: env.OBJECT_STORE_S3_EXPECTED_BUCKET_OWNER?.trim() || undefined,
        kmsKeyId: env.OBJECT_STORE_S3_KMS_KEY_ID?.trim() || undefined,
        deleteVersions,
        timeoutMs,
        maxSignedUrlSeconds,
        // A host's own identity uses buckets its deployment provisioned.
        createBucket: options.createContainer && credentials !== defaults?.credentials,
      }),
  };
}
