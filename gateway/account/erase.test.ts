import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage, type CollectionSpec, type StorageAdapter } from "@agentforeach/storage";
import { eraseUserData } from "./erase.js";

/** A sandbox backend whose sandboxes keep their disk (ACA Sandboxes), so erasure deletes them. */
const KEEPS_DISK = { browser: true, egressCredentials: true, persistence: "disk" as const };

type Doc = Record<string, unknown> & { id: string };

const catalog: CollectionSpec[] = [
  { name: "memories", partitionKey: "userId" },
  { name: "session-messages-v2", partitionKey: "pk" },
  { name: "identity-links", partitionKey: "userId" },
  { name: "identity-channel-index", partitionKey: "id" },
  { name: "cron-due-index", partitionKey: "shardId" },
  { name: "rate-limits", partitionKey: "id" },
];

/** In-memory storage holding `data` (collection name -> documents). */
async function seeded(data: Record<string, Doc[]>): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  for (const spec of catalog) {
    const collection = await storage.collection(spec);
    for (const doc of data[spec.name] ?? []) await collection.create(doc);
  }
  return storage;
}

test("erasure removes the user's documents everywhere and nobody else's", async () => {
  const storage = await seeded({
    memories: [
      { id: "m1", userId: "alice", text: "likes tea" },
      { id: "m2", userId: "bob", text: "likes coffee" },
    ],
    "session-messages-v2": [
      { id: "i1:000000", pk: "alice:s1:i1", userId: "alice" },
      { id: "i2:000000", pk: "alice:s2:i2", userId: "alice" },
      { id: "i9:000000", pk: "bob:s1:i9", userId: "bob" },
    ],
    "identity-links": [{ id: "telegram:1", userId: "alice" }],
    "identity-channel-index": [
      { id: "telegram:1", userId: "alice" },
      { id: "telegram:2", userId: "bob" },
    ],
    "cron-due-index": [
      { id: "j1", shardId: "3", userId: "alice" },
      { id: "j2", shardId: "5", userId: "bob" },
    ],
    "rate-limits": [{ id: "alice:m:1", count: 3 }], // no user field: left to expire
  });
  const calls: string[] = [];
  const report = await eraseUserData(storage, "alice", {
    catalog,
    sandbox: { capabilities: KEEPS_DISK, deleteUserSandboxes: async (u) => (calls.push(`sandbox:${u}`), 2) },
    exports: { deleteUserFiles: async (u) => (calls.push(`exports:${u}`), 1) },
  });

  assert.deepEqual(report.containers, {
    memories: 1,
    "session-messages-v2": 2,
    "identity-links": 1,
    "identity-channel-index": 1,
    "cron-due-index": 1,
  });
  assert.equal(report.sandboxes, 2);
  assert.equal(report.exportedFiles, 1);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(calls, ["sandbox:alice", "exports:alice"]);

  const left = Object.fromEntries(
    catalog.map((spec) => [spec.name, storage.getCollection(spec.name).all().map((d) => d.id).sort()]),
  );
  assert.deepEqual(left, {
    memories: ["m2"],
    "session-messages-v2": ["i9:000000"],
    "identity-links": [],
    "identity-channel-index": ["telegram:2"],
    "cron-due-index": ["j2"],
    "rate-limits": ["alice:m:1"],
  });
});

test("a failing step is reported and the rest still runs", async () => {
  const broken: StorageAdapter = {
    name: "broken",
    capabilities: { vectorSearch: false, hybridSearch: false },
    async initialize() {},
    async collection() {
      throw new Error("storage down");
    },
  };
  const report = await eraseUserData(broken, "alice", {
    catalog: [{ name: "memories", partitionKey: "userId" }],
    exports: { deleteUserFiles: async () => { throw new Error("storage down"); } },
    sandbox: { capabilities: KEEPS_DISK, deleteUserSandboxes: async () => 1 },
  });
  assert.equal(report.errors.length, 2, "the collection and the exports");
  assert.equal(report.sandboxes, 1);
});

test("a sandbox backend that keeps nothing is reported as skipped, not asked to delete", async () => {
  let asked = false;
  const ephemeral = {
    capabilities: { browser: false, egressCredentials: false, persistence: "none" as const },
    deleteUserSandboxes: async () => ((asked = true), 0),
  };
  const report = await eraseUserData(await seeded({}), "alice", { catalog, sandbox: ephemeral });
  assert.equal(report.skipped.length, 1);
  assert.equal(asked, false);
});

test("what the sandbox backend leaves behind goes in the report", async () => {
  const report = await eraseUserData(await seeded({}), "alice", {
    catalog,
    sandbox: { capabilities: KEEPS_DISK, deleteUserSandboxes: async () => 1, erasureNotes: ["snapshots stay until they expire"] },
  });
  assert.equal(report.sandboxes, 1);
  assert.deepEqual(report.skipped, ["sandboxes: snapshots stay until they expire"]);
});
