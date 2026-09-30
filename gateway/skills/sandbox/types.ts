/**
 * AgentForEach Skills Layer — Sandbox Types
 *
 * Type definitions for sandboxed shell execution. Two backends implement
 * SandboxBackend: ACA Sandboxes (primary) and ACA Dynamic Sessions
 * (fallback). Mirrors OpenAI's shell tool pattern:
 *
 *   OpenAI shell_call          AgentForEach sandbox_exec
 *   ─────────────────────      ─────────────────────────
 *   container_auto             auto (pool creates session)
 *   container_reference        identifier-based routing
 *   /mnt/data file storage     /mnt/data file storage
 *   domain_secrets             credential injection via env
 *   shell_call_output          SandboxExecResult
 */

// ============================================================================
// Sandbox Configuration (agentforeach.json "skills.sandbox" section)
// ============================================================================

/** Raw shape from agentforeach.json "skills.sandbox" section. */
export interface SandboxJsonConfig {
  /** Whether sandboxed execution is enabled. */
  enabled?: boolean;

  /**
   * Sandbox backend.
   * - "aca-sandboxes" — Azure Container Apps Sandboxes (default): one
   *   suspendable microVM per user, state kept across idle periods.
   * - "aca-sessions"  — Azure Container Apps Dynamic Sessions (fallback):
   *   pooled sessions destroyed after cooldown. "aca" is the legacy name.
   * When "aca-sandboxes" is chosen but not configured and a session pool
   * endpoint is, AgentForEach falls back to Dynamic Sessions. The SANDBOX_PROVIDER
   * env var (set by the IaC) overrides this value.
   */
  provider?: SandboxProvider | "aca";

  /** ACA Sandboxes settings (provider "aca-sandboxes"). */
  sandboxes?: AcaSandboxesJsonConfig;

  /**
   * One sandbox per user ("userId", default) or per conversation
   * ("sessionId"). Applies to both backends; overrides aca.identifierStrategy.
   */
  identifierStrategy?: "userId" | "sessionId";

  /**
   * Outbound network from the sandbox. "disabled" (default) denies all
   * egress except sandboxes.egressAllowHosts. Overrides aca.networkAccess.
   */
  networkAccess?: "disabled" | "enabled";

  /** Maximum output characters from sandbox execution. Default: 50000. */
  maxOutputChars?: number;

  /** Blob container name for user exports. Default: "user-exports". */
  exportsContainerName?: string;

  /** SAS URL expiry for exports in hours. Default: 24. */
  exportExpiryHours?: number;

  /** Maximum export file size in bytes. Default: 52428800 (50 MB). */
  maxExportBytes?: number;

  /** A real browser inside the user's sandbox (ACA Sandboxes only). See docs/Browser.md. */
  browser?: import("../browser/types.js").BrowserJsonConfig;

  /** ACA-specific config. */
  aca?: {
    /**
     * The session pool management endpoint.
     * Format: https://<POOL>.<ENVIRONMENT>.<REGION>.azurecontainerapps.io
     */
    poolManagementEndpoint?: string;

    /**
     * Container type for the session pool.
     * - "PythonLTS"       — Azure-managed Python Code Interpreter (default)
     * - "CustomContainer" — Custom multi-runtime container image
     */
    containerType?: "PythonLTS" | "CustomContainer";

    /**
     * How to resolve the identifier for session routing.
     * - "userId"    — one session per user (default)
     * - "sessionId" — one session per conversation
     */
    identifierStrategy?: "userId" | "sessionId";

    /** Default execution timeout in seconds (default: 60, max: 220). */
    defaultTimeoutSec?: number;

    /** Maximum execution timeout in seconds (ACA limit: 220). */
    maxTimeoutSec?: number;

    /** Session cooldown period in seconds before auto-destroy (default: 600). */
    cooldownSec?: number;

    /**
     * Network access mode for sandbox sessions.
     * - "disabled" — no outbound network (default, most secure)
     * - "enabled"  — outbound network allowed
     */
    networkAccess?: "disabled" | "enabled";
  };
}

export type SandboxProvider = "aca-sandboxes" | "aca-sessions";

/** Raw shape of agentforeach.json "skills.sandbox.sandboxes". */
export interface AcaSandboxesJsonConfig {
  /** Subscription holding the sandbox group. Supports "$ENV_VAR". */
  subscriptionId?: string;
  /** Resource group holding the sandbox group. Supports "$ENV_VAR". */
  resourceGroup?: string;
  /** Sandbox group name. Supports "$ENV_VAR". */
  sandboxGroup?: string;
  /** Region of the sandbox group, used for the regional data-plane endpoint. */
  region?: string;
  /** Explicit data-plane endpoint; overrides region. */
  endpoint?: string;
  /** Public disk image name (default "ubuntu"). Ignored when diskImageId is set. */
  diskImage?: string;
  /** Private disk image id built from your own container image. */
  diskImageId?: string;
  /** CPU per sandbox, Kubernetes quantity (default "1000m"). */
  cpu?: string;
  /** Memory per sandbox, Kubernetes quantity (default "2048Mi"). */
  memory?: string;
  /**
   * Disk per sandbox, e.g. "20Gi" (default: the service's size for the CPU
   * tier, 20 GiB at 1 vCPU). Must be at least the disk image's size.
   */
  disk?: string;
  /** Suspend after this many idle seconds (default 300). */
  autoSuspendSec?: number;
  /** "Disk" keeps files only (default); "Memory" also keeps running processes. */
  suspendMode?: "Disk" | "Memory";
  /** Delete a sandbox this many days after it was stopped (default 30, 0 = never). */
  autoDeleteDays?: number;
  /** Hosts allowed out when networkAccess is "disabled" (e.g. "pypi.org"). */
  egressAllowHosts?: string[];
  /** Default exec timeout in seconds (default 120). */
  defaultTimeoutSec?: number;
  /**
   * Maximum exec timeout in seconds (default 200). Keep it under the 230 s
   * HTTP front-end limit and Node fetch's 300 s header timeout.
   */
  maxTimeoutSec?: number;
}

/** Resolved ACA Sandboxes settings. */
export interface AcaSandboxesConfig {
  subscriptionId: string;
  resourceGroup: string;
  sandboxGroup: string;
  endpoint: string;
  diskImage: string;
  diskImageId?: string;
  cpu: string;
  memory: string;
  disk?: string;
  autoSuspendSec: number;
  suspendMode: "Disk" | "Memory";
  autoDeleteDays: number;
  egressAllowHosts: string[];
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
}

/** Resolved sandbox configuration with defaults applied. */
export interface SandboxConfig {
  enabled: boolean;
  provider: SandboxProvider;
  /** Present when provider is "aca-sandboxes". */
  sandboxes?: AcaSandboxesConfig;
  /*
   * The remaining fields apply to Dynamic Sessions (and the timeouts to its
   * fallback use); ACA Sandboxes reads its own timeouts from `sandboxes`.
   */
  poolManagementEndpoint: string;
  /** Container type: "PythonLTS" or "CustomContainer" */
  containerType: "PythonLTS" | "CustomContainer";
  identifierStrategy: "userId" | "sessionId";
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
  cooldownSec: number;
  networkAccess: "disabled" | "enabled";
  /** Maximum output characters from sandbox execution. */
  maxOutputChars: number;
  /** Blob container name for user exports. */
  exportsContainerName: string;
  /** SAS URL expiry for exports in hours. */
  exportExpiryHours: number;
  /** Maximum export file size in bytes. */
  maxExportBytes: number;
  /** Browser settings; set by loadSkillsConfig, absent in hand-built configs. */
  browser?: import("../browser/types.js").BrowserConfig;
}

// ============================================================================
// Sandbox Exec (tool call arguments)
// ============================================================================

/** Arguments for the `sandbox_exec` tool (from LLM tool call). */
export interface SandboxExecArgs {
  /**
   * Shell command(s) to execute.
   * Runs as `bash -c "<command>"` inside the sandbox.
   */
  command: string;

  /** Timeout in seconds; the backend applies its default and cap. */
  timeout?: number;
}

/** Result of a sandboxed shell command execution. */
export interface SandboxExecResult {
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** Process exit code (0 = success). */
  exitCode: number;
  /** Whether the command timed out. */
  timedOut: boolean;
  /** Whether output was truncated. */
  truncated: boolean;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
  /** The session identifier (for multi-turn). */
  sessionId: string;
}

// ============================================================================
// File Operations (tool call arguments)
// ============================================================================

/** Arguments for the `sandbox_file_write` tool. */
export interface SandboxFileWriteArgs {
  /** Filename (stored in /mnt/data/<filename>). */
  filename: string;
  /** File content (text). */
  content: string;
  /** Content type hint (default: auto-detected from extension). */
  contentType?: string;
}

/** Result of a file write operation. */
export interface SandboxFileWriteResult {
  /** Whether the write succeeded. */
  success: boolean;
  /** Filename as stored. */
  filename: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** The session identifier. */
  sessionId: string;
}

/** Arguments for the `sandbox_file_read` tool. */
export interface SandboxFileReadArgs {
  /** Filename to read from /mnt/data/. */
  filename: string;
}

/** Result of a file read operation. */
export interface SandboxFileReadResult {
  /** File content (text), at most the sandbox's maxOutputChars. */
  content: string;
  /** Filename. */
  filename: string;
  /** Bytes read (the whole file unless `truncated`). */
  sizeBytes: number;
  /** True when the file was longer than the content returned. */
  truncated?: boolean;
  /** The session identifier. */
  sessionId: string;
}

/** File metadata returned by list operation. */
export interface SandboxFileInfo {
  /** Filename. */
  filename: string;
  /** File size in bytes. */
  size: number;
  /** Last modified timestamp (ISO string). */
  lastModified: string;
}

/** Result of a binary file read operation (base64-encoded). */
export interface SandboxFileReadBinaryResult {
  /** Base64-encoded file content. */
  contentBase64: string;
  /** Filename. */
  filename: string;
  /** File size in bytes (original, not encoded). */
  sizeBytes: number;
  /** The session identifier. */
  sessionId: string;
}

/** Result of a file export operation (upload to Blob + SAS URL). */
export interface SandboxFileExportResult {
  /** Whether the export succeeded. */
  success: boolean;
  /** Public download URL with SAS token (time-limited). */
  downloadUrl: string;
  /** Original filename. */
  filename: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** SAS URL expiry (ISO timestamp). */
  expiresAt: string;
  /** The session identifier. */
  sessionId: string;
}

// ============================================================================
// ACA Dynamic Sessions API types (REST payload shapes)
// ============================================================================

/** Request body for ACA code/execute endpoint. */
export interface AcaExecuteRequest {
  properties: {
    /** "inline" for direct code, "inputFiles" for uploaded files. */
    codeInputType: "inline";
    /** "synchronous" for blocking execution. */
    executionType: "synchronous";
    /** The code/command to execute. */
    code: string;
    /** Timeout in seconds (optional). */
    timeoutInSeconds?: number;
  };
}

/** Response body from ACA code/execute endpoint. */
export interface AcaExecuteResponse {
  $id?: string;
  properties: {
    $id?: string;
    status: "Success" | "Failure" | "Timeout";
    stdout: string;
    stderr: string;
    result?: unknown;
    executionTimeInMilliseconds: number;
  };
}

/** File info from ACA files listing. */
export interface AcaFileInfo {
  $id?: string;
  properties: {
    $id?: string;
    filename: string;
    size: number;
    lastModifiedTime: string;
  };
}

/** Response body from ACA files endpoint. */
export interface AcaFilesResponse {
  $id?: string;
  value: AcaFileInfo[];
}

// ============================================================================
// CustomContainer API types (direct HTTP to sandbox server)
// ============================================================================

/** Request body for CustomContainer /exec endpoint. */
export interface CustomExecRequest {
  command: string;
  timeout?: number;
}

/** Response body from CustomContainer /exec endpoint. */
export interface CustomExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

/** Request body for CustomContainer /files/write endpoint. */
export interface CustomFileWriteRequest {
  filename: string;
  content: string;
}

/** Response body from CustomContainer /files/write endpoint. */
export interface CustomFileWriteResponse {
  success: boolean;
  filename: string;
  sizeBytes: number;
  error?: string;
}

/** Request body for CustomContainer /files/read endpoint. */
export interface CustomFileReadRequest {
  filename: string;
  /** Set to "base64" for binary file reads. */
  encoding?: "base64";
}

/** Response body from CustomContainer /files/read endpoint. */
export interface CustomFileReadResponse {
  content: string;
  filename: string;
  sizeBytes: number;
  /** Present when encoding=base64 was requested. */
  encoding?: "base64";
  error?: string;
}

/** Response body from CustomContainer /files (list) endpoint. */
export interface CustomFileListResponse {
  files: Array<{
    filename: string;
    size: number;
    lastModified: string;
  }>;
  error?: string;
}

/** Response body from CustomContainer /health endpoint. */
export interface CustomHealthResponse {
  status: string;
  runtimes: Record<string, string>;
  workDir: string;
  arch: string;
  platform: string;
}

// ============================================================================
// Backend contract
// ============================================================================

/**
 * What the sandbox tools need from a backend. Implemented by
 * AcaSandboxesClient (primary) and DynamicSessionsClient (fallback).
 * Files live under /mnt/data in both.
 */
export interface SandboxBackend {
  exec(args: SandboxExecArgs, sessionIdentifier: string): Promise<SandboxExecResult>;
  fileWrite(args: SandboxFileWriteArgs, sessionIdentifier: string): Promise<SandboxFileWriteResult>;
  fileRead(args: SandboxFileReadArgs, sessionIdentifier: string): Promise<SandboxFileReadResult>;
  fileList(sessionIdentifier: string): Promise<SandboxFileInfo[]>;
  fileReadBinary(args: SandboxFileReadArgs, sessionIdentifier: string): Promise<SandboxFileReadBinaryResult>;
  /** Make these env vars visible to later exec calls in the same sandbox. */
  setEnv(vars: Record<string, string>, sessionIdentifier: string): Promise<void>;
  /**
   * Replace the credentials the egress proxy injects into this sandbox's
   * outbound requests (empty list clears them). Only backends that can keep
   * secrets out of the sandbox implement this; others get them via setEnv.
   */
  setEgressCredentials?(credentials: EgressCredential[], sessionIdentifier: string): Promise<void>;
  resolveIdentifier(userId: string, sessionId?: string): string;
  isReady(): boolean;
}

/** A header the egress proxy sets on requests to `hosts`. */
export interface EgressCredential {
  /** Credential key, used to name the rule (never the value). */
  key: string;
  hosts: string[];
  header: string;
  /** Final header value, format already applied. */
  value: string;
}
