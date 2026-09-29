/**
 * AgentForEach Infrastructure — Azure Functions (Flex Consumption + Application Insights)
 *
 * Provisions:
 *   - Storage Account    — Azure Functions runtime + Durable Task state + deployment packages
 *   - Blob Container     — deployment package storage for Flex Consumption
 *   - App Service Plan   — Flex Consumption (FC1) for serverless with enhanced scaling
 *   - Log Analytics      — workspace for Application Insights data
 *   - Application Insights — distributed tracing, live metrics, log analytics
 *   - Function App       — Node.js 20, Linux, with all app settings
 *
 * Single Function App hosts all 24 registrations:
 *   - WebSocket handlers: negotiate, wsConnect, wsCatchAll, wsMessage, wsDisconnect (5)
 *   - HTTP API: apiChat, apiSessions, apiSessionById, apiToken, apiHealth (5)
 *   - Cron HTTP: create, list, get, update, delete, forceRun, getRuns, status, start (9)
 *   - Cron Durable: GetDueJobs, ExecuteAndRecordJob, ComputeNextWake (3 activities)
 *   - Cron Durable: CronScheduler (sharded orchestrators), CronSchedulerHealthCheck (1 timer)
 */

import * as storage from "@pulumi/azure-native/storage";
import * as web from "@pulumi/azure-native/web";
import * as webV2 from "@pulumi/azure-native/web/v20240401";
import * as insights from "@pulumi/azure-native/insights";
import * as operationalinsights from "@pulumi/azure-native/operationalinsights";
import * as pulumi from "@pulumi/pulumi";

// ============================================================================
// Storage Account
// ============================================================================

/**
 * Create a Storage Account for Azure Functions + Durable Task state.
 *
 * NOTE: Storage Account names must be 3-24 chars, lowercase alphanumeric only.
 * We strip hyphens from the standard naming convention.
 */
export function createStorageAccount(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  /** Name (must be 3-24 chars, lowercase alphanumeric only) */
  accountName: string;
  tags: Record<string, string>;
}) {
  return new storage.StorageAccount(args.accountName, {
    accountName: args.accountName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: { name: storage.SkuName.Standard_LRS },
    kind: storage.Kind.StorageV2,
    enableHttpsTrafficOnly: true,
    minimumTlsVersion: storage.MinimumTlsVersion.TLS1_2,
    // Exports and skills are shared through per-file SAS links, never anonymously.
    allowBlobPublicAccess: false,
    tags: args.tags,
  });
}

/**
 * Create a blob container for Flex Consumption deployment packages.
 */
export function createDeploymentContainer(args: {
  resourceGroupName: pulumi.Input<string>;
  accountName: pulumi.Input<string>;
  containerName?: string;
}) {
  const containerName = args.containerName ?? "deployments";
  return new storage.BlobContainer(containerName, {
    containerName,
    resourceGroupName: args.resourceGroupName,
    accountName: args.accountName,
    publicAccess: storage.PublicAccess.None,
  });
}

/**
 * Create a blob container for SKILL.md files (prompt-based skills).
 * Reuses the existing Storage Account — no new resources beyond the container.
 */
export function createSkillsBlobContainer(args: {
  resourceGroupName: pulumi.Input<string>;
  accountName: pulumi.Input<string>;
  containerName?: string;
}) {
  const containerName = args.containerName ?? "skills";
  return new storage.BlobContainer(containerName, {
    containerName,
    resourceGroupName: args.resourceGroupName,
    accountName: args.accountName,
    publicAccess: storage.PublicAccess.None,
  });
}

/**
 * Create a blob container for knowledge base source documents.
 * The AI Search indexer reads raw documents (PDFs, HTML, etc.) from this container.
 * Reuses the existing Storage Account — no new resources beyond the container.
 */
export function createKnowledgeBlobContainer(args: {
  resourceGroupName: pulumi.Input<string>;
  accountName: pulumi.Input<string>;
  containerName?: string;
}) {
  const containerName = args.containerName ?? "knowledge-docs";
  return new storage.BlobContainer(containerName, {
    containerName,
    resourceGroupName: args.resourceGroupName,
    accountName: args.accountName,
    publicAccess: storage.PublicAccess.None,
  });
}

/**
 * Retrieve the connection string for a Storage Account.
 * Marked as a Pulumi secret (contains the account key).
 */
export function getStorageConnectionString(args: {
  resourceGroupName: pulumi.Input<string>;
  accountName: pulumi.Input<string>;
}): pulumi.Output<string> {
  const connStr = pulumi
    .all([args.resourceGroupName, args.accountName])
    .apply(async ([rg, name]) => {
      const keys = await storage.listStorageAccountKeys({
        resourceGroupName: rg,
        accountName: name,
      });
      const key = keys.keys[0].value;
      return `DefaultEndpointsProtocol=https;AccountName=${name};AccountKey=${key};EndpointSuffix=core.windows.net`;
    });

  return pulumi.secret(connStr);
}

// ============================================================================
// Log Analytics Workspace
// ============================================================================

/**
 * Create a Log Analytics workspace for Application Insights.
 *
 * Uses the free tier (PerGB2018) — costs are based on data ingestion.
 * 5 GB/month free with 31-day retention.
 */
export function createLogAnalyticsWorkspace(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  workspaceName: string;
  /** Daily ingestion cap; ingestion stops until the next day once reached. */
  dailyQuotaGb?: number;
  tags: Record<string, string>;
}) {
  return new operationalinsights.Workspace(args.workspaceName, {
    workspaceName: args.workspaceName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: { name: "PerGB2018" },
    retentionInDays: 30,
    ...(args.dailyQuotaGb ? { workspaceCapping: { dailyQuotaGb: args.dailyQuotaGb } } : {}),
    tags: args.tags,
  });
}

// ============================================================================
// Application Insights
// ============================================================================

/**
 * Create an Application Insights component for the Function App.
 *
 * Provides:
 *   - Distributed tracing across all 24 function invocations
 *   - Live metrics stream
 *   - Failure & performance monitoring
 *   - Log analytics via KQL queries
 *   - Durable Functions orchestration tracking
 */
export function createApplicationInsights(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  componentName: string;
  workspaceResourceId: pulumi.Input<string>;
  tags: Record<string, string>;
}) {
  return new insights.Component(args.componentName, {
    resourceName: args.componentName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    applicationType: "web",
    kind: "web",
    workspaceResourceId: args.workspaceResourceId,
    ingestionMode: "LogAnalytics",
    tags: args.tags,
  });
}

// ============================================================================
// App Service Plan (Flex Consumption)
// ============================================================================

/**
 * Create a Flex Consumption (FC1) App Service Plan.
 *
 * Flex Consumption advantages over traditional Y1 Consumption:
 *   - Per-function scaling with configurable concurrency
 *   - Always Ready instances (optional, keeps cold starts near zero)
 *   - VNet integration support
 *   - Instance memory selection (512 MB – 4096 MB)
 *   - Still serverless with scale-to-zero when idle
 */
export function createFlexConsumptionPlan(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  planName: string;
  tags: Record<string, string>;
}) {
  return new web.AppServicePlan(args.planName, {
    name: args.planName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    kind: "functionapp",
    reserved: true, // Required for Linux
    sku: {
      name: "FC1",
      tier: "FlexConsumption",
    },
    tags: args.tags,
  });
}

// ============================================================================
// Function App (Flex Consumption)
// ============================================================================

/**
 * Create the unified AgentForEach Function App on Flex Consumption.
 *
 * Hosts all 24 function registrations (WebSocket, HTTP API, Cron Durable).
 *
 * Uses the v20240401 API version which supports functionAppConfig
 * for Flex Consumption deployment, runtime, and scaling settings.
 *
 * App settings provide runtime access to:
 *   - Cosmos DB (endpoint, key, database)
 *   - OpenAI API key (LLM provider + cron executor)
 *   - Web PubSub (real-time communication)
 *   - Application Insights (telemetry)
 *   - Azure Storage (Durable Task + Functions state)
 */
/** Where the runtime finds the ACA Sandboxes group (ACA_SANDBOX_* settings). */
export type AcaSandboxGroupSettings = {
  subscriptionId: pulumi.Input<string>;
  resourceGroup: pulumi.Input<string>;
  group: pulumi.Input<string>;
  region: pulumi.Input<string>;
  diskImageId?: pulumi.Input<string>;
};

export function createFunctionApp(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  appName: string;
  planId: pulumi.Input<string>;
  storageAccountName: pulumi.Input<string>;
  /** Key connection string; omitted when the app uses `storageIdentity`. */
  storageConnectionString?: pulumi.Input<string>;
  /**
   * User-assigned identity with blob/queue/table data roles on the storage
   * account (identity-based AzureWebJobsStorage: no account key in settings).
   */
  storageIdentity?: {
    accountName: pulumi.Input<string>;
    identityId: pulumi.Input<string>;
    clientId: pulumi.Input<string>;
    roleAssignments: pulumi.Resource[];
  };
  deploymentContainerUrl: pulumi.Input<string>;
  cosmosEndpoint: pulumi.Input<string>;
  /** Account key; omitted when the runtime uses `cosmosIdentity`. */
  cosmosKey?: pulumi.Input<string>;
  /** User-assigned identity with the Cosmos data role (Entra auth). */
  cosmosIdentity?: {
    identityId: pulumi.Input<string>;
    clientId: pulumi.Input<string>;
    roleAssignment: pulumi.Resource;
  };
  webPubSubHub: pulumi.Input<string>;
  cosmosDatabaseName: pulumi.Input<string>;
  openaiApiKey: pulumi.Input<string>;
  webPubSubConnectionString: pulumi.Input<string>;
  /** Lets the runtime verify ce-signature across a primary key regeneration. */
  webPubSubSecondaryAccessKey: pulumi.Input<string>;
  webPubSubUpstreamSharedSecret?: pulumi.Input<string>;
  webPubSubRequireUpstreamSecret: pulumi.Input<boolean>;
  appInsightsConnectionString: pulumi.Input<string>;
  authAllowInsecureUserIdHeader: pulumi.Input<boolean>;
  cronSchedulerShards: pulumi.Input<number>;
  corsAllowedOrigins?: pulumi.Input<string>;
  easyAuthGoogleClientSecret?: pulumi.Input<string>;
  acaPoolManagementEndpoint?: pulumi.Input<string>;
  /** Tells the runtime which sandbox backend this stack provisioned. */
  sandboxProvider?: "aca-sandboxes" | "aca-sessions";
  /** ACA Sandboxes group the runtime creates per-user sandboxes in. */
  acaSandboxGroup?: AcaSandboxGroupSettings;
  searchEndpoint?: pulumi.Input<string>;
  /** Query key: the runtime only runs searches. */
  searchQueryKey?: pulumi.Input<string>;
  logRedactionKey: pulumi.Input<string>;
  /** Identity that resolves Key Vault references, and its grant on the vault. */
  keyVaultReader?: { identityId: pulumi.Input<string>; roleAssignment: pulumi.Resource };
  /** Scale-out ceiling (agentforeach:functionMaxInstances). */
  maxInstances?: number;
  httpPerInstanceConcurrency?: number;
  /** Settings the stack doesn't model (agentforeach:extraAppSettings). */
  extraAppSettings?: Array<{ name: string; value: pulumi.Input<string> }>;
  /** Resources the app needs before it starts (e.g. the Cosmos containers). */
  dependsOn?: pulumi.Resource[];
  tags: Record<string, string>;
}) {
  const appSettings: pulumi.Input<{
    name?: pulumi.Input<string>;
    value?: pulumi.Input<string>;
  }>[] = [
    // — Azure Functions Runtime —
    ...(args.storageIdentity
      ? [
          { name: "AzureWebJobsStorage__accountName", value: args.storageIdentity.accountName },
          { name: "AzureWebJobsStorage__credential", value: "managedidentity" },
          { name: "AzureWebJobsStorage__clientId", value: args.storageIdentity.clientId },
        ]
      : [{ name: "AzureWebJobsStorage", value: args.storageConnectionString! }]),
    { name: "FUNCTIONS_EXTENSION_VERSION", value: "~4" },

    // — Application Insights —
    { name: "APPLICATIONINSIGHTS_CONNECTION_STRING", value: args.appInsightsConnectionString },

    // — Cosmos DB —
    { name: "COSMOS_ENDPOINT", value: args.cosmosEndpoint },
    { name: "COSMOS_DATABASE", value: args.cosmosDatabaseName },
    // Containers come from the IaC (cosmos-containers.json); never created at runtime.
    { name: "COSMOS_PROVISION_CONTAINERS", value: "false" },

    // — OpenAI —
    { name: "OPENAI_API_KEY", value: args.openaiApiKey },

    // — Web PubSub (real-time) —
    { name: "WEBPUBSUB_CONNECTION_STRING", value: args.webPubSubConnectionString },
    { name: "WEBPUBSUB_HUB", value: args.webPubSubHub },
    { name: "WEBPUBSUB_SECONDARY_ACCESS_KEY", value: args.webPubSubSecondaryAccessKey },
    {
      name: "WEBPUBSUB_REQUIRE_UPSTREAM_SECRET",
      value: pulumi.interpolate`${args.webPubSubRequireUpstreamSecret}`,
    },

    // — Auth behavior flags for runtime handlers —
    {
      name: "AUTH_ALLOW_INSECURE_USER_ID_HEADER",
      value: pulumi.interpolate`${args.authAllowInsecureUserIdHeader}`,
    },
    { name: "CRON_SCHEDULER_SHARDS", value: pulumi.interpolate`${args.cronSchedulerShards}` },
    { name: "LOG_REDACTION_KEY", value: args.logRedactionKey },
  ];

  if (args.cosmosKey) {
    appSettings.push({ name: "COSMOS_KEY", value: args.cosmosKey });
  }
  if (args.cosmosIdentity) {
    appSettings.push({ name: "COSMOS_IDENTITY_CLIENT_ID", value: args.cosmosIdentity.clientId });
  }

  if (args.webPubSubUpstreamSharedSecret) {
    appSettings.push({ name: "WEBPUBSUB_UPSTREAM_SHARED_SECRET", value: args.webPubSubUpstreamSharedSecret });
  }

  if (args.corsAllowedOrigins) {
    appSettings.push({
      name: "CORS_ALLOWED_ORIGINS",
      value: args.corsAllowedOrigins,
    });
  }

  if (args.easyAuthGoogleClientSecret) {
    appSettings.push({
      name: "EASY_AUTH_GOOGLE_CLIENT_SECRET",
      value: args.easyAuthGoogleClientSecret,
    });
  }

  if (args.acaPoolManagementEndpoint) {
    appSettings.push({
      name: "ACA_POOL_MANAGEMENT_ENDPOINT",
      value: args.acaPoolManagementEndpoint,
    });
  }

  if (args.sandboxProvider) {
    appSettings.push({ name: "SANDBOX_PROVIDER", value: args.sandboxProvider });
  }

  if (args.acaSandboxGroup) {
    appSettings.push(
      { name: "ACA_SANDBOX_SUBSCRIPTION_ID", value: args.acaSandboxGroup.subscriptionId },
      { name: "ACA_SANDBOX_RESOURCE_GROUP", value: args.acaSandboxGroup.resourceGroup },
      { name: "ACA_SANDBOX_GROUP", value: args.acaSandboxGroup.group },
      { name: "ACA_SANDBOX_REGION", value: args.acaSandboxGroup.region },
    );
    if (args.acaSandboxGroup.diskImageId) {
      appSettings.push({ name: "ACA_SANDBOX_DISK_IMAGE_ID", value: args.acaSandboxGroup.diskImageId });
    }
  }

  if (args.searchEndpoint) {
    appSettings.push({ name: "SEARCH_ENDPOINT", value: args.searchEndpoint });
  }
  if (args.searchQueryKey) {
    appSettings.push({ name: "SEARCH_API_KEY", value: args.searchQueryKey });
  }

  for (const setting of args.extraAppSettings ?? []) appSettings.push(setting);

  const userAssignedIdentities = [
    ...(args.keyVaultReader ? [args.keyVaultReader.identityId] : []),
    ...(args.cosmosIdentity ? [args.cosmosIdentity.identityId] : []),
    ...(args.storageIdentity ? [args.storageIdentity.identityId] : []),
  ];

  return new webV2.WebApp(args.appName, {
    name: args.appName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    serverFarmId: args.planId,
    kind: "functionapp,linux",
    httpsOnly: true,

    // Flex Consumption configuration
    functionAppConfig: {
      deployment: {
        storage: {
          type: "blobContainer",
          value: args.deploymentContainerUrl,
          authentication: args.storageIdentity
            ? {
                type: "UserAssignedIdentity",
                userAssignedIdentityResourceId: args.storageIdentity.identityId,
              }
            : {
                type: "StorageAccountConnectionString",
                storageAccountConnectionStringName: "AzureWebJobsStorage",
              },
        },
      },
      runtime: {
        name: "node",
        // Node 20 reached end of life in April 2026.
        version: "22",
      },
      scaleAndConcurrency: {
        instanceMemoryMB: 2048,
        maximumInstanceCount: args.maxInstances ?? 100,
        triggers: {
          http: {
            perInstanceConcurrency: args.httpPerInstanceConcurrency ?? 16,
          },
        },
      },
    },

    siteConfig: {
      appSettings,
    },
    // System identity: the RBAC grants on the sandbox group and session pool.
    // User identities (Key Vault references, Cosmos data) are granted before
    // the app exists, so the first start already has access.
    identity:
      userAssignedIdentities.length > 0
        ? { type: "SystemAssigned, UserAssigned", userAssignedIdentities }
        : { type: "SystemAssigned" },
    keyVaultReferenceIdentity: args.keyVaultReader?.identityId,
    tags: args.tags,
  }, {
    dependsOn: [
      ...(args.keyVaultReader ? [args.keyVaultReader.roleAssignment] : []),
      ...(args.cosmosIdentity ? [args.cosmosIdentity.roleAssignment] : []),
      ...(args.storageIdentity?.roleAssignments ?? []),
      ...(args.dependsOn ?? []),
    ],
  });
}

// ============================================================================
// Function App Easy Auth (Authentication/Authorization v2)
// ============================================================================

/**
 * Configure App Service Easy Auth for the Function App.
 *
 * Consumer-app baseline:
 *   - Google OAuth provider (optional; enabled only when client id + secret exist)
 *   - Return401 for unauthenticated requests when provider + requireAuth are enabled
 *   - Token store enabled for standard Easy Auth session behavior
 */
export function createFunctionAppAuthSettings(args: {
  resourceGroupName: pulumi.Input<string>;
  appName: pulumi.Input<string>;
  enabled: pulumi.Input<boolean>;
  requireAuthentication: pulumi.Input<boolean>;
  googleClientId?: pulumi.Input<string>;
  googleClientSecretSettingName?: pulumi.Input<string>;
  allowedAudiences?: pulumi.Input<pulumi.Input<string>[]>;
}) {
  const googleConfigured = pulumi
    .all([args.googleClientId, args.googleClientSecretSettingName])
    .apply(([id, secret]) => Boolean(id && secret));

  const effectiveRequireAuth = pulumi
    .all([args.enabled, args.requireAuthentication, googleConfigured])
    .apply(([enabled, requireAuth, configured]) => enabled && requireAuth && configured);

  const identityProviders = pulumi
    .all([
      args.googleClientId,
      args.googleClientSecretSettingName,
      args.allowedAudiences,
      googleConfigured,
    ])
    .apply(([clientId, secretSettingName, audiences, configured]) => {
      if (!configured || !clientId || !secretSettingName) return {};
      return {
        google: {
          enabled: true,
          registration: {
            clientId,
            clientSecretSettingName: secretSettingName,
          },
          validation:
            audiences && audiences.length > 0
              ? {
                  allowedAudiences: audiences,
                }
              : undefined,
        },
      };
    });

  return new web.WebAppAuthSettingsV2("agentforeach-functionapp-auth", {
    name: args.appName,
    resourceGroupName: args.resourceGroupName,
    platform: {
      enabled: args.enabled,
      runtimeVersion: "~1",
    },
    globalValidation: {
      requireAuthentication: effectiveRequireAuth,
      unauthenticatedClientAction: effectiveRequireAuth
        ? "Return401"
        : "AllowAnonymous",
      excludedPaths: ["/ws/*"],
    },
    login: {
      tokenStore: {
        enabled: true,
      },
    },
    identityProviders,
  }, {
    // Its name before the AgentForEach rename; a singleton, never recreate it.
    aliases: [{ name: "chitti-functionapp-auth" }],
  });
}
