/**
 * Catalog parity: every container in infra/cosmos-containers.json (what
 * Pulumi deploys today) must come out of `toContainerDefinition` unchanged
 * from the provider-neutral spec its store will declare. The specs below are
 * those declarations; the comparison applies infra's own normalization
 * (`partitionKey: { kind: "Hash", version: 2, ...pk }`), so "unchanged" means
 * the same ARM resource.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CollectionSpec } from "@agentforeach/storage";
import { toContainerDefinition } from "./definition.js";

type CatalogContainer = { id: string; partitionKey: Record<string, unknown> } & Record<string, unknown>;

const catalog = JSON.parse(
  readFileSync(new URL("../../../infra/cosmos-containers.json", import.meta.url), "utf8"),
) as CatalogContainer[];

/** infra/cosmos.ts sqlContainerResource(): Hash v2 unless stated. */
function asDeployed(c: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...c, partitionKey: { kind: "Hash", version: 2, ...(c.partitionKey as object) } };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

const vector1536 = { field: "vector", dimensions: 1536, distance: "cosine" } as const;
/** Containers deployed without an indexing policy keep the account default. */
const defaultPolicy = { cosmosdb: { indexingPolicy: null } };
const scalarExcluded = (path: string) => ({
  cosmosdb: {
    indexingPolicy: {
      automatic: true,
      indexingMode: "consistent",
      includedPaths: [{ path: "/*" }],
      excludedPaths: [{ path }, { path: '/"_etag"/?' }],
    },
  },
});

const specs: CollectionSpec[] = [
  { name: "abort-requests", partitionKey: "userId", defaultTtl: 600, adapterOptions: defaultPolicy },
  { name: "cron-due-index", partitionKey: "shardId", defaultTtl: 604800 },
  { name: "cron-heartbeat-events", partitionKey: "shardId", defaultTtl: 172800 },
  { name: "cron-jobs", partitionKey: "userId" },
  { name: "cron-runs", partitionKey: "jobId", defaultTtl: 86400 },
  {
    name: "episodes",
    partitionKey: "userId",
    vector: vector1536,
    fullText: { fields: ["summary"], language: "en-US" },
    unindexed: ["summary", "highlights"],
  },
  { name: "hitl-requests", partitionKey: "userId", defaultTtl: 3600 },
  { name: "identity-channel-index", partitionKey: "id", adapterOptions: defaultPolicy },
  { name: "identity-links", partitionKey: "userId" },
  { name: "identity-pairing", partitionKey: "code", defaultTtl: 300, adapterOptions: defaultPolicy },
  { name: "memories", partitionKey: "userId", vector: vector1536, fullText: { fields: ["text"], language: "en-US" } },
  { name: "onboarding-state", partitionKey: "userId" },
  { name: "prompt-documents", partitionKey: "userId" },
  { name: "rate-limits", partitionKey: "id", defaultTtl: -1, adapterOptions: defaultPolicy },
  { name: "session-digests", partitionKey: "userId", defaultTtl: -1 },
  { name: "session-messages-v2", partitionKey: "pk", defaultTtl: -1, adapterOptions: scalarExcluded("/content/?") },
  { name: "sessions", partitionKey: "userId", defaultTtl: 86400, adapterOptions: scalarExcluded("/compactionSummary/?") },
  { name: "usage-records", partitionKey: "userId", defaultTtl: 7776000 },
  { name: "user-skills", partitionKey: "userId", unindexed: ["credentials"] },
  { name: "whatsapp-state", partitionKey: "scope", defaultTtl: -1, adapterOptions: defaultPolicy },
];

test("the catalog lists the containers these specs cover", () => {
  assert.deepEqual(catalog.map((c) => c.id).sort(), specs.map((s) => s.name).sort());
});

for (const spec of specs) {
  test(`${spec.name}: the same container as deployed today`, () => {
    const deployed = catalog.find((c) => c.id === spec.name)!;
    // The definition is sent as is to createIfNotExists (local provisioning),
    // so it must already carry what infra adds (Hash v2): no normalization here.
    assert.deepEqual(toContainerDefinition(spec), asDeployed(deployed));
  });
}

test("small vector collections get an exact flat index; the type can be chosen", () => {
  const small = toContainerDefinition({ name: "x", partitionKey: "pk", vector: { field: "v", dimensions: 3, distance: "cosine" } });
  assert.deepEqual((small.indexingPolicy as { vectorIndexes: unknown }).vectorIndexes, [{ path: "/v", type: "flat" }]);
  const chosen = toContainerDefinition({
    name: "x",
    partitionKey: "pk",
    vector: { field: "v", dimensions: 3, distance: "cosine" },
    adapterOptions: { cosmosdb: { vectorIndexType: "quantizedFlat" } },
  });
  assert.deepEqual((chosen.indexingPolicy as { vectorIndexes: unknown }).vectorIndexes, [{ path: "/v", type: "quantizedFlat" }]);
});

test("nested partition keys and fields become JSON paths", () => {
  const def = toContainerDefinition({ name: "x", partitionKey: "tenant.id", unindexed: ["a.b"] });
  assert.deepEqual(def.partitionKey.paths, ["/tenant/id"]);
  assert.deepEqual((def.indexingPolicy as { excludedPaths: unknown }).excludedPaths, [{ path: "/a/b/*" }, { path: '/"_etag"/?' }]);
});

test("text-embedding-3-large memories (3072 dimensions) get a diskANN index", () => {
  const def = toContainerDefinition({
    name: "memories",
    partitionKey: "userId",
    vector: { field: "vector", dimensions: 3072, distance: "cosine" },
    fullText: { fields: ["text"], language: "en-US" },
  });
  assert.deepEqual((def.indexingPolicy as { vectorIndexes: unknown }).vectorIndexes, [{ path: "/vector", type: "diskANN" }]);
  assert.equal(def.vectorEmbeddingPolicy?.vectorEmbeddings[0].dimensions, 3072);
});

test("a vector field also listed as unindexed is excluded once", () => {
  const def = toContainerDefinition({
    name: "x",
    partitionKey: "pk",
    vector: { field: "emb", dimensions: 3, distance: "cosine" },
    unindexed: ["emb", "notes"],
  });
  assert.deepEqual((def.indexingPolicy as { excludedPaths: unknown }).excludedPaths, [
    { path: "/emb/*" },
    { path: "/notes/*" },
    { path: '/"_etag"/?' },
  ]);
});
