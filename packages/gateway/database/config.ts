/**
 * AgentForEach Database Layer — Configuration
 *
 * Loads database configuration from agentforeach.json ("database" section).
 * Follows the same modular config pattern as auth/, llms/, websocket/,
 * and memory/.
 *
 * Key integration points:
 *   - Uses shared `loadConfigSection()` from utils/config
 *   - Env vars still work as overrides — config is the base, env vars win
 *   - Provider defaults to "cosmosdb" if not specified
 */

import { isCloudRuntime, loadConfigSection, parseEnvBool, resolveEnvValue } from "../utils/index.js";
import type { DatabaseConfig } from "./types.js";

// ============================================================================
// JSON config shape (matches agentforeach.json "database" section)
// ============================================================================

/**
 * Shape of the "database" section in agentforeach.json.
 *
 * ```jsonc
 * {
 *   "database": {
 *     "provider": "cosmosdb",
 *     "endpoint": "$COSMOS_ENDPOINT",
 *     "key": "$COSMOS_KEY",
 *     "databaseId": "agentforeach"
 *   }
 * }
 * ```
 */
export type DatabaseJsonConfig = {
  /** Provider name — default "cosmosdb". */
  provider?: string;
  /** Endpoint URL or env-var reference (e.g. "$COSMOS_ENDPOINT"). */
  endpoint?: string;
  /** Primary key / resource token or env-var reference. */
  key?: string;
  /** Database name — default "agentforeach". */
  databaseId?: string;
};

// ============================================================================
// Resolved config
// ============================================================================

/**
 * Fully-resolved database configuration ready for use.
 */
export type ResolvedDatabaseConfig = DatabaseConfig & {
  /** Which provider to use (default: "cosmosdb"). */
  provider: string;
};

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_PROVIDER = "cosmosdb";
const DEFAULT_DATABASE_ID = "agentforeach";

// ============================================================================
// Loader
// ============================================================================

/**
 * Load and resolve the database configuration.
 *
 * Resolution order (highest priority wins):
 *   1. Env vars: COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE
 *   2. agentforeach.json "database" section (with $ENV interpolation)
 *   3. Defaults
 *
 * @returns Fully-resolved `ResolvedDatabaseConfig`.
 */
export function loadDatabaseConfig(): ResolvedDatabaseConfig {
  const json = loadConfigSection<DatabaseJsonConfig>("database");

  const provider =
    process.env.DATABASE_PROVIDER ?? json?.provider ?? DEFAULT_PROVIDER;

  const endpoint =
    process.env.COSMOS_ENDPOINT ??
    (json?.endpoint ? resolveEnvValue(json.endpoint) : undefined) ??
    "";

  const key =
    process.env.COSMOS_KEY ??
    (json?.key ? resolveEnvValue(json.key) : undefined) ??
    "";

  const databaseId =
    process.env.COSMOS_DATABASE ?? 
    (json?.databaseId ? resolveEnvValue(json.databaseId) : undefined) ??
    DEFAULT_DATABASE_ID;

  return {
    provider,
    endpoint,
    key,
    databaseId,
    provisionContainers: parseEnvBool("COSMOS_PROVISION_CONTAINERS", !isCloudRuntime()),
    identityClientId: process.env.COSMOS_IDENTITY_CLIENT_ID || undefined,
  };
}
