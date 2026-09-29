/**
 * AgentForEach Skills Layer — Export Blob Store
 *
 * Uploads sandbox-generated files to Azure Blob Storage and generates
 * time-limited SAS download URLs for the user.
 *
 * Storage layout:
 *   user-exports/               (blob container)
 *     {userId}/{uuid}_{filename}
 *
 * Flow:
 *   1. LLM creates a file in sandbox via sandbox_exec / sandbox_file_write
 *   2. LLM calls sandbox_file_export(filename)
 *   3. Server reads binary from sandbox → uploads to Blob → returns SAS URL
 *   4. LLM presents download link to user
 *
 * SAS URLs are read-only, HTTPS-only, 24-hour expiry by default.
 */

import {
  BlobServiceClient,
  type ContainerClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  SASProtocol,
  type UserDelegationKey,
} from "@azure/storage-blob";
import type { TokenCredential } from "@azure/core-auth";
import { createHash, randomUUID } from "node:crypto";
import { loadSkillsConfig } from "../config.js";
import { DEFAULT_MAX_EXPORT_BYTES, exportTooLargeError } from "./shared.js";
import { createAzureTokenCredential } from "../../utils/azure-token.js";

/** Storage account reached with a managed identity instead of a key. */
export type StorageIdentity = { accountName: string; credential: TokenCredential };

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
    credential: createAzureTokenCredential(
      "https://storage.azure.com",
      process.env.AzureWebJobsStorage__clientId || undefined,
    ) as unknown as TokenCredential,
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Default SAS URL expiry in hours. */
const DEFAULT_EXPIRY_HOURS = 24;


/** Container name for user exports — default. */
const DEFAULT_EXPORTS_CONTAINER_NAME = "user-exports";

// ============================================================================
// Export Result
// ============================================================================

export interface ExportUploadResult {
  /** Public download URL with SAS token. */
  downloadUrl: string;
  /** Blob path within the container. */
  blobPath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** SAS URL expiry (ISO timestamp). */
  expiresAt: string;
}

// ============================================================================
// Export Blob Store
// ============================================================================

export class ExportBlobStore {
  private readonly containerClient: ContainerClient;
  private readonly blobServiceClient: BlobServiceClient;
  /** Key-based accounts sign SAS with the key; identity-based ones with a user delegation key. */
  private readonly sharedKeyCredential?: StorageSharedKeyCredential;
  private delegationKey?: { key: UserDelegationKey; expiresAt: number };
  private readonly accountName: string;
  private readonly containerName: string;
  private readonly maxExportBytes: number;
  private readonly defaultExpiryHours: number;

  /**
   * @param storage - A shared-key connection string (not SAS-based: SAS
   *        tokens are signed with the key), or an account reached with a
   *        managed identity (SAS signed with a user delegation key; the
   *        identity needs a blob data role).
   */
  constructor(storage: string | StorageIdentity) {
    if (typeof storage === "string") {
      const accountMatch = storage.match(/AccountName=([^;]+)/i);
      const keyMatch = storage.match(/AccountKey=([^;]+)/i);
      if (!accountMatch || !keyMatch) {
        throw new Error(
          "ExportBlobStore requires a shared-key connection string " +
            "(must contain AccountName and AccountKey)",
        );
      }
      this.accountName = accountMatch[1];
      this.sharedKeyCredential = new StorageSharedKeyCredential(this.accountName, keyMatch[1]);
      this.blobServiceClient = BlobServiceClient.fromConnectionString(storage);
    } else {
      this.accountName = storage.accountName;
      this.blobServiceClient = new BlobServiceClient(
        `https://${storage.accountName}.blob.core.windows.net`,
        storage.credential,
      );
    }

    const sandboxCfg = loadSkillsConfig().sandbox;
    this.containerName = sandboxCfg?.exportsContainerName ?? DEFAULT_EXPORTS_CONTAINER_NAME;
    this.maxExportBytes = sandboxCfg?.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES;
    this.defaultExpiryHours = sandboxCfg?.exportExpiryHours ?? DEFAULT_EXPIRY_HOURS;

    this.containerClient = this.blobServiceClient.getContainerClient(
      this.containerName,
    );
  }

  /** A user delegation key valid past `until` (fetched at most hourly-ish). */
  private async userDelegationKey(until: Date): Promise<UserDelegationKey> {
    if (this.delegationKey && this.delegationKey.expiresAt > until.getTime()) {
      return this.delegationKey.key;
    }
    // Delegation keys last up to 7 days; take a day past the SAS expiry.
    const startsOn = new Date(Date.now() - 5 * 60_000);
    const expiresOn = new Date(Math.min(until.getTime() + 86_400_000, Date.now() + 7 * 86_400_000 - 60_000));
    const key = await this.blobServiceClient.getUserDelegationKey(startsOn, expiresOn);
    this.delegationKey = { key, expiresAt: expiresOn.getTime() };
    return key;
  }

  /**
   * Upload a file to the exports container and return a SAS download URL.
   *
   * @param userId - User ID for path-based isolation.
   * @param filename - Original filename (sanitized for blob path).
   * @param content - File content as a Buffer.
   * @param expiryHours - SAS expiry in hours (default: 24).
   * @returns Upload result with download URL and metadata.
   */
  async upload(
    userId: string,
    filename: string,
    content: Buffer,
    expiryHours = this.defaultExpiryHours,
  ): Promise<ExportUploadResult> {
    if (content.length > this.maxExportBytes) throw exportTooLargeError(this.maxExportBytes);

    // Ensure container exists (idempotent — only creates on first call)
    await this.containerClient.createIfNotExists();

    // Build blob path: {userId}/{uuid}_{sanitized_filename}
    const safeFilename = this.sanitizeFilename(filename);
    const blobPath = `${this.userFolder(userId)}/${randomUUID()}_${safeFilename}`;

    // Upload
    const blockBlobClient =
      this.containerClient.getBlockBlobClient(blobPath);

    const contentType = this.inferContentType(safeFilename);
    await blockBlobClient.upload(content, content.length, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobContentDisposition: `attachment; filename="${safeFilename}"`,
      },
    });

    // Generate SAS URL
    const expiresOn = new Date();
    expiresOn.setHours(expiresOn.getHours() + expiryHours);

    const sasValues = {
      containerName: this.containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"), // read-only
      expiresOn,
      protocol: SASProtocol.Https,
    };
    const sasParams = this.sharedKeyCredential
      ? generateBlobSASQueryParameters(sasValues, this.sharedKeyCredential)
      : generateBlobSASQueryParameters(sasValues, await this.userDelegationKey(expiresOn), this.accountName);

    const downloadUrl = `${blockBlobClient.url}?${sasParams.toString()}`;

    return {
      downloadUrl,
      blobPath,
      sizeBytes: content.length,
      expiresAt: expiresOn.toISOString(),
    };
  }

  /** Delete every file exported for `userId` (account erasure). */
  async deleteUserFiles(userId: string): Promise<number> {
    let deleted = 0;
    const prefix = `${this.userFolder(userId)}/`;
    if (!(await this.containerClient.exists())) return 0; // nothing exported yet
    for await (const blob of this.containerClient.listBlobsFlat({ prefix })) {
      const { succeeded } = await this.containerClient.deleteBlob(blob.name, { deleteSnapshots: "include" }).then(
        () => ({ succeeded: true }),
        (err: { statusCode?: number }) => {
          if (err.statusCode === 404) return { succeeded: false };
          throw err;
        },
      );
      if (succeeded) deleted++;
    }
    return deleted;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Sanitize filename for safe blob path. */
  private sanitizeFilename(filename: string): string {
    // Remove null bytes, path traversal, leading slashes
    let safe = filename.replace(/\0/g, "");
    let prev = "";
    while (safe !== prev) {
      prev = safe;
      safe = safe.replace(/\.\./g, "");
    }
    safe = safe.replace(/^\/+/, "");
    // Keep only the basename (no subdirs)
    const lastSlash = safe.lastIndexOf("/");
    if (lastSlash >= 0) safe = safe.slice(lastSlash + 1);
    return safe || "exported-file";
  }

  /**
   * The user's folder: a hash of the id, so distinct users never share one
   * (sanitising characters would map "a:b" and "a_b" together, and erasing
   * one would delete the other's files).
   */
  private userFolder(userId: string): string {
    return createHash("sha256").update(userId).digest("hex").slice(0, 32);
  }

  /** Infer content type from filename extension. */
  private inferContentType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const types: Record<string, string> = {
      csv: "text/csv",
      json: "application/json",
      txt: "text/plain",
      md: "text/markdown",
      html: "text/html",
      xml: "application/xml",
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      webp: "image/webp",
      zip: "application/zip",
      tar: "application/x-tar",
      gz: "application/gzip",
      py: "text/x-python",
      js: "text/javascript",
      ts: "text/typescript",
      sh: "text/x-shellscript",
      yaml: "text/yaml",
      yml: "text/yaml",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
    return types[ext] ?? "application/octet-stream";
  }
}
