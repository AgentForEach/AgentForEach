import test from "node:test";
import assert from "node:assert/strict";
import { createMigrateHandler, withCredentials, type SqlClient } from "./migrate.js";

const URL_ = "postgresql://afe_app:app%2Fsecret@db.example:5432/agentforeach?sslmode=verify-full&sslrootcert=/var/runtime/ca-cert.pem";

function fakeDatabase(options: { roleExists?: boolean; failOn?: RegExp } = {}) {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const connected: string[] = [];
  let ended = false;
  const client: SqlClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (options.failOn?.test(sql)) throw Object.assign(new Error("permission denied to create extension \"vector\""), { code: "42501" });
      if (sql.startsWith("SELECT 1 FROM pg_roles")) return { rows: options.roleExists ? [{ "?column?": 1 }] : [] };
      // Stand in for format(): enough to see which statement the server would build.
      if (sql.startsWith("SELECT format(")) return { rows: [{ statement: `${params![0]} [${(params as string[]).slice(1).join(", ")}]` }] };
      if (sql.startsWith("SELECT extversion")) return { rows: [{ extversion: "0.8.2" }] };
      return { rows: [] };
    },
    async end() {
      ended = true;
    },
  };
  return {
    queries,
    connected,
    get ended() {
      return ended;
    },
    deps: (env: Record<string, string | undefined>) => ({
      env,
      readSchema: async () => "CREATE EXTENSION IF NOT EXISTS vector;",
      connect: async (url: string) => {
        connected.push(url);
        return client;
      },
    }),
  };
}

test("migrate applies the schema in one transaction with the runtime's URL when no owner role is set", async () => {
  const db = fakeDatabase();
  const result = await createMigrateHandler(db.deps({ DATABASE_URL: URL_ }))();
  assert.deepEqual(result, { ok: true, schemaApplied: true, pgvector: "0.8.2" });
  assert.deepEqual(db.connected, [URL_]);
  assert.deepEqual(
    db.queries.map((q) => q.sql),
    ["BEGIN", "CREATE EXTENSION IF NOT EXISTS vector;", "SELECT extversion FROM pg_extension WHERE extname = 'vector'", "COMMIT"],
  );
  assert.equal(db.ended, true);
});

test("with an owner role, migrate connects as it and creates the runtime's role with read and write on the tables only", async () => {
  const db = fakeDatabase();
  const result = await createMigrateHandler(
    db.deps({ DATABASE_URL: URL_, DATABASE_MIGRATION_USER: "afe_migration", DATABASE_MIGRATION_PASSWORD: "owner@pass" }),
  )();
  assert.equal(result.applicationRole, "afe_app");
  const connected = new URL(db.connected[0]);
  assert.equal(decodeURIComponent(connected.username), "afe_migration");
  assert.equal(decodeURIComponent(connected.password), "owner@pass");
  assert.equal(connected.searchParams.get("sslmode"), "verify-full", "TLS settings are kept");
  const built = db.queries.filter((q) => q.sql.startsWith("SELECT format(")).map((q) => q.params![0]);
  assert.deepEqual(built, [
    "CREATE ROLE %I LOGIN PASSWORD %L",
    "GRANT CONNECT ON DATABASE %I TO %I",
    "GRANT USAGE ON SCHEMA public TO %I",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I",
    "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I",
  ]);
  // The password reaches the server only as a parameter of format(), never spliced into SQL here.
  const create = db.queries.find((q) => q.params?.[0] === "CREATE ROLE %I LOGIN PASSWORD %L")!;
  assert.deepEqual(create.params, ["CREATE ROLE %I LOGIN PASSWORD %L", "afe_app", "app/secret"]);
  assert.ok(!create.sql.includes("app/secret"), "the password stays parameterized");
});

test("an existing runtime role gets its password from the secret again (a rotation)", async () => {
  const db = fakeDatabase({ roleExists: true });
  await createMigrateHandler(db.deps({ DATABASE_URL: URL_, DATABASE_MIGRATION_USER: "afe_migration", DATABASE_MIGRATION_PASSWORD: "x" }))();
  assert.ok(db.queries.some((q) => q.params?.[0] === "ALTER ROLE %I LOGIN PASSWORD %L"));
});

test("a failure rolls back, closes the connection and says why", async () => {
  const db = fakeDatabase({ failOn: /^CREATE EXTENSION/ });
  await assert.rejects(createMigrateHandler(db.deps({ DATABASE_URL: URL_ }))(), /applying the schema failed \(42501\): permission denied/);
  assert.ok(db.queries.some((q) => q.sql === "ROLLBACK"));
  assert.ok(!db.queries.some((q) => q.sql === "COMMIT"));
  assert.equal(db.ended, true);
});

test("migrate refuses incomplete settings before connecting", async () => {
  const db = fakeDatabase();
  await assert.rejects(createMigrateHandler(db.deps({}))(), /DATABASE_URL is not set/);
  await assert.rejects(createMigrateHandler(db.deps({ DATABASE_URL: URL_, DATABASE_MIGRATION_USER: "owner" }))(), /both/);
  await assert.rejects(createMigrateHandler(db.deps({ DATABASE_URL: URL_, DATABASE_SCHEMA: "tenant" }))(), /schema "public"/);
  assert.deepEqual(db.connected, []);
});

test("withCredentials swaps only the user and password", () => {
  const next = new URL(withCredentials(URL_, "owner", "p@ss/word"));
  assert.equal(decodeURIComponent(next.password), "p@ss/word");
  assert.equal(next.host, "db.example:5432");
  assert.equal(next.pathname, "/agentforeach");
});
