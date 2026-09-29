/**
 * AgentForEach Infrastructure — Cosmos DB
 *
 * Provisions the Cosmos DB account, database, and every container the
 * runtime uses. Container definitions come from cosmos-containers.json,
 * generated from the runtime's own stores (gateway database/catalog.ts),
 * so partition keys, TTLs and indexing/vector/full-text policies can't drift.
 */

import * as documentdb from "@pulumi/azure-native/documentdb";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as random from "@pulumi/random";
import * as resources from "@pulumi/azure-native/resources";
import * as enums from "@pulumi/azure-native/types/enums/documentdb";
import * as pulumi from "@pulumi/pulumi";
import catalog from "./cosmos-containers.json";

// ============================================================================
// Account
// ============================================================================

export function createCosmosAccount(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  accountName: string;
  enableFreeTier: boolean;
  /** Entra ID only: the account keys stop working. */
  disableLocalAuth?: boolean;
  /** Serverless (pay per request) or provisioned throughput (autoscale). */
  capacity?: "serverless" | "autoscale";
  tags: Record<string, string>;
}) {
  return new documentdb.DatabaseAccount(args.accountName, {
    disableLocalAuth: args.disableLocalAuth ?? false,
    accountName: args.accountName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    databaseAccountOfferType: enums.DatabaseAccountOfferType.Standard,
    kind: "GlobalDocumentDB",

    // Serverless: no idle cost (development, small deployments). Autoscale:
    // provisioned throughput set on the database (production).
    capabilities: [
      ...(args.capacity === "autoscale" ? [] : [{ name: "EnableServerless" }]),
      { name: "EnableNoSQLVectorSearch" },
    ],

    // Single-region write (matches dev usage, upgradeable for prod)
    locations: [
      {
        locationName: args.location,
        failoverPriority: 0,
        isZoneRedundant: false,
      },
    ],

    // Session consistency — good balance for single-user assistant
    consistencyPolicy: {
      defaultConsistencyLevel: enums.DefaultConsistencyLevel.Session,
    },

    enableFreeTier: args.enableFreeTier,

    // Vector search is only supported on NoSQL API (the default)
    // Full-text search requires this capability flag
    tags: args.tags,
  });
}

// ============================================================================
// Database
// ============================================================================

export function createDatabase(args: {
  resourceGroupName: pulumi.Input<string>;
  accountName: pulumi.Input<string>;
  databaseName: string;
  /** Provisioned accounts: throughput shared by every container. */
  autoscaleMaxRu?: number;
}) {
  return new documentdb.SqlResourceSqlDatabase(args.databaseName, {
    resourceGroupName: args.resourceGroupName,
    accountName: args.accountName,
    databaseName: args.databaseName,
    resource: {
      id: args.databaseName,
    },
    ...(args.autoscaleMaxRu ? { options: { autoscaleSettings: { maxThroughput: args.autoscaleMaxRu } } } : {}),
  });
}


// ============================================================================
// Containers
// ============================================================================

/** First sqlContainers API version with fullTextPolicy (not in azure-native 2.x). */
const SQL_CONTAINER_API_VERSION = "2024-12-01-preview";

type CatalogContainer = {
  id: string;
  partitionKey: { paths: string[]; kind?: string; version?: number };
  defaultTtl?: number;
  indexingPolicy?: Record<string, unknown>;
  vectorEmbeddingPolicy?: Record<string, unknown>;
  fullTextPolicy?: Record<string, unknown>;
};

/** The ARM `resource` body for one catalog container. */
export function sqlContainerResource(c: CatalogContainer): Record<string, unknown> {
  return {
    id: c.id,
    partitionKey: { kind: "Hash", version: 2, ...c.partitionKey },
    ...(c.defaultTtl !== undefined ? { defaultTtl: c.defaultTtl } : {}),
    ...(c.indexingPolicy ? { indexingPolicy: c.indexingPolicy } : {}),
    ...(c.vectorEmbeddingPolicy ? { vectorEmbeddingPolicy: c.vectorEmbeddingPolicy } : {}),
    ...(c.fullTextPolicy ? { fullTextPolicy: c.fullTextPolicy } : {}),
  };
}

/**
 * Every runtime container, in one incremental ARM deployment (the runtime
 * only references containers in the cloud, it doesn't create them). The
 * Function App should depend on the returned resource.
 */
export function createRuntimeContainers(args: {
  resourceGroupName: pulumi.Input<string>;
  accountName: pulumi.Input<string>;
  databaseName: pulumi.Input<string>;
}) {
  const containers = catalog as CatalogContainer[];
  return new resources.Deployment("cosmos-containers", {
    resourceGroupName: args.resourceGroupName,
    properties: {
      mode: resources.DeploymentMode.Incremental,
      template: pulumi.all([args.accountName, args.databaseName]).apply(([account, database]) => ({
        $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        contentVersion: "1.0.0.0",
        resources: containers.map((c) => ({
          type: "Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers",
          apiVersion: SQL_CONTAINER_API_VERSION,
          name: `${account}/${database}/${c.id}`,
          properties: { resource: sqlContainerResource(c) },
        })),
      })),
    },
  });
}

/** Built-in "Cosmos DB Built-in Data Contributor" (data-plane read/write). */
export const COSMOS_DATA_CONTRIBUTOR_ROLE_ID = "00000000-0000-0000-0000-000000000002";

/**
 * A user-assigned identity with data-plane access to the account, created
 * and granted before the Function App starts (a system identity could only
 * be granted after it had started and failed its first requests).
 */
export function createCosmosDataIdentity(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  account: documentdb.DatabaseAccount;
  tags: Record<string, string>;
}) {
  const identity = new managedidentity.UserAssignedIdentity("cosmos-data", {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    tags: args.tags,
  });
  // Cosmos requires the assignment's name to be a GUID; keep it stable.
  const assignmentId = new random.RandomUuid("cosmos-data-contributor-id");
  const roleAssignment = new documentdb.SqlResourceSqlRoleAssignment("cosmos-data-contributor", {
    resourceGroupName: args.resourceGroupName,
    accountName: args.account.name,
    roleAssignmentId: assignmentId.result,
    roleDefinitionId: pulumi.interpolate`${args.account.id}/sqlRoleDefinitions/${COSMOS_DATA_CONTRIBUTOR_ROLE_ID}`,
    scope: args.account.id,
    principalId: identity.principalId,
  });
  return { identity, roleAssignment };
}

/** Container ids, for stack outputs. */
export const runtimeContainerIds = (catalog as CatalogContainer[]).map((c) => c.id);

// ============================================================================
// Keys
// ============================================================================

/**
 * Retrieve the primary key for the Cosmos DB account.
 * Returns an Output<string> that is automatically treated as a secret.
 */
export function getAccountKey(args: {
  resourceGroupName: pulumi.Input<string>;
  accountName: pulumi.Input<string>;
}): pulumi.Output<string> {
  return pulumi
    .all([args.resourceGroupName, args.accountName])
    .apply(([rg, account]) =>
      documentdb.listDatabaseAccountKeys({
        resourceGroupName: rg,
        accountName: account,
      }),
    )
    .apply((keys: documentdb.ListDatabaseAccountKeysResult) => keys.primaryMasterKey)
    .apply((key: string) => pulumi.secret(key));
}

