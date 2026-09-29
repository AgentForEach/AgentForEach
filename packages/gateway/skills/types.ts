/**
 * AgentForEach Skills Layer — Types
 *
 * Core type definitions for the prompt-based skills subsystem.
 *
 * Skills are SKILL.md instruction files stored in Azure Blob Storage.
 * The agent reads them on-demand via `skill_read` and follows instructions
 * using `http_fetch` for API calls or `sandbox_exec` for code/shell.
 * No TypeScript handlers per skill.
 *
 * Per-user credentials are stored in Cosmos DB and injected via
 * `$VAR_NAME` substitution (http_fetch) or env vars (sandbox_exec)
 * — never exposed to the LLM.
 */

import type { BaseDocument } from "../database/index.js";

// ============================================================================
// Skill Metadata (from SKILL.md frontmatter)
// ============================================================================

/** Parsed from the YAML frontmatter of a skill's SKILL.md file. */
export interface SkillFrontmatter {
  /** Unique skill identifier (e.g., "weather", "github"). */
  id: string;
  /** Human-readable display name (e.g., "Weather"). */
  name: string;
  /** Short description of what the skill does. */
  description: string;
  /** Functional category for grouping (e.g., "information", "productivity"). */
  category: string;
}

// ============================================================================
// Credential Specification
// ============================================================================

/** Declares a credential that a skill requires from the user. */
export interface CredentialSpec {
  /** Machine key (e.g., "api_key", "webhook_url"). */
  key: string;
  /** Human-readable label (e.g., "API Key"). */
  label: string;
  /** Help text for the user (e.g., "Get your key at https://..."). */
  helpText?: string;
  /** Whether the credential is required for the skill to function. */
  required: boolean;
  /**
   * Hosts this credential may be sent to (exact, or "*.example.com" for
   * subdomains). When set, http_fetch refuses to substitute it into a
   * request for any other host.
   */
  hosts?: string[];
  /**
   * Header to authenticate with (e.g. "Authorization"). With `hosts`, ACA
   * Sandboxes inject it at the egress proxy, so the secret never enters the
   * sandbox; code there sees a placeholder in the env var.
   */
  header?: string;
  /** Header value template; "{value}" is replaced by the secret. Default "{value}". */
  format?: string;
}

/** Where a credential may go and how it authenticates. From CredentialSpec. */
export interface CredentialBinding {
  hosts: string[];
  header?: string;
  format?: string;
}

// ============================================================================
// Skill Manifest (from Blob Storage — replaces SkillDefinition)
// ============================================================================

/**
 * Skill manifest loaded from Azure Blob Storage.
 *
 * Combines SKILL.md frontmatter with extended metadata (credentials,
 * required binaries). No handler code — just metadata + instructions path.
 */
export interface SkillManifest extends SkillFrontmatter {
  /** Credential requirements for this skill. */
  credentials: CredentialSpec[];
  /** Required binaries for exec (e.g., ["curl", "gh"]). */
  requiredBins?: string[];
  /** Blob path relative to skills container (e.g., "weather/SKILL.md"). */
  blobPath: string;
}

// ============================================================================
// Per-User Skill Configuration (Cosmos DB document — unchanged)
// ============================================================================

/** Per-user, per-skill configuration stored in Cosmos DB. */
export interface UserSkillConfig extends BaseDocument {
  /** Document ID: "{userId}:{skillId}". */
  id: string;
  /** User who owns this config (partition key). */
  userId: string;
  /** Skill this config is for. */
  skillId: string;
  /** Whether the user has enabled this skill. */
  enabled: boolean;
  /** User-provided credentials (encrypted at rest by Cosmos). */
  credentials: Record<string, string>;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

// ============================================================================
// Runtime Status (for prompt + meta-tools)
// ============================================================================

/** Runtime skill status exposed to the prompt layer and meta-tools. */
export interface SkillStatus {
  /** The skill manifest from Blob Storage. */
  manifest: SkillManifest;
  /** Whether the user has a config document. */
  configured: boolean;
  /** Whether all required credentials are provided. */
  credentialsComplete: boolean;
  /** Whether the skill is enabled by the user. */
  enabled: boolean;
}

// ============================================================================
// Configuration (agentforeach.json "skills" section)
// ============================================================================

/** Raw shape from agentforeach.json "skills" section. */
export interface SkillsJsonConfig {
  /**
   * http_fetch refuses to send a credential whose skill declares no `hosts`
   * (so a prompt-injected request can't send it anywhere). Set false only
   * for legacy skills you trust. Default: true.
   */
  requireCredentialHosts?: boolean;

  enabled?: boolean;
  /** Cosmos container for user-skills. */
  containerId?: string;
  /** Azure Blob Storage connection string (defaults to AzureWebJobsStorage). */
  storageConnectionString?: string;
  /** Blob container name for SKILL.md files (default: "skills"). */
  storageContainerName?: string;
  /** Sandbox config (ACA Sandboxes, or ACA Dynamic Sessions as fallback). */
  sandbox?: import("./sandbox/types.js").SandboxJsonConfig;
  /** Blob store tuning. */
  blobStore?: {
    /** In-memory cache TTL in milliseconds. Default: 300000 (5 min). */
    cacheTtlMs?: number;
    /** Max individual SKILL.md file size in bytes. Default: 262144 (256 KB). */
    maxSkillFileBytes?: number;
    /** Max skill zip file size in bytes. Default: 10485760 (10 MB). */
    maxZipFileBytes?: number;
  };
  /** Minimum interval between skill_setup calls for the same skill (ms). Default: 30000. */
  setupMinIntervalMs?: number;
}

/** Resolved skills configuration with defaults applied. */
export interface SkillsConfig {
  /** See SkillsJsonConfig.requireCredentialHosts. */
  requireCredentialHosts: boolean;

  enabled: boolean;
  containerId: string;
  storageConnectionString: string;
  storageContainerName: string;
  /** Resolved sandbox config (undefined if not configured). */
  sandbox?: import("./sandbox/types.js").SandboxConfig;
  /** Resolved blob store config. */
  blobStore: {
    cacheTtlMs: number;
    maxSkillFileBytes: number;
    maxZipFileBytes: number;
  };
  /** Minimum interval between skill_setup calls for the same skill (ms). */
  setupMinIntervalMs: number;
}

// ============================================================================
// Audit Logging
// ============================================================================

/** Audit entry for skill configuration changes (stored in same container). */
export interface SkillAuditEntry {
  /** Document ID: "audit:{userId}:{skillId}:{timestamp}". */
  id: string;
  /** User who performed the action (partition key). */
  userId: string;
  /** Skill that was modified. */
  skillId: string;
  /** The action performed. */
  action: "enable" | "disable" | "set_credentials";
  /** Which credential keys were set (values are NOT logged). */
  credentialKeysSet?: string[];
  /** ISO timestamp of the action. */
  timestamp: string;
}
