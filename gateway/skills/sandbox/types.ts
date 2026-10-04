/**
 * AgentForEach Skills Layer — Sandbox Types
 *
 * Configuration types for sandboxed shell execution. The backend contract
 * itself is the platform's sandbox port (SandboxBackend, from
 * @agentforeach/platform); providers are registered in ./registry.ts, and the
 * ACA clients and their wire types live in @agentforeach/platform-azure/sandbox.
 * Mirrors OpenAI's shell tool pattern:
 *
 *   OpenAI shell_call          AgentForEach sandbox_exec
 *   ─────────────────────      ─────────────────────────
 *   container_auto             auto (pool creates session)
 *   container_reference        identifier-based routing
 *   /mnt/data file storage     /mnt/data file storage
 *   domain_secrets             credential injection via env
 *   shell_call_output          SandboxExecResult
 */

import type { AcaSandboxesConfig } from "@agentforeach/platform-azure/sandbox";

/** Resolved ACA Sandboxes settings: the Azure pack's, re-exported here. */
export type { AcaSandboxesConfig };

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
  provider?: SandboxProvider;

  /** ACA Sandboxes settings (provider "aca-sandboxes"). */
  sandboxes?: AcaSandboxesJsonConfig;

  /** Cloudflare Containers settings (provider "cloudflare-containers"). */
  containers?: ContainersSandboxJsonConfig;

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

/**
 * A registered sandbox provider (skills/sandbox/registry.ts): "aca-sandboxes"
 * and "aca-sessions" are built in; a platform pack registers its own.
 */
export type SandboxProvider = string;

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

/** Raw shape of agentforeach.json "skills.sandbox.containers" (Cloudflare Containers). */
export interface ContainersSandboxJsonConfig {
  /** Instance type (default "standard-2": 1 vCPU, 6 GiB, 12 GB disk). */
  instance?: string;
  /** Snapshot and stop after this many idle seconds (default 300). */
  autoSuspendSec?: number;
  /** Hosts allowed out when networkAccess is "disabled" (exact, or "*.example.com"). */
  egressAllowHosts?: string[];
  /** The image was built with SANDBOX_IMAGE_BROWSER=1, so the browser can run (default false). */
  browser?: boolean;
  /** Default exec timeout in seconds (default 120). */
  defaultTimeoutSec?: number;
  /** Maximum exec timeout in seconds (default 200). */
  maxTimeoutSec?: number;
}

/** Resolved Cloudflare Containers settings. */
export interface ContainersSandboxConfig {
  instance: string;
  autoSuspendSec: number;
  egressAllowHosts: string[];
  browser: boolean;
  defaultTimeoutSec: number;
  maxTimeoutSec: number;
}

/** Resolved sandbox configuration with defaults applied. */
export interface SandboxConfig {
  enabled: boolean;
  provider: SandboxProvider;
  /** Present when provider is "aca-sandboxes". */
  sandboxes?: AcaSandboxesConfig;
  /** Present when provider is "cloudflare-containers". */
  containers?: ContainersSandboxConfig;
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
// Backend contract: the platform's sandbox port (@agentforeach/platform)
// ============================================================================

export type {
  SandboxBackend,
  SandboxCapabilities,
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileWriteArgs,
  SandboxFileWriteResult,
  SandboxFileReadArgs,
  SandboxFileReadResult,
  SandboxFileReadBinaryResult,
  SandboxFileExportResult,
  SandboxFileInfo,
  EgressCredential,
} from "@agentforeach/platform";
