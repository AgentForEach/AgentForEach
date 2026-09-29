/**
 * AgentForEach Infrastructure — Sandboxes
 *
 * Primary: an ACA Sandboxes group (createSandboxGroup). The runtime creates
 * one sandbox per user in it on demand.
 *
 * Fallback: an ACA Dynamic Sessions session pool, described below.
 *
 * Provisions an Azure Container Apps Session Pool for sandboxed shell execution.
 * Supports two container types:
 *
 *   - PythonLTS        — Azure-managed Python Code Interpreter (no image needed)
 *   - CustomContainer  — Bring-your-own image with multi-runtime support
 *
 * For CustomContainer, we also provision:
 *   - Azure Container Registry (ACR) — hosts the custom sandbox image
 *   - The session pool references the ACR image and credentials
 *
 * Common infrastructure:
 *   - ManagedEnvironment — lightweight ACA environment (hosts the session pool)
 *   - ContainerAppsSessionPool — sandboxed sessions with Hyper-V isolation
 *
 * The pool management endpoint is exported and wired into the Function App
 * as ACA_POOL_MANAGEMENT_ENDPOINT so the sandbox client can reach it at runtime.
 */

import * as app from "@pulumi/azure-native/app";
import * as containerregistry from "@pulumi/azure-native/containerregistry";
import * as operationalinsights from "@pulumi/azure-native/operationalinsights";
import * as resources from "@pulumi/azure-native/resources";
import * as pulumi from "@pulumi/pulumi";

// ============================================================================
// Container Apps Managed Environment
// ============================================================================

/**
 * Create a lightweight Container Apps Managed Environment.
 *
 * This is required as the host for the session pool. We use Consumption-only
 * (no dedicated workload profiles) to keep costs at zero when idle.
 */
export function createManagedEnvironment(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  environmentName: string;
  logAnalyticsWorkspaceId: pulumi.Input<string>;
  logAnalyticsSharedKey: pulumi.Input<string>;
  /** Enable workload profiles (required for CustomContainer session pools). */
  enableWorkloadProfiles?: boolean;
  tags: Record<string, string>;
}) {
  return new app.ManagedEnvironment(args.environmentName, {
    environmentName: args.environmentName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    appLogsConfiguration: {
      destination: "log-analytics",
      logAnalyticsConfiguration: {
        customerId: args.logAnalyticsWorkspaceId,
        sharedKey: args.logAnalyticsSharedKey,
      },
    },
    // CustomContainer session pools require a Workload-Profile environment.
    // Adding the Consumption profile enables workload-profile mode without
    // provisioning any dedicated compute (still consumption-based billing).
    // NOTE: workloadProfiles are managed via Azure CLI because the default
    // azure-native API version (pre-2022-11-01) doesn't support them.
    // We use ignoreChanges to prevent Pulumi from trying to set them.
    tags: args.tags,
  }, {
    ignoreChanges: args.enableWorkloadProfiles
      ? ["workloadProfiles"]
      : undefined,
  });
}

// ============================================================================
// Azure Container Registry (for CustomContainer images)
// ============================================================================

/**
 * Create an Azure Container Registry to host custom sandbox container images.
 * Uses Basic SKU (cheapest tier, sufficient for this use case).
 */
export function createContainerRegistry(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  registryName: string;
  tags: Record<string, string>;
}) {
  return new containerregistry.Registry(args.registryName, {
    registryName: args.registryName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: { name: "Basic" },
    adminUserEnabled: true, // Needed for session pool registry credentials
    tags: args.tags,
  });
}

/**
 * Get the admin credentials for an ACR instance.
 * Used to configure session pool registry authentication.
 */
export function getRegistryCredentials(args: {
  resourceGroupName: pulumi.Input<string>;
  registryName: pulumi.Input<string>;
}) {
  return pulumi
    .all([args.resourceGroupName, args.registryName])
    .apply(([rgName, regName]) =>
      containerregistry.listRegistryCredentials({
        resourceGroupName: rgName,
        registryName: regName,
      }),
    );
}

// ============================================================================
// Session Pool — PythonLTS
// ============================================================================

/**
 * Create a PythonLTS session pool (Azure-managed Python Code Interpreter).
 */
export function createPythonLTSSessionPool(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  sessionPoolName: string;
  environmentId: pulumi.Input<string>;
  maxConcurrentSessions?: number;
  readySessionInstances?: number;
  cooldownPeriodInSeconds?: number;
  networkStatus?: "EgressEnabled" | "EgressDisabled";
  tags: Record<string, string>;
}) {
  return new app.ContainerAppsSessionPool(args.sessionPoolName, {
    sessionPoolName: args.sessionPoolName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    environmentId: args.environmentId,
    containerType: "PythonLTS",
    poolManagementType: "Dynamic",
    dynamicPoolConfiguration: {
      cooldownPeriodInSeconds: args.cooldownPeriodInSeconds ?? 600,
      executionType: "Timed",
    },
    scaleConfiguration: {
      maxConcurrentSessions: args.maxConcurrentSessions ?? 10,
      readySessionInstances: args.readySessionInstances ?? 0,
    },
    sessionNetworkConfiguration: {
      status: args.networkStatus ?? "EgressDisabled",
    },
    tags: args.tags,
  });
}

// ============================================================================
// Session Pool — CustomContainer
// ============================================================================

/**
 * Create a CustomContainer session pool with a user-provided container image.
 *
 * The custom container must expose an HTTP server on the specified target port.
 * ACA forwards requests from the pool management endpoint to the container.
 *
 * Preinstalled runtimes in the AgentForEach sandbox image:
 *   Python 3.11, Node.js 22, Java 17, PHP 8.2, Ruby 3.1, Go 1.23
 */
export function createCustomContainerSessionPool(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  sessionPoolName: string;
  environmentId: pulumi.Input<string>;
  /** Container image URI (e.g. myregistry.azurecr.io/sandbox:latest) */
  containerImage: pulumi.Input<string>;
  /** CPU cores for each session container (default: 0.5) */
  cpu?: number;
  /** Memory for each session container (default: "1Gi") */
  memory?: string;
  /** HTTP port the container listens on (default: 8080) */
  targetPort?: number;
  /** ACR registry server (e.g. myregistry.azurecr.io) */
  registryServer: pulumi.Input<string>;
  /** ACR admin username */
  registryUsername: pulumi.Input<string>;
  /** ACR admin password (stored as a session pool secret) */
  registryPassword: pulumi.Input<string>;
  maxConcurrentSessions?: number;
  readySessionInstances?: number;
  cooldownPeriodInSeconds?: number;
  networkStatus?: "EgressEnabled" | "EgressDisabled";
  tags: Record<string, string>;
}) {
  return new app.ContainerAppsSessionPool(args.sessionPoolName, {
    sessionPoolName: args.sessionPoolName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    environmentId: args.environmentId,
    containerType: "CustomContainer",
    poolManagementType: "Dynamic",

    customContainerTemplate: {
      containers: [
        {
          name: "sandbox",
          image: args.containerImage,
          resources: {
            cpu: args.cpu ?? 0.5,
            memory: args.memory ?? "1Gi",
          },
        },
      ],
      ingress: {
        targetPort: args.targetPort ?? 8080,
      },
      registryCredentials: {
        registryServer: args.registryServer,
        username: args.registryUsername,
        passwordSecretRef: "registry-password",
      },
    },

    secrets: [
      {
        name: "registry-password",
        value: args.registryPassword,
      },
    ],

    dynamicPoolConfiguration: {
      cooldownPeriodInSeconds: args.cooldownPeriodInSeconds ?? 600,
      executionType: "Timed",
    },

    scaleConfiguration: {
      maxConcurrentSessions: args.maxConcurrentSessions ?? 10,
      readySessionInstances: args.readySessionInstances ?? 0,
    },

    sessionNetworkConfiguration: {
      status: args.networkStatus ?? "EgressDisabled",
    },

    tags: args.tags,
  }, {
    // WORKAROUND: The azure-native provider (v2.x) has a serialization bug
    // where `registryCredentials.registryServer` is not mapped to the Azure
    // REST API field `server`, causing a 400 error on ANY update.
    // Even with ignoreChanges on specific fields, the provider sends the
    // full resource body on PUT, which includes the broken mapping.
    // We manage the CustomContainer session pool entirely via Azure CLI
    // and use Pulumi only for state tracking (import/refresh).
    ignoreChanges: ["*"],
  });
}

// ============================================================================
// Legacy alias (backwards compat)
// ============================================================================

/**
 * @deprecated Use createPythonLTSSessionPool or createCustomContainerSessionPool.
 */
export const createSessionPool = createPythonLTSSessionPool;

// ============================================================================
// Log Analytics Shared Key (needed for ManagedEnvironment)
// ============================================================================

/**
 * Get the shared key for a Log Analytics workspace.
 * Required to configure Container Apps environment logging.
 */
export function getLogAnalyticsSharedKey(args: {
  resourceGroupName: pulumi.Input<string>;
  workspaceName: pulumi.Input<string>;
}) {
  return pulumi
    .all([args.resourceGroupName, args.workspaceName])
    .apply(([rgName, wsName]) =>
      operationalinsights.getSharedKeys({
        resourceGroupName: rgName,
        workspaceName: wsName,
      }),
    )
    .apply((keys) => keys.primarySharedKey ?? "");
}

// ============================================================================
// ACA Sandboxes — Sandbox Group
// ============================================================================

export const SANDBOX_GROUP_API_VERSION = "2026-02-01-preview";

/** Built-in role "Container Apps SandboxGroup Data Owner". */
export const SANDBOX_GROUP_DATA_OWNER_ROLE_ID = "c24cf47c-5077-412d-a19c-45202126392c";

/**
 * Create an ACA Sandboxes group (Microsoft.App/sandboxGroups).
 *
 * The azure-native provider has no type for this preview resource yet, so it
 * is deployed through an ARM template. Deleting the Pulumi resource does not
 * delete the group; it goes when the resource group does.
 */
export function createSandboxGroup(args: {
  resourceGroupName: pulumi.Input<string>;
  resourceGroupId: pulumi.Input<string>;
  location: pulumi.Input<string>;
  sandboxGroupName: string;
  maxSandboxCount?: number;
  tags: Record<string, string>;
}) {
  const deployment = new resources.Deployment(`${args.sandboxGroupName}-deployment`, {
    resourceGroupName: args.resourceGroupName,
    properties: {
      mode: resources.DeploymentMode.Incremental,
      template: {
        $schema:
          "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        contentVersion: "1.0.0.0",
        resources: [
          {
            type: "Microsoft.App/sandboxGroups",
            apiVersion: SANDBOX_GROUP_API_VERSION,
            name: args.sandboxGroupName,
            location: args.location,
            tags: args.tags,
            properties:
              args.maxSandboxCount !== undefined
                ? { maxSandboxCount: args.maxSandboxCount }
                : {},
          },
        ],
      },
    },
  });

  // Build the id from known parts rather than the deployment's outputs,
  // which can be missing after a refresh or import. `apply` on the
  // deployment keeps the dependency so RBAC waits for the group to exist.
  const id = pulumi
    .all([args.resourceGroupId, deployment.id])
    .apply(([rgId]) => `${rgId}/providers/Microsoft.App/sandboxGroups/${args.sandboxGroupName}`);

  return { name: pulumi.output(args.sandboxGroupName), id };
}
