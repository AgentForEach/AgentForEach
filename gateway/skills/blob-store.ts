/**
 * AgentForEach Skills Layer — Blob Storage Adapter
 *
 * Reads SKILL.md files from Azure Blob Storage. Skills are stored as:
 *
 *   skills/               (blob container)
 *     weather/SKILL.md
 *     github/SKILL.md
 *     notion/SKILL.md
 *
 * Provides:
 *   - listSkills()  — scan all SKILL.md blobs, parse frontmatter, return manifests
 *   - readFile()    — read a specific file by path (with traversal protection)
 *
 * Manifests are cached in-memory with a 5-minute TTL to avoid re-scanning
 * Blob Storage on every request.
 */

import {
  BlobServiceClient,
  type ContainerClient,
} from "@azure/storage-blob";
import { parseSkillFrontmatter } from "./loader.js";
import type { StorageIdentity } from "./sandbox/export-store.js";
import { loadSkillsConfig } from "./config.js";
import type { SkillManifest, CredentialSpec } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Cache TTL in milliseconds (5 minutes) — default. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum SKILL.md file size to read (256 KB) — default. */
const DEFAULT_MAX_SKILL_FILE_BYTES = 256 * 1024;

/** Maximum skill zip file size to download (10 MB) — default. */
const DEFAULT_MAX_ZIP_FILE_BYTES = 10 * 1024 * 1024;

/** Blob name suffix for skill manifests. */
const SKILL_MD_SUFFIX = "/SKILL.md";

/** Blob name for the skill zip package within a skill folder. */
const SKILL_ZIP_NAME = "skill.zip";

// ============================================================================
// Skill Blob Store
// ============================================================================

export class SkillBlobStore {
  private containerClient: ContainerClient;
  private cachedManifests: SkillManifest[] | undefined;
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs: number;
  private readonly maxSkillFileBytes: number;
  private readonly maxZipFileBytes: number;

  /**
   * @param storage - A connection string, or an account reached with a
   *        managed identity (which needs blob read access).
   */
  constructor(storage: string | StorageIdentity, containerName = "skills") {
    const blobServiceClient = typeof storage === "string"
      ? BlobServiceClient.fromConnectionString(storage)
      : new BlobServiceClient(`https://${storage.accountName}.blob.core.windows.net`, storage.credential);
    this.containerClient = blobServiceClient.getContainerClient(containerName);

    const cfg = loadSkillsConfig();
    this.cacheTtlMs = cfg.blobStore.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxSkillFileBytes = cfg.blobStore.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES;
    this.maxZipFileBytes = cfg.blobStore.maxZipFileBytes ?? DEFAULT_MAX_ZIP_FILE_BYTES;
  }

  // --------------------------------------------------------------------------
  // List Skills
  // --------------------------------------------------------------------------

  /**
   * List all skill manifests by scanning SKILL.md blobs.
   *
   * Results are cached in-memory for 5 minutes. On cold start the first
   * call reads all SKILL.md frontmatters from Blob Storage.
   */
  async listSkills(): Promise<SkillManifest[]> {
    if (this.cachedManifests && Date.now() < this.cacheExpiresAt) {
      return this.cachedManifests;
    }

    const manifests: SkillManifest[] = [];

    for await (const blob of this.containerClient.listBlobsFlat()) {
      if (!blob.name.endsWith(SKILL_MD_SUFFIX)) continue;

      try {
        const content = await this.readBlobContent(blob.name);
        const manifest = this.parseManifest(content, blob.name);
        manifests.push(manifest);
      } catch {
        // Skip malformed SKILL.md files — log in production
      }
    }

    this.cachedManifests = manifests;
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;

    return manifests;
  }

  // --------------------------------------------------------------------------
  // Read File
  // --------------------------------------------------------------------------

  /**
   * Read a file from the skills blob container.
   *
   * @param path - Blob path relative to container (e.g., "weather/SKILL.md").
   * @returns File content as UTF-8 string.
   * @throws If path contains traversal attempts or blob not found.
   */
  async readFile(path: string): Promise<string> {
    this.validatePath(path);
    return this.readBlobContent(path);
  }

  // --------------------------------------------------------------------------
  // Cache Management
  // --------------------------------------------------------------------------

  /** Invalidate the manifest cache (forces re-scan on next listSkills). */
  invalidateCache(): void {
    this.cachedManifests = undefined;
    this.cacheExpiresAt = 0;
  }

  // --------------------------------------------------------------------------
  // Download Skill Zip
  // --------------------------------------------------------------------------

  /**
   * Download a skill's zip package from Blob Storage.
   *
   * Skills can package all their files (SKILL.md, scripts, data) into a
   * zip file at `{skillId}/skill.zip`. This zip is transferred to the
   * sandbox session via base64 encoding → file write → unzip.
   *
   * @param skillId - The skill identifier (e.g., "weather").
   * @returns Raw zip bytes as a Buffer.
   * @throws If the zip blob does not exist or exceeds the size limit.
   */
  async downloadSkillZip(skillId: string): Promise<Buffer> {
    this.validatePath(skillId);
    const blobName = `${skillId}/${SKILL_ZIP_NAME}`;
    return this.downloadBlobBuffer(blobName);
  }

  /**
   * Check whether a skill has a zip package in Blob Storage.
   *
   * @param skillId - The skill identifier (e.g., "weather").
   * @returns True if `{skillId}/skill.zip` exists.
   */
  async hasSkillZip(skillId: string): Promise<boolean> {
    this.validatePath(skillId);
    const blobName = `${skillId}/${SKILL_ZIP_NAME}`;
    const blobClient = this.containerClient.getBlobClient(blobName);
    return blobClient.exists();
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Parse a SKILL.md blob into a SkillManifest.
   *
   * Extracts standard frontmatter (id, name, description, category) via
   * the existing parseSkillFrontmatter(), then parses extended fields
   * (credentials, requiredBins) from the raw frontmatter block.
   */
  private parseManifest(content: string, blobName: string): SkillManifest {
    const frontmatter = parseSkillFrontmatter(content);
    const extended = SkillBlobStore.parseExtendedFrontmatter(content);

    return {
      ...frontmatter,
      credentials: extended.credentials,
      requiredBins: extended.requiredBins,
      blobPath: blobName,
    };
  }

  /**
   * Parse extended frontmatter fields beyond the base SkillFrontmatter.
   *
   * Supports:
   *   credentials: []                    — no credentials needed
   *   credentials: [{"key":"api_key","label":"API Key","required":true}]
   *   credentials: [{"key":"GITHUB_TOKEN","label":"GitHub token","required":true,
   *                  "hosts":["api.github.com"],"header":"Authorization","format":"Bearer {value}"}]
   *   requiredBins: ["curl", "gh"]
   */
  static parseExtendedFrontmatter(content: string): {
    credentials: CredentialSpec[];
    requiredBins?: string[];
  } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) return { credentials: [] };

    const block = match[1];
    let credentials: CredentialSpec[] = [];
    let requiredBins: string[] | undefined;

    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      if (key === "credentials" && value) {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            credentials = parsed.map((c: Record<string, unknown>) => ({
              key: String(c.key ?? ""),
              label: String(c.label ?? c.key ?? ""),
              helpText: c.helpText ? String(c.helpText) : undefined,
              required: c.required !== false,
              hosts: Array.isArray(c.hosts) ? c.hosts.map(String).filter(Boolean) : undefined,
              header: c.header ? String(c.header) : undefined,
              format: c.format ? String(c.format) : undefined,
            }));
          }
        } catch {
          // If not valid JSON, treat as empty
        }
      }

      if (key === "requiredBins" && value) {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            requiredBins = parsed.map(String);
          }
        } catch {
          // If not valid JSON, try comma-separated
          requiredBins = value.split(",").map((s) => s.trim()).filter(Boolean);
        }
      }

    }

    return { credentials, requiredBins };
  }

  /** Read blob content as UTF-8 string with size guard. */
  private async readBlobContent(blobName: string): Promise<string> {
    const blobClient = this.containerClient.getBlobClient(blobName);
    const response = await blobClient.download(0);

    if (!response.readableStreamBody) {
      throw new Error(`Empty blob: ${blobName}`);
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;

    for await (const chunk of response.readableStreamBody) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += buf.length;
      if (totalSize > this.maxSkillFileBytes) {
        throw new Error(
          `Blob "${blobName}" exceeds maximum size (${this.maxSkillFileBytes} bytes)`,
        );
      }
      chunks.push(buf);
    }

    return Buffer.concat(chunks).toString("utf-8");
  }

  /** Download blob content as raw Buffer with size guard. */
  private async downloadBlobBuffer(blobName: string): Promise<Buffer> {
    const blobClient = this.containerClient.getBlobClient(blobName);
    const response = await blobClient.download(0);

    if (!response.readableStreamBody) {
      throw new Error(`Empty blob: ${blobName}`);
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;

    for await (const chunk of response.readableStreamBody) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += buf.length;
      if (totalSize > this.maxZipFileBytes) {
        throw new Error(
          `Zip blob "${blobName}" exceeds maximum size (${this.maxZipFileBytes} bytes)`,
        );
      }
      chunks.push(buf);
    }

    return Buffer.concat(chunks);
  }

  /** Validate a blob path to prevent directory traversal. */
  private validatePath(path: string): void {
    if (!path || typeof path !== "string") {
      throw new Error("Invalid path: empty or not a string");
    }
    if (path.includes("..")) {
      throw new Error("Invalid path: directory traversal not allowed");
    }
    if (path.startsWith("/")) {
      throw new Error("Invalid path: must be relative (no leading /)");
    }
  }
}
