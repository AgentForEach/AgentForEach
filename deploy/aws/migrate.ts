/**
 * The `migrate` handler (deploy/aws/lambda.ts exports it): applies the
 * PostgreSQL schema, infra/postgres-schema.sql, which deploy/aws/package.sh
 * puts in the package. deploy.sh invokes it once per release, from inside the
 * VPC, since the database is private; it has no route and no trigger.
 *
 * The schema is idempotent (IF NOT EXISTS throughout), so running it again is
 * how an upgrade adds what a release needs. The runtime never runs DDL
 * (DATABASE_PROVISION=false).
 *
 * With an owner role (DATABASE_MIGRATION_USER and _PASSWORD, from the
 * stack's migrationSecretArn), it connects as that role to DATABASE_URL's
 * database, and then makes sure the runtime's role (DATABASE_URL's user)
 * exists with DATABASE_URL's password and may read and write the tables, and
 * nothing more. Without one, it connects with DATABASE_URL, whose role must
 * then own the schema.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface MigrateDeps {
  connect(url: string): Promise<SqlClient>;
  readSchema(): Promise<string>;
  env?: Record<string, string | undefined>;
}

export interface MigrateResult {
  ok: true;
  schemaApplied: true;
  /** The vector extension's version. */
  pgvector?: string;
  /** The runtime's role, when the migration manages it. */
  applicationRole?: string;
}

export function createMigrateHandler(deps: MigrateDeps = defaultDeps()) {
  return async (): Promise<MigrateResult> => {
    const env = deps.env ?? process.env;
    const url = env.DATABASE_URL;
    if (!url) throw new Error("migrate: DATABASE_URL is not set");
    const schema = env.DATABASE_SCHEMA?.trim();
    if (schema && schema !== "public") {
      throw new Error(`migrate: infra/postgres-schema.sql is for schema "public", not "${schema}"`);
    }
    const ownerUser = env.DATABASE_MIGRATION_USER;
    const ownerPassword = env.DATABASE_MIGRATION_PASSWORD;
    if (!ownerUser !== !ownerPassword) throw new Error("migrate: set both DATABASE_MIGRATION_USER and DATABASE_MIGRATION_PASSWORD, or neither");

    const target = new URL(url);
    const appUser = decodeURIComponent(target.username);
    const appPassword = decodeURIComponent(target.password);
    const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
    const manageRole = !!ownerUser && appUser !== ownerUser;
    if (manageRole && (!appUser || !appPassword || !database)) {
      throw new Error("migrate: DATABASE_URL needs a user, a password and a database for the migration to manage its role");
    }

    const sql = await deps.readSchema();
    const client = await deps.connect(ownerUser ? withCredentials(url, ownerUser, ownerPassword!) : url);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      if (manageRole) {
        // Built by the server (format %I / %L), so neither name nor password is spliced in here.
        const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [appUser]);
        const verb = rows.length ? "ALTER" : "CREATE";
        await execFormatted(client, `${verb} ROLE %I LOGIN PASSWORD %L`, [appUser, appPassword]);
        await execFormatted(client, "GRANT CONNECT ON DATABASE %I TO %I", [database, appUser]);
        await execFormatted(client, "GRANT USAGE ON SCHEMA public TO %I", [appUser]);
        await execFormatted(client, "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I", [appUser]);
        await execFormatted(client, "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I", [appUser]);
      }
      const { rows } = await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
      await client.query("COMMIT");
      return {
        ok: true,
        schemaApplied: true,
        pgvector: rows[0]?.extversion as string | undefined,
        ...(manageRole ? { applicationRole: appUser } : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const { code, message } = error as { code?: string; message?: string };
      throw new Error(`migrate: applying the schema failed${code ? ` (${code})` : ""}: ${message ?? String(error)}`);
    } finally {
      await client.end().catch(() => {});
    }
  };
}

/** Runs a statement the server builds with format(), so identifiers and literals are quoted by PostgreSQL. */
async function execFormatted(client: SqlClient, template: string, args: string[]) {
  const placeholders = args.map((_, i) => `$${i + 2}::text`).join(", ");
  const { rows } = await client.query(`SELECT format($1, ${placeholders}) AS statement`, [template, ...args]);
  await client.query(String(rows[0].statement));
}

/** DATABASE_URL with another role's credentials (TLS settings and the rest unchanged). */
export function withCredentials(url: string, user: string, password: string): string {
  const next = new URL(url);
  next.username = encodeURIComponent(user);
  next.password = encodeURIComponent(password);
  return next.toString();
}

function defaultDeps(): MigrateDeps {
  return {
    async connect(url) {
      // pg comes with the PostgreSQL adapter, bundled into the entry; loaded when the handler runs.
      const pg = (await import("pg")).default;
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
      await client.connect();
      return client as unknown as SqlClient;
    },
    // package.sh puts the schema in the package, next to dist/.
    readSchema: () => readFile(join(process.env.LAMBDA_TASK_ROOT ?? process.cwd(), "infra/postgres-schema.sql"), "utf8"),
  };
}
