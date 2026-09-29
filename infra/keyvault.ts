/**
 * AgentForEach Infrastructure — Key Vault for runtime secrets
 *
 * Secrets the Function App needs (Cosmos key, Web PubSub connection string,
 * LLM API keys) live in an RBAC Key Vault. App settings hold
 * `@Microsoft.KeyVault(SecretUri=…)` references, so the values never appear
 * in app settings or deployment logs.
 *
 * References are resolved with a user-assigned identity that is granted
 * "Key Vault Secrets User" before the Function App exists. With the app's
 * system identity the grant could only happen after the app had already
 * tried (and failed) to resolve its settings.
 */

import * as authorization from "@pulumi/azure-native/authorization";
import * as keyvault from "@pulumi/azure-native/keyvault";
import * as managedidentity from "@pulumi/azure-native/managedidentity";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

/** Built-in role "Key Vault Secrets User" (read secret values). */
export const KEY_VAULT_SECRETS_USER_ROLE_ID = "4633458b-17de-408a-b874-0445c86b69e6";

export interface RuntimeVault {
  vault: keyvault.Vault;
  /** Identity App Service uses to resolve the references (keyVaultReferenceIdentity). */
  readerIdentity: managedidentity.UserAssignedIdentity;
  /** The grant; the Function App must depend on it. */
  readerRoleAssignment: authorization.RoleAssignment;
}

export function createKeyVault(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  tenantId: pulumi.Input<string>;
  subscriptionId: pulumi.Input<string>;
  /** Prefix for the vault name; a random suffix makes it globally unique. */
  namePrefix: string;
  tags: Record<string, string>;
}): RuntimeVault {
  // Random, not derived from the resource group: a deleted vault keeps its
  // name reserved for the soft-delete period, so a derived name would block
  // re-creating the stack in the same resource group.
  const suffix = new random.RandomString("runtime-secrets-suffix", {
    length: 8,
    special: false,
    upper: false,
  });

  const vault = new keyvault.Vault("runtime-secrets", {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    vaultName: pulumi.interpolate`${args.namePrefix}-${suffix.result}`,
    properties: {
      tenantId: args.tenantId,
      sku: { family: "A", name: keyvault.SkuName.Standard },
      enableRbacAuthorization: true,
      enableSoftDelete: true,
      softDeleteRetentionInDays: 7,
    },
    tags: args.tags,
  });

  const readerIdentity = new managedidentity.UserAssignedIdentity("runtime-secrets-reader", {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    tags: args.tags,
  });

  const readerRoleAssignment = new authorization.RoleAssignment("runtime-secrets-reader-secrets-user", {
    scope: vault.id,
    roleDefinitionId: pulumi.interpolate`/subscriptions/${args.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${KEY_VAULT_SECRETS_USER_ROLE_ID}`,
    principalId: readerIdentity.principalId,
    principalType: "ServicePrincipal",
  });

  return { vault, readerIdentity, readerRoleAssignment };
}

/**
 * Store a secret and return the app-setting reference to it. Secrets are
 * written through the ARM control plane, so the deploying identity needs
 * no data-plane role on the vault.
 */
export function vaultSecretReference(args: {
  resourceGroupName: pulumi.Input<string>;
  vault: keyvault.Vault;
  name: string;
  value: pulumi.Input<string>;
}): pulumi.Output<string> {
  const secret = new keyvault.Secret(`kv-${args.name}`, {
    resourceGroupName: args.resourceGroupName,
    vaultName: args.vault.name,
    secretName: args.name,
    properties: { value: pulumi.secret(args.value) },
  }, {
    // Deleting a secret goes through the vault's data plane, where the
    // deploying identity has no role. Pulumi forgets a removed secret instead
    // (it stays in the vault, unreferenced) and the vault takes it on destroy.
    retainOnDelete: true,
  });
  // Versioned URI: a new value changes the app setting, which restarts the
  // app onto it. An unversioned one would keep serving the old value (for
  // example a rotated Cosmos key) for up to a day.
  return pulumi.interpolate`@Microsoft.KeyVault(SecretUri=${secret.properties.secretUriWithVersion})`;
}
