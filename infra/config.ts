/**
 * AgentForEach Infrastructure — Stack Configuration
 *
 * Reads Pulumi stack config and provides typed defaults.
 */

import * as pulumi from "@pulumi/pulumi";


const cfg = new pulumi.Config("agentforeach");

export const environment = cfg.get("environment") ?? "dev";

/**
 * Short random string that makes the globally unique resource names (Cosmos,
 * Web PubSub, storage, Function App, Search, ACR) yours. Required, because
 * without it every stack named "dev" asks for the same names:
 *
 *   pulumi config set agentforeach:nameSuffix $(openssl rand -hex 3)
 *
 * Changing it on a live stack replaces those resources.
 */
const nameSuffix = cfg.get("nameSuffix");
if (!nameSuffix) {
  throw new Error(
    "Set agentforeach:nameSuffix to a short random string: pulumi config set agentforeach:nameSuffix $(openssl rand -hex 3)",
  );
}
if (!/^[a-z0-9]{3,8}$/.test(nameSuffix)) {
  throw new Error("agentforeach:nameSuffix must be 3-8 lowercase letters or digits");
}
/** Resource name prefix: "afe" (AgentForEach), short enough for Azure's name limits. */
const namePrefix = "afe";

/** Cosmos DB database and Web PubSub hub names. */
export const cosmosDatabaseName = cfg.get("cosmosDatabaseName") ?? "agentforeach";
export const webPubSubHub = cfg.get("webPubSubHub") ?? "agentforeach";
/** Key Vault name prefix (a random suffix follows). */
export const keyVaultPrefix = `${namePrefix}-kv`;
/**
 * Enable Cosmos DB Free Tier.
 *
 * IMPORTANT: Free Tier is incompatible with Serverless capacity mode
 * (which we use in cosmos.ts). Azure requires you choose one or the other.
 * Default: false (Serverless mode is preferred for low-traffic personal assistant).
 *
 * Set to true ONLY if you also remove the EnableServerless capability from cosmos.ts.
 */
export const cosmosFreeTier = cfg.getBoolean("cosmosFreeTier") ?? false;

// OpenAI API key (required for cron job execution)
export const openaiApiKey = cfg.requireSecret("openaiApiKey");

/**
 * Optional shared secret for Web PubSub upstream callbacks. Only used when the
 * runtime has no Web PubSub access key (identity-based connection); otherwise
 * every callback must carry a valid ce-signature.
 */
export const webPubSubUpstreamSharedSecret = cfg.getSecret("webPubSubUpstreamSharedSecret");

/**
 * Require upstream secret verification in runtime handlers.
 * Keep enabled in cloud deployments.
 */
export const webPubSubRequireUpstreamSecret =
  cfg.getBoolean("webPubSubRequireUpstreamSecret") ?? true;

/**
 * The runtime reaches Cosmos with a managed identity (Cosmos DB Built-in
 * Data Contributor) instead of the account key. Default: true.
 */
export const cosmosManagedIdentity = cfg.getBoolean("cosmosManagedIdentity") ?? true;

/**
 * Turn off key auth on the Cosmos account (Entra ID only). Default: on
 * whenever the runtime uses its managed identity. Operators running scripts
 * against the account then need the data role themselves.
 */
export const cosmosDisableLocalAuth =
  cfg.getBoolean("cosmosDisableLocalAuth") ?? cosmosManagedIdentity;

/**
 * Web PubSub tier and units. Standard_S1: 1,000 concurrent connections and
 * 1M messages a day per unit. Free_F1 (20 connections) is for trying out.
 */
export const webPubSubSku =
  (cfg.get("webPubSubSku") as "Free_F1" | "Standard_S1" | "Premium_P1" | undefined) ?? "Standard_S1";
export const webPubSubUnits = cfg.getNumber("webPubSubUnits") ?? 1;

/**
 * Extra Function App settings, as a secret object ({"NAME": "value"}), for
 * everything the stack doesn't model yet (CONFIG_FILE_JSON, provider keys,
 * CREDITS_*). Values go to Key Vault. Settings set by hand in the portal are
 * removed by the next `pulumi up`; put them here instead.
 *
 *   pulumi config set --secret --path 'extraAppSettings.ANTHROPIC_API_KEY' sk-...
 */
export const extraAppSettings = cfg.getSecretObject<Record<string, string>>("extraAppSettings");

/**
 * The Functions host, Durable Functions and file exports reach storage with
 * a managed identity instead of the account key (identity-based
 * AzureWebJobsStorage). Default: true. The key still exists for the
 * knowledge indexer and operator scripts.
 */
export const storageManagedIdentity = cfg.getBoolean("storageManagedIdentity") ?? true;

/** Email for operational alerts (5xx, throttling, quota, timeouts). Optional. */
export const alertEmail = cfg.get("alertEmail");

/**
 * Log Analytics daily ingestion cap in GB (stops a log flood becoming a
 * bill). When it's reached, ingestion — and the log alerts — stop until the
 * next day, so size it well above normal volume.
 */
export const logDailyCapGb = cfg.getNumber("logDailyCapGb") ?? 5;

/**
 * Cosmos DB capacity. "serverless" (default): pay per request, no idle
 * cost, but capped throughput per container and no throughput SLA; right
 * for development and small deployments. "autoscale": provisioned
 * throughput shared by all containers, scaling between 10% and
 * cosmosAutoscaleMaxRu; for production. Fixed at account creation.
 */
export const cosmosCapacity = (cfg.get("cosmosCapacity") ?? "serverless") as "serverless" | "autoscale";
export const cosmosAutoscaleMaxRu = cfg.getNumber("cosmosAutoscaleMaxRu") ?? 4000;

/** Function App scale-out ceiling (Flex Consumption allows up to 1,000). */
export const functionMaxInstances = cfg.getNumber("functionMaxInstances") ?? 100;
/** Concurrent HTTP requests per instance (turns run in activities, not HTTP). */
export const httpPerInstanceConcurrency = cfg.getNumber("httpPerInstanceConcurrency") ?? 16;

/**
 * Enable App Service Easy Auth (Authentication/Authorization v2).
 */
export const easyAuthEnabled = cfg.getBoolean("easyAuthEnabled") ?? false;

/**
 * If true, requests require an authenticated Easy Auth principal.
 * If no identity provider is configured, this is auto-relaxed at deploy time.
 */
export const easyAuthRequireAuthentication =
  cfg.getBoolean("easyAuthRequireAuthentication") ?? false;

/**
 * Google OAuth client id/secret for consumer sign-in.
 * The secret goes to Key Vault, referenced by the EASY_AUTH_GOOGLE_CLIENT_SECRET app setting.
 */
export const easyAuthGoogleClientId = cfg.get("easyAuthGoogleClientId");
export const easyAuthGoogleClientSecret = cfg.getSecret("easyAuthGoogleClientSecret");

/**
 * Optional JWT audiences to enforce in Easy Auth token validation.
 */
export const easyAuthAllowedAudiences =
  cfg.getObject<string[]>("easyAuthAllowedAudiences") ?? [];

/**
 * Allows unsafe x-user-id fallback in API handlers. Keep false in cloud.
 */
export const authAllowInsecureUserIdHeader =
  cfg.getBoolean("authAllowInsecureUserIdHeader") ?? false;

/**
 * Cron scheduler shard count (one orchestration per shard; jobs spread by
 * user). Raise it as job volume grows; don't lower it on a live stack (rows
 * in dropped shards would stop being scanned until re-indexed).
 */
export const cronSchedulerShards = (() => {
  const raw = cfg.getNumber("cronSchedulerShards") ?? 8;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(Math.max(1, Math.floor(raw)), 64);
})();

/**
 * Optional CORS origin allow-list for browser clients.
 * When empty, runtime echoes request origin.
 */
export const corsAllowedOrigins =
  cfg.getObject<string[]>("corsAllowedOrigins") ?? [];

// ============================================================================
// Sandbox (ACA Sandboxes, or ACA Dynamic Sessions as fallback)
// ============================================================================

/** Enable sandboxed shell execution. */
export const sandboxEnabled = cfg.getBoolean("sandboxEnabled") ?? false;

/**
 * Sandbox backend.
 * - "aca-sandboxes" (default) — ACA Sandboxes: a suspendable microVM per user.
 * - "aca-sessions"            — ACA Dynamic Sessions session pool (fallback).
 * See docs/Sandbox-Migration.md.
 */
export const sandboxProvider = (cfg.get("sandboxProvider", {
  allowedValues: ["aca-sandboxes", "aca-sessions"],
}) ?? "aca-sandboxes") as "aca-sandboxes" | "aca-sessions";

/**
 * Region for the ACA Sandboxes group. Defaults to the stack location, but
 * during preview Sandboxes are only offered in some regions, so this can
 * differ (e.g. "westus2", "swedencentral").
 */
export const sandboxGroupLocation = cfg.get("sandboxGroupLocation");

/** Optional cap on sandboxes in the group (maxSandboxCount). */
export const sandboxGroupMaxCount = cfg.getNumber("sandboxGroupMaxCount");

/**
 * Private disk image for new sandboxes (from scripts/build-aca-sandbox-image.mjs).
 * Unset → the public "ubuntu" image, which has no pip or node.
 */
export const sandboxDiskImageId = cfg.get("sandboxDiskImageId");

/**
 * Offer the agent a real browser inside each user's sandbox (docs/Browser.md).
 * ACA Sandboxes only; build sandboxDiskImageId with SANDBOX_IMAGE_BROWSER=1.
 */
export const sandboxBrowserEnabled = cfg.getBoolean("sandboxBrowserEnabled") ?? false;

// ============================================================================
// Knowledge Base (Azure AI Search)
// ============================================================================

/** Enable the Azure AI Search service for the knowledge module. */
export const searchEnabled = cfg.getBoolean("searchEnabled") ?? false;

/**
 * AI Search SKU: "free", "basic", or "standard".
 * Free: 50 MB, 3 indexes, no semantic ranker.
 * Basic: 2 GB, 15 indexes, semantic ranker.
 * Default: "basic" (cheapest with semantic ranker).
 */
export const searchSku = cfg.get("searchSku") ?? "basic";

/** AI Search replica count (default: 1; increase for HA). */
export const searchReplicaCount = cfg.getNumber("searchReplicaCount") ?? 1;

/**
 * AI Search semantic search tier: "disabled", "free", or "standard".
 * - "disabled" — no semantic ranker.
 * - "free"     — up to 1 000 semantic queries/month at no extra cost (Basic+).
 * - "standard" — unlimited semantic queries, billed per 1 000.
 * Default: "free" (enables L2 semantic reranking on Basic SKU at no cost).
 */
export const searchSemanticTier = cfg.get("searchSemanticTier") ?? "free";

/**
 * Session pool container type.
 * - "PythonLTS"       — Azure-managed Python Code Interpreter (no image needed)
 * - "CustomContainer" — Bring-your-own image with multi-runtime support
 */
export const sandboxContainerType =
  (cfg.get("sandboxContainerType") as "PythonLTS" | "CustomContainer" | undefined)
  ?? "PythonLTS";

/**
 * Custom container image URI (required when sandboxContainerType = "CustomContainer").
 * Format: <registry>.azurecr.io/<image>:<tag>
 */
export const sandboxContainerImage =
  cfg.get("sandboxContainerImage") ?? undefined;

/**
 * Container CPU cores (CustomContainer only, default: 0.5).
 */
export const sandboxContainerCpu =
  cfg.getNumber("sandboxContainerCpu") ?? 0.5;

/**
 * Container memory (CustomContainer only, default: "1Gi").
 */
export const sandboxContainerMemory =
  cfg.get("sandboxContainerMemory") ?? "1Gi";

/**
 * Container target port (CustomContainer only, default: 8080).
 */
export const sandboxContainerPort =
  cfg.getNumber("sandboxContainerPort") ?? 8080;

/** Max concurrent sandbox sessions (default: 10). */
export const sandboxMaxConcurrentSessions =
  cfg.getNumber("sandboxMaxConcurrentSessions") ?? 10;

/** Ready (pre-warmed) session instances (default: 0 = on-demand only). */
export const sandboxReadyInstances =
  cfg.getNumber("sandboxReadyInstances") ?? 0;

/** Session cooldown before auto-destroy, in seconds (default: 600). */
export const sandboxCooldownSec =
  cfg.getNumber("sandboxCooldownSec") ?? 600;

/**
 * Network egress for sandbox sessions.
 * "EgressDisabled" (default, most secure) or "EgressEnabled".
 */
export const sandboxNetworkStatus =
  (cfg.get("sandboxNetworkStatus") as "EgressEnabled" | "EgressDisabled" | undefined)
  ?? "EgressDisabled";

/**
 * Keep runtime secrets (Cosmos key, Web PubSub connection string, LLM keys)
 * in a Key Vault and reference them from app settings. Default: true.
 */
export const keyVaultEnabled = cfg.getBoolean("keyVaultEnabled") ?? true;

// Azure location comes from the azure-native provider config
const azureCfg = new pulumi.Config("azure-native");
export const location = azureCfg.require("location");

// Naming convention: afe-{resource}-{env}-{suffix}
export function name(resource: string): string {
  return `${namePrefix}-${resource}-${environment}-${nameSuffix}`;
}

/**
 * Storage-account-safe name (3-24 chars, lowercase alphanumeric only). The
 * suffix comes before the environment so truncation never drops it.
 */
export function storageName(resource: string): string {
  const raw = `${namePrefix}${resource}${nameSuffix}${environment}`;
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
}

// Tags applied to every resource
export const tags: Record<string, string> = {
  project: "agentforeach",
  environment,
  managedBy: "pulumi",
};
