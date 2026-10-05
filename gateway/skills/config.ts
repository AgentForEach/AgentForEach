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
  AgentCoreSandboxConfig,
  AgentCoreSandboxJsonConfig,
  ContainersSandboxConfig,
  ContainersSandboxJsonConfig,
  SandboxConfig,
  SandboxProvider,
} from "./sandbox/types.js";
import type { BrowserConfig, BrowserJsonConfig } from "./browser/types.js";
import { resolveHub } from "../websocket/config.js";
import { relayEgressEntry, relayHost as resolveRelayHost } from "../websocket/providers/index.js";
import { canonicalSandboxProvider } from "./sandbox/registry.js";

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
  handoffMinutes: 10,
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
    handoff: {
      enabled: json.handoff?.enabled ?? true,
      maxMinutes: Math.min(
        Math.max(Number.isFinite(json.handoff?.maxMinutes) ? json.handoff!.maxMinutes! : BROWSER_DEFAULTS.handoffMinutes, 1),
        30,
      ),
      // Its own hub, with no event handlers: a relay token can't reach the gateway.
      // (Hub names allow letters, digits and underscores only.)
      hub: json.handoff?.hub ?? `${resolveHub()}_browser`,
      ...(json.handoff?.viewerBaseUrl ? { viewerBaseUrl: json.handoff.viewerBaseUrl } : {}),
    },
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

const CONTAINERS_DEFAULTS = {
  instance: "standard-2",
  autoSuspendSec: 300,
  defaultTimeoutSec: 120,
  maxTimeoutSec: 200,
};

function resolveContainers(json: ContainersSandboxJsonConfig = {}): ContainersSandboxConfig {
  return {
    instance: json.instance ?? CONTAINERS_DEFAULTS.instance,
    autoSuspendSec: json.autoSuspendSec ?? CONTAINERS_DEFAULTS.autoSuspendSec,
    egressAllowHosts: json.egressAllowHosts ?? [],
    browser: json.browser ?? false,
    defaultTimeoutSec: json.defaultTimeoutSec ?? CONTAINERS_DEFAULTS.defaultTimeoutSec,
    maxTimeoutSec: json.maxTimeoutSec ?? CONTAINERS_DEFAULTS.maxTimeoutSec,
  };
}

const AGENTCORE_DEFAULTS = {
  defaultTimeoutSec: 60,
  maxTimeoutSec: 200,
  maxBytes: 32 * 1024 * 1024,
  maxFiles: 10_000,
};

/**
 * Resolve the Bedrock AgentCore section. Each field falls back to an env var
 * so the IaC can inject it (AWS_SANDBOX_*); the backend checks the values.
 */
function resolveAgentCore(json: AgentCoreSandboxJsonConfig = {}): AgentCoreSandboxConfig {
  const pick = (value: string | undefined, envVar: string) => resolveEnvValue(value) ?? (process.env[envVar] || undefined);
  const number = (value: number | undefined, envVar: string) => value ?? (process.env[envVar] ? Number(process.env[envVar]) : undefined);
  const storageMode = (pick(json.storageMode, "AWS_SANDBOX_STORAGE_MODE") ?? "ephemeral") as AgentCoreSandboxConfig["storageMode"];
  const maxBytes = number(json.persistenceLimits?.maxBytes, "AWS_SANDBOX_ARCHIVE_MAX_BYTES");
  const maxFiles = number(json.persistenceLimits?.maxFiles, "AWS_SANDBOX_ARCHIVE_MAX_FILES");
  const qualifier = pick(json.qualifier, "AWS_SANDBOX_QUALIFIER");
  const region = pick(json.region, "AWS_SANDBOX_REGION");
  const workspaceBucket = pick(json.workspaceBucket, "AWS_SANDBOX_WORKSPACE_BUCKET");
  return {
    runtimeArn: pick(json.runtimeArn, "AWS_SANDBOX_RUNTIME_ARN") ?? "",
    ...(qualifier ? { qualifier } : {}),
    ...(region ? { region } : {}),
    serverToken: pick(json.serverToken, "AWS_SANDBOX_SERVER_TOKEN") ?? "",
    storageMode,
    ...(workspaceBucket ? { workspaceBucket } : {}),
    ...(storageMode === "s3-checkpoint"
      ? { persistenceLimits: { maxBytes: maxBytes ?? AGENTCORE_DEFAULTS.maxBytes, maxFiles: maxFiles ?? AGENTCORE_DEFAULTS.maxFiles } }
      : {}),
    browser: json.browser ?? false,
    defaultTimeoutSec: json.defaultTimeoutSec ?? AGENTCORE_DEFAULTS.defaultTimeoutSec,
    maxTimeoutSec: json.maxTimeoutSec ?? AGENTCORE_DEFAULTS.maxTimeoutSec,
  };
}

/**
 * SANDBOX_PROVIDER (from the IaC) wins over agentforeach.json; "aca" is a
 * legacy alias. Any registered provider is accepted (skills/sandbox/registry.ts);
 * an unknown name fails when the backend is created.
 */
function resolveProvider(configured: string | undefined): SandboxProvider {
  return canonicalSandboxProvider((process.env.SANDBOX_PROVIDER || configured || SANDBOX_DEFAULTS.provider).trim());
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
    const containers = provider === "cloudflare-containers" ? resolveContainers(s.containers) : undefined;
    const aws = provider === "aws-agentcore" ? resolveAgentCore(s.aws) : undefined;
    const browser = resolveBrowser(s.browser);
    // A handoff's live view goes out to the realtime relay; let it through a deny-by-default egress policy.
    // ACA's egress rules match hosts only, so it gets the relay's host; the
    // containers backend gets host/path, so a relay on the gateway's own host
    // doesn't open every gateway route to the sandbox.
    const handoff = browser.enabled && browser.handoff.enabled;
    const relayEntries: Array<[{ egressAllowHosts: string[] } | undefined, string | undefined]> = [
      [acaSandboxes, handoff ? resolveRelayHost() : undefined],
      [containers, handoff ? relayEgressEntry() : undefined],
    ];
    for (const [backend, entry] of relayEntries) {
      if (backend && entry && !backend.egressAllowHosts.includes(entry)) {
        backend.egressAllowHosts = [...backend.egressAllowHosts, entry];
      }
    }

    sandbox = {
      enabled: s.enabled ?? false,
      provider,
      sandboxes: acaSandboxes,
      containers,
      aws,
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
      browser,
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
