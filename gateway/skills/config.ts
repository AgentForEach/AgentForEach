/**
 * AgentForEach Skills Layer — Configuration
 *
 * Loads skills config from agentforeach.json ("skills" section).
 * Follows the same cached-singleton pattern as web/config.ts.
 *
 * Storage connection defaults to the existing AzureWebJobsStorage env var
 * (same Storage Account used by Azure Functions runtime).
 */

import { loadConfigSection, resolveEnvValue } from "../utils/index.js";
import type { SkillsJsonConfig, SkillsConfig } from "./types.js";
import type {
  AcaSandboxesConfig,
  AcaSandboxesJsonConfig,
  SandboxConfig,
  SandboxProvider,
} from "./sandbox/types.js";
import type { BrowserConfig, BrowserJsonConfig } from "./browser/types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONTAINER_ID = "user-skills";
const DEFAULT_STORAGE_CONTAINER_NAME = "skills";

const SANDBOX_DEFAULTS = {
  provider: "aca-sandboxes" as const,
  containerType: "PythonLTS" as const,
  identifierStrategy: "userId" as const,
  defaultTimeoutSec: 60,
  maxTimeoutSec: 220,
  cooldownSec: 600,
  networkAccess: "disabled" as const,
  maxOutputChars: 50_000,
  exportsContainerName: "user-exports",
  exportExpiryHours: 24,
  maxExportBytes: 50 * 1024 * 1024,
};

const ACA_SANDBOXES_DEFAULT_ENDPOINT = "https://management.azuredevcompute.io";

function endpointForRegion(region: string): string {
  // Azure display names ("Central India") → region names ("centralindia").
  return `https://management.${region.toLowerCase().replace(/\s+/g, "")}.azuredevcompute.io`;
}

const ACA_SANDBOXES_DEFAULTS = {
  diskImage: "ubuntu",
  cpu: "1000m",
  memory: "2048Mi",
  autoSuspendSec: 300,
  suspendMode: "Disk" as const,
  autoDeleteDays: 30,
  defaultTimeoutSec: 120,
  maxTimeoutSec: 200,
};

// Snapshots are the browser's main token cost, and sandboxes are billed while
// running, so the defaults keep both small. Chromium fits the default 2 GiB
// sandbox (about 700 MB measured live), so the browser doesn't change its size.
const MAX_SNAPSHOT_CHARS = 40_000;

const BROWSER_DEFAULTS = {
  actionTimeoutSec: 30,
  navigationTimeoutSec: 45,
  maxSnapshotChars: 8_000,
  viewport: { width: 1280, height: 800 },
  idleShutdownSec: 120,
  maxActionsPerTurn: 30,
  maxActionsPerScheduledRun: 10,
  showScreenshots: true,
};

/** SANDBOX_BROWSER_ENABLED (from the IaC) wins over agentforeach.json. */
function resolveBrowser(json: BrowserJsonConfig = {}): BrowserConfig {
  const fromEnv = process.env.SANDBOX_BROWSER_ENABLED?.trim();
  return {
    enabled: fromEnv ? /^(true|1|yes)$/i.test(fromEnv) : (json.enabled ?? false),
    actionTimeoutSec: json.actionTimeoutSec ?? BROWSER_DEFAULTS.actionTimeoutSec,
    navigationTimeoutSec: json.navigationTimeoutSec ?? BROWSER_DEFAULTS.navigationTimeoutSec,
    // The driver's whole answer is one line of exec output, which the sandbox cuts at maxOutputChars (50,000).
    maxSnapshotChars: Math.min(json.maxSnapshotChars ?? BROWSER_DEFAULTS.maxSnapshotChars, MAX_SNAPSHOT_CHARS),
    viewport: json.viewport ?? BROWSER_DEFAULTS.viewport,
    idleShutdownSec: json.idleShutdownSec ?? BROWSER_DEFAULTS.idleShutdownSec,
    maxActionsPerTurn: json.maxActionsPerTurn ?? BROWSER_DEFAULTS.maxActionsPerTurn,
    maxActionsPerScheduledRun: json.maxActionsPerScheduledRun ?? BROWSER_DEFAULTS.maxActionsPerScheduledRun,
    showScreenshots: json.showScreenshots ?? BROWSER_DEFAULTS.showScreenshots,
    ...(json.users ? { users: json.users } : {}),
  };
}

/**
 * Resolve the ACA Sandboxes section. Each identity field falls back to an
 * env var so the IaC can inject it: ACA_SANDBOX_SUBSCRIPTION_ID,
 * ACA_SANDBOX_RESOURCE_GROUP, ACA_SANDBOX_GROUP, ACA_SANDBOX_REGION.
 */
function resolveAcaSandboxes(json: AcaSandboxesJsonConfig = {}): AcaSandboxesConfig {
  const pick = (value: string | undefined, envVar: string) =>
    resolveEnvValue(value) ?? process.env[envVar] ?? "";
  const region = pick(json.region, "ACA_SANDBOX_REGION");
  const endpoint =
    resolveEnvValue(json.endpoint) ??
    (region ? endpointForRegion(region) : ACA_SANDBOXES_DEFAULT_ENDPOINT);
  return {
    subscriptionId: pick(json.subscriptionId, "ACA_SANDBOX_SUBSCRIPTION_ID"),
    resourceGroup: pick(json.resourceGroup, "ACA_SANDBOX_RESOURCE_GROUP"),
    sandboxGroup: pick(json.sandboxGroup, "ACA_SANDBOX_GROUP"),
    endpoint: endpoint.replace(/\/$/, ""),
    diskImage: json.diskImage ?? ACA_SANDBOXES_DEFAULTS.diskImage,
    diskImageId: resolveEnvValue(json.diskImageId),
    cpu: json.cpu ?? ACA_SANDBOXES_DEFAULTS.cpu,
    memory: json.memory ?? ACA_SANDBOXES_DEFAULTS.memory,
    disk: json.disk,
    autoSuspendSec: json.autoSuspendSec ?? ACA_SANDBOXES_DEFAULTS.autoSuspendSec,
    suspendMode: json.suspendMode ?? ACA_SANDBOXES_DEFAULTS.suspendMode,
    autoDeleteDays: json.autoDeleteDays ?? ACA_SANDBOXES_DEFAULTS.autoDeleteDays,
    egressAllowHosts: json.egressAllowHosts ?? [],
    defaultTimeoutSec: json.defaultTimeoutSec ?? ACA_SANDBOXES_DEFAULTS.defaultTimeoutSec,
    maxTimeoutSec: json.maxTimeoutSec ?? ACA_SANDBOXES_DEFAULTS.maxTimeoutSec,
  };
}

/** SANDBOX_PROVIDER (from the IaC) wins over agentforeach.json; "aca" is a legacy alias. */
function resolveProvider(configured: string | undefined): SandboxProvider {
  const raw = process.env.SANDBOX_PROVIDER || configured || SANDBOX_DEFAULTS.provider;
  if (raw === "aca" || raw === "aca-sessions") return "aca-sessions";
  if (raw === "aca-sandboxes") return "aca-sandboxes";
  throw new Error(`Unknown sandbox provider "${raw}" (expected aca-sandboxes or aca-sessions)`);
}

const BLOB_STORE_DEFAULTS = {
  cacheTtlMs: 5 * 60 * 1000,
  maxSkillFileBytes: 256 * 1024,
  maxZipFileBytes: 10 * 1024 * 1024,
};

const DEFAULT_SETUP_MIN_INTERVAL_MS = 30_000;

// ============================================================================
// Config Loader
// ============================================================================

let _skillsConfig: SkillsConfig | undefined;

/**
 * Load skills config from agentforeach.json and resolve defaults.
 */
export function loadSkillsConfig(): SkillsConfig {
  if (_skillsConfig) return _skillsConfig;

  const section = loadConfigSection<SkillsJsonConfig>("skills");
  const json = section ?? {};

  // Resolve sandbox sub-config if present
  let sandbox: SandboxConfig | undefined;
  if (json.sandbox) {
    const s = json.sandbox;
    // "$VAR" values are not expanded by the config loader, so resolve here.
    const poolEndpoint =
      resolveEnvValue(s.aca?.poolManagementEndpoint) ??
      process.env.ACA_POOL_MANAGEMENT_ENDPOINT ??
      "";
    const provider = resolveProvider(s.provider);
    const acaSandboxes = provider === "aca-sandboxes" ? resolveAcaSandboxes(s.sandboxes) : undefined;

    sandbox = {
      enabled: s.enabled ?? false,
      provider,
      sandboxes: acaSandboxes,
      poolManagementEndpoint: poolEndpoint,
      containerType:
        s.aca?.containerType ?? SANDBOX_DEFAULTS.containerType,
      identifierStrategy:
        s.identifierStrategy ??
        s.aca?.identifierStrategy ??
        SANDBOX_DEFAULTS.identifierStrategy,
      defaultTimeoutSec:
        s.aca?.defaultTimeoutSec ?? SANDBOX_DEFAULTS.defaultTimeoutSec,
      maxTimeoutSec:
        s.aca?.maxTimeoutSec ?? SANDBOX_DEFAULTS.maxTimeoutSec,
      cooldownSec:
        s.aca?.cooldownSec ?? SANDBOX_DEFAULTS.cooldownSec,
      networkAccess:
        s.networkAccess ?? s.aca?.networkAccess ?? SANDBOX_DEFAULTS.networkAccess,
      maxOutputChars:
        s.maxOutputChars ?? SANDBOX_DEFAULTS.maxOutputChars,
      exportsContainerName:
        s.exportsContainerName ?? SANDBOX_DEFAULTS.exportsContainerName,
      exportExpiryHours:
        s.exportExpiryHours ?? SANDBOX_DEFAULTS.exportExpiryHours,
      maxExportBytes:
        s.maxExportBytes ?? SANDBOX_DEFAULTS.maxExportBytes,
      browser: resolveBrowser(s.browser),
    };
  }

  _skillsConfig = {
    enabled: json.enabled ?? false,
    containerId: json.containerId ?? DEFAULT_CONTAINER_ID,
    storageConnectionString:
      json.storageConnectionString
      ?? process.env.AzureWebJobsStorage
      ?? "",
    storageContainerName:
      json.storageContainerName ?? DEFAULT_STORAGE_CONTAINER_NAME,
    sandbox,
    blobStore: {
      cacheTtlMs: json.blobStore?.cacheTtlMs ?? BLOB_STORE_DEFAULTS.cacheTtlMs,
      maxSkillFileBytes: json.blobStore?.maxSkillFileBytes ?? BLOB_STORE_DEFAULTS.maxSkillFileBytes,
      maxZipFileBytes: json.blobStore?.maxZipFileBytes ?? BLOB_STORE_DEFAULTS.maxZipFileBytes,
    },
    setupMinIntervalMs: json.setupMinIntervalMs ?? DEFAULT_SETUP_MIN_INTERVAL_MS,
    requireCredentialHosts: json.requireCredentialHosts ?? true,
  };

  return _skillsConfig;
}

/**
 * Check whether skills are enabled.
 */
export function isSkillsEnabled(): boolean {
  return loadSkillsConfig().enabled;
}

/**
 * Reset cached config (for testing).
 */
export function resetSkillsConfig(): void {
  _skillsConfig = undefined;
}
