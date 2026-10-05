import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { iacCatalogPath, postgresSchemaPath, recordContainerCatalog, recordPostgresSchema } from "./catalog.js";

const IAC_CATALOG = iacCatalogPath();

test("the IaC provisions exactly the containers the runtime defines", async () => {
  const runtime = await recordContainerCatalog();
  const iac = JSON.parse(readFileSync(IAC_CATALOG, "utf8"));
  assert.deepEqual(
    iac,
    runtime,
    "infra/cosmos-containers.json is out of date: run `npm run db:catalog --workspace @agentforeach/gateway`",
  );
});

test("the PostgreSQL migration creates exactly the tables the runtime defines", async () => {
  assert.equal(
    readFileSync(postgresSchemaPath(), "utf8"),
    await recordPostgresSchema(),
    "infra/postgres-schema.sql is out of date: run `npm run db:catalog --workspace @agentforeach/gateway`",
  );
});

test("every runtime container has a partition key", async () => {
  for (const c of await recordContainerCatalog()) {
    assert.ok(c.partitionKey && (c.partitionKey as { paths: string[] }).paths.length === 1, c.id);
  }
});

test("sweepExpiredRows: storage that sweeps itself is left alone; one that can't is handed the whole catalog", async () => {
  const { sweepExpiredRows: sweep, recordCollectionSpecs: specs } = await import("./catalog.js");
  const { InMemoryStorage } = await import("@agentforeach/storage");
  assert.equal(await sweep(new InMemoryStorage()), null, "no sweepAll: nothing to do");
  let given: string[] = [];
  const sweeping = Object.assign(new InMemoryStorage(), {
    sweepAll: async (s: readonly { name: string }[]) => ((given = s.map((x) => x.name)), 7),
  });
  assert.equal(await sweep(sweeping), 7);
  assert.deepEqual(given, (await specs()).map((s) => s.name), "every collection in the catalog");
});

test("collections not partitioned by user index userId, which account erasure finds documents by", async () => {
  const { recordCollectionSpecs: specs } = await import("./catalog.js");
  // Their documents carry no userId: keyed counters and per-scope channel state that expire by TTL,
  // synthetic AWS durable conformance records, and the aws-agentcore sandbox's records, keyed by an owner hash and erased by the backend itself.
  const withoutUserId = new Set(["rate-limits", "whatsapp-state", "aws-durable-conformance", "aws-sandbox-sessions", "aws-sandbox-workspaces"]);
  const missing = (await specs())
    .filter((s) => s.partitionKey !== "userId" && !withoutUserId.has(s.name))
    .filter((s) => !(s.indexes ?? []).includes("userId"))
    .map((s) => `${s.name} (partitioned by ${s.partitionKey})`);
  assert.deepEqual(missing, [], "on Postgres, erasing a user would scan these whole tables");
});
