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
 *   - Provider defaults to "cosmosdb" if not specified; "postgres" takes a
 *     connection string (DATABASE_URL), "memory" nothing
 */

import { isCloudRuntime, loadConfigSection, parseEnvBool, resolveEnvValue } from "../utils/index.js";

/** Connection settings for the database provider. */
export type DatabaseConfig = {
  /** Database endpoint URL (Cosmos DB account endpoint). */
  endpoint: string;
  /**
   * Primary key or resource token. Empty: authenticate with Entra ID instead
   * (the managed identity in Azure, `az login` locally), which needs the
   * Cosmos DB Built-in Data Contributor role.
   */
  key: string;
  /** User-assigned identity client id for Entra auth (default: system-assigned). */
  identityClientId?: string;
  /** Database name. Default: "agentforeach". */
  databaseId?: string;
  /**
   * Create the database and collections on first use (local development).
   * When false the runtime only references them: they come from the IaC
   * (Cosmos) or a migration (Postgres), and cold starts create nothing.
   * Default: true locally, false on Azure (DATABASE_PROVISION, or its older
   * name COSMOS_PROVISION_CONTAINERS, overrides).
   */
  provisionContainers?: boolean;
  /** Postgres: connection string, e.g. postgres://user:pass@host:5432/db?sslmode=require. */
  connectionString?: string;
  /** Postgres: schema holding the tables. Default "public". */
  schema?: string;
  /** Postgres: most connections per instance. Default 10. */
  poolSize?: number;
  /**
   * Postgres: send statement/idle timeouts as startup parameters. Default
   * true; false behind a pooler that refuses them (PgBouncer).
   */
  serverTimeouts?: boolean;
};

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
 * // or
 * { "database": { "provider": "postgres", "connectionString": "$DATABASE_URL" } }
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
  /** Postgres connection string or env-var reference (e.g. "$DATABASE_URL"). */
  connectionString?: string;
  /** Postgres schema — default "public". */
  schema?: string;
  /** Postgres pool size per instance (or an env-var reference) — default 10. */
  poolSize?: number | string;
  /** Postgres: false behind a pooler that refuses startup parameters — default true. */
  serverTimeouts?: boolean;
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
 *   1. Env vars: DATABASE_PROVIDER; COSMOS_ENDPOINT, COSMOS_KEY,
 *      COSMOS_DATABASE; DATABASE_URL, DATABASE_SCHEMA, DATABASE_POOL_SIZE,
 *      DATABASE_SERVER_TIMEOUTS;
 *      DATABASE_PROVISION (or COSMOS_PROVISION_CONTAINERS)
 *   2. agentforeach.json "database" section (with $ENV interpolation)
 *   3. Defaults
 *
 * @returns Fully-resolved `ResolvedDatabaseConfig`.
 */
let connectionStringSource: (() => string | undefined) | undefined;

/**
 * For a host whose database URL comes from a binding, not the environment
 * (Cloudflare's Hyperdrive). It's asked each time the config loads, which is
 * always inside a handler: workerd treats reading Hyperdrive's connection
 * string as I/O, which global scope doesn't allow. DATABASE_URL still wins
 * when it's set. `undefined` removes the source.
 */
export function installDatabaseUrlSource(source: (() => string | undefined) | undefined): void {
  connectionStringSource = source;
}

export function loadDatabaseConfig(): ResolvedDatabaseConfig {
  const json = loadConfigSection<DatabaseJsonConfig>("database");

  // `||`: an empty value (as local.settings.json leaves unset ones) means unset.
  const provider = process.env.DATABASE_PROVIDER || json?.provider || DEFAULT_PROVIDER;

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

  const connectionString =
    process.env.DATABASE_URL ||
    connectionStringSource?.() ||
    (json?.connectionString ? resolveEnvValue(json.connectionString) : undefined);

  const schema = process.env.DATABASE_SCHEMA || (json?.schema ? resolveEnvValue(json.schema) : undefined);

  const jsonPoolSize = typeof json?.poolSize === "string" ? resolveEnvValue(json.poolSize) : json?.poolSize;
  const poolSizeRaw = process.env.DATABASE_POOL_SIZE || jsonPoolSize;
  const poolSize = poolSizeRaw === undefined || poolSizeRaw === "" ? undefined : Number(poolSizeRaw);
  // Checked only where it is used, so a stray value never stops a Cosmos deployment.
  if (provider === "postgres" && poolSize !== undefined && !(Number.isInteger(poolSize) && poolSize > 0)) {
    throw new Error(`database: poolSize must be a positive integer, got ${String(poolSizeRaw)}`);
  }

  return {
    provider,
    endpoint,
    key,
    databaseId,
    provisionContainers: parseEnvBool(
      "DATABASE_PROVISION",
      parseEnvBool("COSMOS_PROVISION_CONTAINERS", !isCloudRuntime()),
    ),
    identityClientId: process.env.COSMOS_IDENTITY_CLIENT_ID || undefined,
    connectionString: connectionString || undefined,
    schema: schema || undefined,
    poolSize,
    serverTimeouts: parseEnvBool("DATABASE_SERVER_TIMEOUTS", json?.serverTimeouts ?? true),
  };
}
