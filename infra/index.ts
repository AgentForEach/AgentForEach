/**
 * AgentForEach Infrastructure — Main Entry Point
 *
 * Provisions all Azure resources for AgentForEach:
 *   - Resource Group
 *   - Cosmos DB account, database, and containers
 *   - Storage Account + deployment blob container
 *   - Log Analytics Workspace + Application Insights
 *   - Function App (Flex Consumption, Node.js 20, Durable Functions)
 *   - Azure Web PubSub (real-time WebSocket communication)
 *
 * Stack outputs provide the connection details needed by the runtime.
 *
 * Usage:
 *   cd infra && npm install && pulumi up
 */

import * as resources from "@pulumi/azure-native/resources";
import * as authorization from "@pulumi/azure-native/authorization";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as cfg from "./config";
import { createKeyVault, vaultSecretReference } from "./keyvault";
import { createAlerts } from "./monitoring";
import {
  createCosmosAccount,
  createDatabase,
  createCosmosDataIdentity,
  createRuntimeContainers,
  runtimeContainerIds,
  getAccountKey,
} from "./cosmos";
import {
  createStorageAccount,
  createDeploymentContainer,
  createSkillsBlobContainer,
  createKnowledgeBlobContainer,
  getStorageConnectionString,
  createLogAnalyticsWorkspace,
  createApplicationInsights,
  createFlexConsumptionPlan,
  createFunctionApp,
  createFunctionAppAuthSettings,
} from "./functions";
import {
  createWebPubSub,
  createWebPubSubHub,
  getWebPubSubConnectionString,
  getWebPubSubSecondaryKey,
} from "./webpubsub";
import {
  createManagedEnvironment,
  createPythonLTSSessionPool,
  createCustomContainerSessionPool,
  createContainerRegistry,
  getRegistryCredentials,
  getLogAnalyticsSharedKey,
  createSandboxGroup,
  SANDBOX_GROUP_DATA_OWNER_ROLE_ID,
} from "./sandbox";
import type { AcaSandboxGroupSettings } from "./functions";
import {
  createSearchService,
  getSearchQueryKey,
} from "./search";

/** Blob, queue and table data roles: what the Functions host and Durable Functions need. */
const STORAGE_DATA_ROLE_IDS = {
  "blob-data-owner": "b7e6dc6d-f1e8-4753-8033-0f276bb0955b",
  "queue-data-contributor": "974c5e8b-45b9-4653-ba55-5f855dd0fb88",
  "table-data-contributor": "0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3",
} as const;

// ============================================================================
// Resource Group
// ============================================================================

const resourceGroup = new resources.ResourceGroup(cfg.name("rg"), {
  resourceGroupName: cfg.name("rg"),
  location: cfg.location,
  tags: cfg.tags,
});
const subscriptionId = resourceGroup.id.apply((id) => id.split("/")[2]);

// ============================================================================
// Cosmos DB
// ============================================================================

const cosmosAccountName = cfg.name("cosmos");
const databaseName = cfg.cosmosDatabaseName;

const cosmosAccount = createCosmosAccount({
  resourceGroupName: resourceGroup.name,
  location: cfg.location,
  accountName: cosmosAccountName,
  enableFreeTier: cfg.cosmosFreeTier,
  disableLocalAuth: cfg.cosmosDisableLocalAuth,
  capacity: cfg.cosmosCapacity,
  tags: cfg.tags,
});

// The runtime's identity for Cosmos data access (instead of the account key).
const cosmosData = cfg.cosmosManagedIdentity
  ? createCosmosDataIdentity({
      resourceGroupName: resourceGroup.name,
      location: cfg.location,
      account: cosmosAccount,
      tags: cfg.tags,
    })
  : undefined;

const database = createDatabase({
  resourceGroupName: resourceGroup.name,
  accountName: cosmosAccount.name,
  databaseName,
  autoscaleMaxRu: cfg.cosmosCapacity === "autoscale" ? cfg.cosmosAutoscaleMaxRu : undefined,
});

// Every container the runtime uses (cosmos-containers.json). The runtime
// only references them in the cloud, so they must exist before it starts.
const runtimeContainers = createRuntimeContainers({
  resourceGroupName: resourceGroup.name,
  accountName: cosmosAccount.name,
  databaseName: database.name,
});

// ============================================================================
// Azure Web PubSub — Real-Time Communication
// ============================================================================

const webPubSubName = cfg.name("pubsub");

const webPubSub = createWebPubSub({
  resourceGroupName: resourceGroup.name,
  location: cfg.location,
  resourceName: webPubSubName,
  sku: cfg.webPubSubSku,
  units: cfg.webPubSubUnits,
  tags: cfg.tags,
});

// Hub is created after the Function App so we can reference its hostname
// for the event handler URLs. See below after functionApp creation.

const webPubSubConnectionString = getWebPubSubConnectionString({
  resourceGroupName: resourceGroup.name,
  resourceName: webPubSub.name,
});
const webPubSubSecondaryKey = getWebPubSubSecondaryKey({
  resourceGroupName: resourceGroup.name,
  resourceName: webPubSub.name,
});

// ============================================================================
// Account Key (secret)
// ============================================================================

// Only when the runtime still uses key auth.
const cosmosKey = cfg.cosmosManagedIdentity
  ? undefined
  : getAccountKey({
      resourceGroupName: resourceGroup.name,
      accountName: cosmosAccount.name,
    });

// ============================================================================
// Key Vault — runtime secrets referenced from app settings
// ============================================================================

const runtimeVault = cfg.keyVaultEnabled
  ? createKeyVault({
      resourceGroupName: resourceGroup.name,
      location: cfg.location,
      tenantId: authorization.getClientConfigOutput().tenantId,
      subscriptionId,
      namePrefix: cfg.keyVaultPrefix,
      tags: cfg.tags,
    })
  : undefined;

/** A Key Vault reference when the vault is on, otherwise the value itself. */
function runtimeSecret(name: string, value: pulumi.Input<string>): pulumi.Input<string> {
  return runtimeVault
    ? vaultSecretReference({ resourceGroupName: resourceGroup.name, vault: runtimeVault.vault, name, value })
    : value;
}

// ============================================================================
// Azure Functions — Storage + Observability
// ============================================================================

const storageAccountName = cfg.storageName("fn");

const storageAccount = createStorageAccount({
  resourceGroupName: resourceGroup.name,
  location: cfg.location,
  accountName: storageAccountName,
  tags: cfg.tags,
});

const deploymentContainer = createDeploymentContainer({
  resourceGroupName: resourceGroup.name,
  accountName: storageAccount.name,
});

const skillsBlobContainer = createSkillsBlobContainer({
  resourceGroupName: resourceGroup.name,
  accountName: storageAccount.name,
});

let knowledgeBlobContainer: ReturnType<typeof createKnowledgeBlobContainer> | undefined;
if (cfg.searchEnabled) {
  knowledgeBlobContainer = createKnowledgeBlobContainer({
    resourceGroupName: resourceGroup.name,
    accountName: storageAccount.name,
  });
}

// Only when the runtime still uses the account key for AzureWebJobsStorage.
const storageConnectionString = cfg.storageManagedIdentity
  ? undefined
  : getStorageConnectionString({
  resourceGroupName: resourceGroup.name,
  accountName: storageAccount.name,
});

// Identity for the Functions host, Durable Functions and exports, granted
// before the app exists (the host needs storage to start at all).
const storageData = cfg.storageManagedIdentity
  ? (() => {
      const identity = new managedidentity.UserAssignedIdentity("runtime-storage", {
        resourceGroupName: resourceGroup.name,
        location: cfg.location,
        tags: cfg.tags,
      });
      const roleAssignments = Object.entries(STORAGE_DATA_ROLE_IDS).map(
        ([name, roleId]) =>
          new authorization.RoleAssignment(`runtime-storage-${name}`, {
            scope: storageAccount.id,
            roleDefinitionId: pulumi.interpolate`/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleId}`,
            principalId: identity.principalId,
            principalType: "ServicePrincipal",
          }),
      );
      return { identity, roleAssignments };
    })()
  : undefined;

// Deployment container URL: https://<account>.blob.core.windows.net/deployments
const deploymentContainerUrl = pulumi.interpolate`https://${storageAccount.name}.blob.core.windows.net/${deploymentContainer.name}`;

// — Log Analytics + Application Insights —
// (Shared by both App Insights and ACA environment)

const logAnalyticsWorkspace = createLogAnalyticsWorkspace({
  resourceGroupName: resourceGroup.name,
  location: cfg.location,
  workspaceName: cfg.name("logs"),
  dailyQuotaGb: cfg.logDailyCapGb,
  tags: cfg.tags,
});

const appInsights = createApplicationInsights({
  resourceGroupName: resourceGroup.name,
  location: cfg.location,
  componentName: cfg.name("insights"),
  workspaceResourceId: logAnalyticsWorkspace.id,
  tags: cfg.tags,
});

// ============================================================================
// Sandboxed Shell Execution — ACA Sandboxes (default) or Dynamic Sessions
// ============================================================================

let sandboxPoolEndpoint: pulumi.Output<string> | undefined;
let sandboxGroupId: pulumi.Output<string> | undefined;
let sandboxGroupSettings: AcaSandboxGroupSettings | undefined;
let sandboxSessionPoolId: pulumi.Output<string> | undefined;
let sandboxContainerTypeOutput: pulumi.Output<string> | undefined;

// ============================================================================
// Azure AI Search — Knowledge Base
// ============================================================================

let searchEndpoint: pulumi.Output<string> | undefined;
let searchQueryKey: pulumi.Output<string> | undefined;

if (cfg.searchEnabled) {
  const searchServiceName = cfg.name("search");

  const searchService = createSearchService({
    resourceGroupName: resourceGroup.name,
    location: cfg.location,
    serviceName: searchServiceName,
    sku: cfg.searchSku,
    semanticSearchTier: cfg.searchSemanticTier,
    replicaCount: cfg.searchReplicaCount,
    tags: cfg.tags,
  });

  searchEndpoint = pulumi.interpolate`https://${searchService.name}.search.windows.net`;
  searchQueryKey = getSearchQueryKey({
    resourceGroupName: resourceGroup.name,
    serviceName: searchService.name,
  });
}

if (cfg.sandboxEnabled && cfg.sandboxProvider === "aca-sandboxes") {
  const sandboxGroupLocation = cfg.sandboxGroupLocation ?? cfg.location;
  const sandboxGroup = createSandboxGroup({
    resourceGroupName: resourceGroup.name,
    resourceGroupId: resourceGroup.id,
    location: sandboxGroupLocation,
    sandboxGroupName: cfg.name("sandboxes"),
    maxSandboxCount: cfg.sandboxGroupMaxCount,
    tags: cfg.tags,
  });
  sandboxGroupId = sandboxGroup.id;
  sandboxGroupSettings = {
    subscriptionId,
    resourceGroup: resourceGroup.name,
    group: sandboxGroup.name,
    region: sandboxGroupLocation,
    diskImageId: cfg.sandboxDiskImageId,
  };
}

if (cfg.sandboxEnabled && cfg.sandboxProvider === "aca-sessions") {
  const logAnalyticsSharedKey = getLogAnalyticsSharedKey({
    resourceGroupName: resourceGroup.name,
    workspaceName: logAnalyticsWorkspace.name,
  });

  const acaEnvironment = createManagedEnvironment({
    resourceGroupName: resourceGroup.name,
    location: cfg.location,
    environmentName: cfg.name("aca-env"),
    logAnalyticsWorkspaceId: logAnalyticsWorkspace.customerId,
    logAnalyticsSharedKey,
    enableWorkloadProfiles: cfg.sandboxContainerType === "CustomContainer",
    tags: cfg.tags,
  });

  if (cfg.sandboxContainerType === "CustomContainer") {
    // ── CustomContainer: ACR + custom image ──
    const acrName = cfg.storageName("acr");
    const acr = createContainerRegistry({
      resourceGroupName: resourceGroup.name,
      location: cfg.location,
      registryName: acrName,
      tags: cfg.tags,
    });

    const acrCreds = getRegistryCredentials({
      resourceGroupName: resourceGroup.name,
      registryName: acr.name,
    });

    const acrServer = pulumi.interpolate`${acr.name}.azurecr.io`;
    const containerImage = cfg.sandboxContainerImage
      ? pulumi.output(cfg.sandboxContainerImage)
      : pulumi.interpolate`${acrServer}/agentforeach-sandbox:latest`;

    const sessionPool = createCustomContainerSessionPool({
      resourceGroupName: resourceGroup.name,
      location: cfg.location,
      sessionPoolName: cfg.storageName("sandbox"),
      environmentId: acaEnvironment.id,
      containerImage,
      cpu: cfg.sandboxContainerCpu,
      memory: cfg.sandboxContainerMemory,
      targetPort: cfg.sandboxContainerPort,
      registryServer: acrServer,
      registryUsername: acrCreds.apply((c) => c.username ?? ""),
      registryPassword: acrCreds.apply(
        (c) => c.passwords?.[0]?.value ?? "",
      ),
      maxConcurrentSessions: cfg.sandboxMaxConcurrentSessions,
      readySessionInstances: cfg.sandboxReadyInstances,
      cooldownPeriodInSeconds: cfg.sandboxCooldownSec,
      networkStatus: cfg.sandboxNetworkStatus,
      tags: cfg.tags,
    });

    sandboxPoolEndpoint = sessionPool.poolManagementEndpoint;
    sandboxSessionPoolId = sessionPool.id;
    sandboxContainerTypeOutput = pulumi.output("CustomContainer");

    // Export ACR details for image build/push
    exports.sandboxAcrName = acr.name;
    exports.sandboxAcrServer = acrServer;
  } else {
    // ── PythonLTS: Azure-managed Code Interpreter ──
    const sessionPool = createPythonLTSSessionPool({
      resourceGroupName: resourceGroup.name,
      location: cfg.location,
      sessionPoolName: cfg.storageName("sandbox"),
      environmentId: acaEnvironment.id,
      maxConcurrentSessions: cfg.sandboxMaxConcurrentSessions,
      readySessionInstances: cfg.sandboxReadyInstances,
      cooldownPeriodInSeconds: cfg.sandboxCooldownSec,
      networkStatus: cfg.sandboxNetworkStatus,
      tags: cfg.tags,
    });

    sandboxPoolEndpoint = sessionPool.poolManagementEndpoint;
    sandboxSessionPoolId = sessionPool.id;
    sandboxContainerTypeOutput = pulumi.output("PythonLTS");
  }
}

// ============================================================================
// Azure Functions — Flex Consumption + Function App
// ============================================================================

const flexPlan = createFlexConsumptionPlan({
  resourceGroupName: resourceGroup.name,
  location: cfg.location,
  planName: cfg.name("plan"),
  tags: cfg.tags,
});

// — Function App —

// Names are read from the stack config file at preview time (values stay secret).
const extraAppSettingNames: string[] = Object.keys(
  (new pulumi.Config("agentforeach").getObject<Record<string, unknown>>("extraAppSettings") ?? {}) as object,
);

const functionApp = createFunctionApp({
  resourceGroupName: resourceGroup.name,
  location: cfg.location,
  appName: cfg.name("func"),
  planId: flexPlan.id,
  storageAccountName: storageAccount.name,
  storageConnectionString,
  storageIdentity: storageData
    ? {
        accountName: storageAccount.name,
        identityId: storageData.identity.id,
        clientId: storageData.identity.clientId,
        roleAssignments: storageData.roleAssignments,
      }
    : undefined,
  deploymentContainerUrl,
  cosmosEndpoint: cosmosAccount.documentEndpoint,
  cosmosKey: cosmosKey ? runtimeSecret("cosmos-key", cosmosKey) : undefined,
  cosmosIdentity: cosmosData
    ? {
        identityId: cosmosData.identity.id,
        clientId: cosmosData.identity.clientId,
        roleAssignment: cosmosData.roleAssignment,
      }
    : undefined,
  cosmosDatabaseName: pulumi.output(databaseName),
  webPubSubHub: cfg.webPubSubHub,
  openaiApiKey: runtimeSecret("openai-api-key", cfg.openaiApiKey),
  webPubSubConnectionString: runtimeSecret("webpubsub-connection-string", webPubSubConnectionString),
  webPubSubSecondaryAccessKey: runtimeSecret("webpubsub-secondary-key", webPubSubSecondaryKey),
  webPubSubUpstreamSharedSecret: cfg.webPubSubUpstreamSharedSecret
    ? runtimeSecret("webpubsub-upstream-shared-secret", cfg.webPubSubUpstreamSharedSecret)
    : undefined,
  webPubSubRequireUpstreamSecret: cfg.webPubSubRequireUpstreamSecret,
  appInsightsConnectionString: appInsights.connectionString,
  authAllowInsecureUserIdHeader: cfg.authAllowInsecureUserIdHeader,
  cronSchedulerShards: cfg.cronSchedulerShards,
  corsAllowedOrigins:
    cfg.corsAllowedOrigins.length > 0
      ? cfg.corsAllowedOrigins.join(",")
      : undefined,
  easyAuthGoogleClientSecret: cfg.easyAuthGoogleClientSecret
    ? runtimeSecret("easy-auth-google-client-secret", cfg.easyAuthGoogleClientSecret)
    : undefined,
  acaPoolManagementEndpoint: sandboxPoolEndpoint,
  sandboxProvider: cfg.sandboxEnabled ? cfg.sandboxProvider : undefined,
  acaSandboxGroup: sandboxGroupSettings,
  searchEndpoint,
  searchQueryKey: searchQueryKey ? runtimeSecret("search-query-key", searchQueryKey) : undefined,
  extraAppSettings: extraAppSettingNames.map((name) => ({
    name,
    value: runtimeSecret(
      `extra-${name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
      cfg.extraAppSettings!.apply((s) => s![name]!),
    ),
  })),
  // Keys the HMAC that pseudonymises user and chat ids in logs.
  logRedactionKey: runtimeSecret(
    "log-redaction-key",
    new random.RandomPassword("log-redaction-key", { length: 48, special: false }).result,
  ),
  keyVaultReader: runtimeVault
    ? { identityId: runtimeVault.readerIdentity.id, roleAssignment: runtimeVault.readerRoleAssignment }
    : undefined,
  dependsOn: [runtimeContainers],
  maxInstances: cfg.functionMaxInstances,
  httpPerInstanceConcurrency: cfg.httpPerInstanceConcurrency,
  tags: cfg.tags,
});

const functionAppAuth = cfg.easyAuthEnabled
  ? createFunctionAppAuthSettings({
      resourceGroupName: resourceGroup.name,
      appName: functionApp.name,
      enabled: true,
      requireAuthentication: cfg.easyAuthRequireAuthentication,
      googleClientId: cfg.easyAuthGoogleClientId,
      googleClientSecretSettingName: "EASY_AUTH_GOOGLE_CLIENT_SECRET",
      allowedAudiences: cfg.easyAuthAllowedAudiences,
    })
  : undefined;

// ============================================================================
// RBAC — Sandbox Session Executor
// ============================================================================
// Grant the Function App's system-assigned managed identity the
// "Azure ContainerApps Session Executor" role on the session pool.

if (sandboxSessionPoolId) {
  // Role definition for "Azure ContainerApps Session Executor"
  const roleDefinitionId = pulumi.interpolate`/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0`;

  new authorization.RoleAssignment("sandbox-session-executor", {
    scope: sandboxSessionPoolId,
    roleDefinitionId,
    principalId: functionApp.identity.apply(
      (id) => id?.principalId ?? "",
    ),
    principalType: "ServicePrincipal",
  });
}

// ============================================================================
// RBAC — ACA Sandboxes
// ============================================================================
// The runtime creates, resumes, runs and deletes sandboxes in the group with
// the Function App's system-assigned managed identity.

if (sandboxGroupId) {
  new authorization.RoleAssignment("sandbox-group-data-owner", {
    scope: sandboxGroupId,
    roleDefinitionId: pulumi.interpolate`/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${SANDBOX_GROUP_DATA_OWNER_ROLE_ID}`,
    principalId: functionApp.identity.apply((id) => id?.principalId ?? ""),
    principalType: "ServicePrincipal",
  });
}

// ============================================================================
// Web PubSub Hub — Event Handlers → Function App
// ============================================================================

// Hub is created after the Function App so we can wire CloudEvents
// (connect, message, disconnected) to the Function App's endpoints.
const functionAppUrl = pulumi.interpolate`https://${functionApp.defaultHostName}`;

const webPubSubHub = createWebPubSubHub({
  resourceGroupName: resourceGroup.name,
  webPubSubName: webPubSub.name,
  hubName: cfg.webPubSubHub,
  functionAppUrl,
});

// ============================================================================
// Alerts
// ============================================================================

createAlerts({
  resourceGroupName: resourceGroup.name,
  prefix: cfg.name("alert"),
  functionAppId: functionApp.id,
  webPubSubId: webPubSub.id,
  cosmosAccountId: cosmosAccount.id,
  appInsightsId: appInsights.id,
  location: cfg.location,
  alertEmail: cfg.alertEmail,
  tags: cfg.tags,
});

// Cosmos DB connection details (runtime: database/client.ts, memory/config.ts)
export const cosmosEndpoint = cosmosAccount.documentEndpoint;
export const cosmosDatabaseName = pulumi.output(databaseName);
export const cosmosContainerNames = runtimeContainerIds;

// Resource identifiers
export const resourceGroupName = resourceGroup.name;
export const cosmosAccountId = cosmosAccount.id;

// Function App
export const functionAppName = functionApp.name;
export const functionAppDefaultHostname = functionApp.defaultHostName;
export const storageAccountId = storageAccount.id;
export const skillsBlobContainerName = skillsBlobContainer.name;
export const functionAppEasyAuthConfigured = pulumi
  .all([
    cfg.easyAuthEnabled,
    cfg.easyAuthGoogleClientId,
    cfg.easyAuthGoogleClientSecret,
  ])
  .apply(([enabled, clientId, clientSecret]) => enabled && Boolean(clientId && clientSecret));
export const functionAppEasyAuthResourceId = functionAppAuth?.id;

// Application Insights (observability)
export const appInsightsName = appInsights.name;
export const appInsightsConnectionStr = appInsights.connectionString;
export const logAnalyticsWorkspaceId = logAnalyticsWorkspace.id;

// Web PubSub (real-time communication)
export const webPubSubHostName = webPubSub.hostName;
export const webPubSubId = webPubSub.id;

// Sandbox (ACA Sandboxes or Dynamic Sessions)
export const sandboxEnabled = pulumi.output(cfg.sandboxEnabled);
export const sandboxBackend = cfg.sandboxEnabled ? cfg.sandboxProvider : "disabled";
/** Dynamic Sessions container type; "n/a" for ACA Sandboxes. */
export const sandboxContainerType = sandboxContainerTypeOutput ?? "n/a";
// Only export endpoint when sandbox is provisioned (avoids "Undefined value" warning)
if (sandboxPoolEndpoint) {
  exports.sandboxPoolManagementEndpoint = sandboxPoolEndpoint;
}

// Azure AI Search (knowledge base)
export const searchEnabled = pulumi.output(cfg.searchEnabled);
if (searchEndpoint) {
  exports.searchEndpointUrl = searchEndpoint;
}
if (knowledgeBlobContainer) {
  exports.knowledgeBlobContainerName = knowledgeBlobContainer.name;
}
