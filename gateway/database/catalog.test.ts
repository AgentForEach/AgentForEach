import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { iacCatalogPath, recordContainerCatalog } from "./catalog.js";

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

test("every runtime container has a partition key", async () => {
  for (const c of await recordContainerCatalog()) {
    assert.ok(c.partitionKey && (c.partitionKey as { paths: string[] }).paths.length === 1, c.id);
  }
});
