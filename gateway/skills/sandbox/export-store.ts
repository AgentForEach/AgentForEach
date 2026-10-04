/**
 * AgentForEach Skills Layer — Export Blob Store
 *
 * Uploads sandbox-generated files to object storage (Azure Blob Storage by
 * default; see ../../objects) and returns time-limited signed download URLs.
 *
 * Storage layout:
 *   user-exports/               (blob container)
 *     {userId}/{uuid}_{filename}
 *
 * Flow:
 *   1. LLM creates a file in sandbox via sandbox_exec / sandbox_file_write
 *   2. LLM calls sandbox_file_export(filename)
 *   3. Server reads binary from sandbox → uploads → returns a signed URL
 *   4. LLM presents download link to user
 *
 * Signed URLs are read-only, with a 24-hour expiry by default (Azure SAS
 * links are also HTTPS-only).
 */

import type { ObjectStore } from "@agentforeach/platform";
import { createHash, randomUUID } from "node:crypto";
import { loadSkillsConfig } from "../config.js";
import { DEFAULT_MAX_EXPORT_BYTES, exportTooLargeError } from "@agentforeach/platform/sandbox/shared";
import { openObjectStore, type ObjectStorage } from "../../objects/index.js";

export { resolveRuntimeStorage, type StorageIdentity } from "../../objects/index.js";

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
  private readonly objects: ObjectStore;
  private readonly maxExportBytes: number;
  private readonly defaultExpiryHours: number;

  /**
   * @param storage - A shared-key connection string (not SAS-based: SAS
   *        tokens are signed with the key), an account reached with a
   *        managed identity (SAS signed with a user delegation key; the
   *        identity needs a blob data role), or another object storage
   *        provider.
   */
  constructor(storage: ObjectStorage) {
    if (typeof storage === "string") {
      if (!/AccountName=([^;]+)/i.test(storage) || !/AccountKey=([^;]+)/i.test(storage)) {
        throw new Error(
          "ExportBlobStore requires a shared-key connection string " +
            "(must contain AccountName and AccountKey)",
        );
      }
    }

    const sandboxCfg = loadSkillsConfig().sandbox;
    const containerName = sandboxCfg?.exportsContainerName ?? DEFAULT_EXPORTS_CONTAINER_NAME;
    this.maxExportBytes = sandboxCfg?.maxExportBytes ?? DEFAULT_MAX_EXPORT_BYTES;
    this.defaultExpiryHours = sandboxCfg?.exportExpiryHours ?? DEFAULT_EXPIRY_HOURS;

    // The container is created on the first upload if it doesn't exist yet.
    this.objects = openObjectStore(storage, containerName, { createContainer: true });
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

    // Build blob path: {userId}/{uuid}_{sanitized_filename}
    const safeFilename = this.sanitizeFilename(filename);
    const blobPath = `${this.userFolder(userId)}/${randomUUID()}_${safeFilename}`;

    await this.objects.put(blobPath, content, {
      contentType: this.inferContentType(safeFilename),
      contentDisposition: `attachment; filename="${safeFilename}"`,
    });

    // Read-only download link
    const expiresOn = new Date();
    expiresOn.setHours(expiresOn.getHours() + expiryHours);
    const downloadUrl = await this.objects.signedUrl(blobPath, { expiresAt: expiresOn });

    return {
      downloadUrl,
      blobPath,
      sizeBytes: content.length,
      expiresAt: expiresOn.toISOString(),
    };
  }

  /** Delete every file exported for `userId` (account erasure). */
  async deleteUserFiles(userId: string): Promise<number> {
    return this.objects.deletePrefix(`${this.userFolder(userId)}/`);
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
