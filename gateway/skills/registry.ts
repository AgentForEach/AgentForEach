/**
 * AgentForEach Skills Layer — Registry
 *
 * Combines SKILL.md manifests from Azure Blob Storage with per-user
 * Cosmos DB configurations to produce resolved skill statuses and
 * merged user credentials for exec.
 *
 * The resolution process:
 *   1. Load all skill manifests from Blob Storage (cached)
 *   2. Load the user's skill configs from Cosmos DB
 *   3. Apply per-agent skill filter (Layer 3: enabledSkills whitelist)
 *   4. For each skill: check enabled + credentials complete
 *      - Credential-free skills are auto-enabled (no explicit setup needed)
 *   5. Merge all active skill credentials into one Record for exec env
 *   6. Return { statuses, userCredentials }
 */

import type {
  SkillManifest,
  SkillStatus,
  CredentialSpec,
  CredentialBinding,
} from "./types.js";
import type { SkillBlobStore } from "./blob-store.js";
import type { UserSkillStore } from "./store.js";

// ============================================================================
// Resolved Skills (per-user, per-request)
// ============================================================================

/** Result of resolving skills for a specific user. */
export interface ResolvedSkills {
  /** Status of all known skills (for prompt + meta-tools). */
  statuses: SkillStatus[];
  /** Merged credentials from all active skills (injected as exec env vars). */
  userCredentials: Record<string, string>;
  /** Host bindings for credentials whose skill declares `hosts`. */
  credentialBindings: Record<string, CredentialBinding>;
}

// ============================================================================
// Per-User Resolution
// ============================================================================

/**
 * Resolve all skills for a specific user.
 *
 * Cross-references Blob Storage manifests with the user's Cosmos DB configs
 * to determine which skills are active and collect their credentials.
 *
 * @param blobStore - Blob Storage adapter for skill manifests.
 * @param store - User skill config store (Cosmos DB).
 * @param userId - The user to resolve skills for.
 * @param agentEnabledSkills - Per-agent skill whitelist from TOOLS prompt doc.
 *   If provided and non-empty, only skills in this list are included.
 *   If undefined or empty, all user skills are available.
 */
export async function resolveUserSkills(
  blobStore: SkillBlobStore,
  store: UserSkillStore,
  userId: string,
  agentEnabledSkills?: string[],
): Promise<ResolvedSkills> {
  // Load manifests (cached 5-min in BlobStore) and user configs in parallel
  const [manifests, userConfigs] = await Promise.all([
    blobStore.listSkills(),
    store.getAllForUser(userId),
  ]);

  const configMap = new Map(userConfigs.map((c) => [c.skillId, c]));

  // Per-agent whitelist filter (Layer 3)
  const agentFilter = agentEnabledSkills?.length
    ? new Set(agentEnabledSkills)
    : undefined;

  const statuses: SkillStatus[] = [];
  const userCredentials: Record<string, string> = {};
  const credentialBindings: Record<string, CredentialBinding> = {};

  for (const manifest of manifests) {
    // Layer 3: skip skills not in agent whitelist
    if (agentFilter && !agentFilter.has(manifest.id)) continue;

    const config = configMap.get(manifest.id);
    const configured = !!config;
    const isCredentialFree = manifest.credentials.every((c) => !c.required);

    // Auto-enable credential-free skills (e.g., weather)
    const enabled = config?.enabled ?? isCredentialFree;
    const credentialsComplete = areCredentialsComplete(
      manifest.credentials,
      config?.credentials ?? {},
    );

    statuses.push({
      manifest,
      configured,
      credentialsComplete,
      enabled,
    });

    // Merge credentials from active skills into the shared exec env
    if (enabled && credentialsComplete && config?.credentials) {
      for (const [key, value] of Object.entries(config.credentials)) {
        if (value?.trim()) {
          userCredentials[key] = value;
        }
      }
      for (const spec of manifest.credentials) {
        if (spec.hosts?.length && userCredentials[spec.key]) {
          credentialBindings[spec.key] = {
            hosts: spec.hosts,
            header: spec.header,
            format: spec.format,
          };
        }
      }
    }
  }

  return { statuses, userCredentials, credentialBindings };
}

// ============================================================================
// Helpers
// ============================================================================

/** Check whether all required credentials are provided. */
function areCredentialsComplete(
  specs: CredentialSpec[],
  provided: Record<string, string>,
): boolean {
  for (const spec of specs) {
    if (spec.required && !provided[spec.key]?.trim()) {
      return false;
    }
  }
  return true;
}
