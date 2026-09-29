import test from "node:test";
import assert from "node:assert/strict";

import { eraseUserData } from "./erase.js";
import type { CatalogContainer } from "../database/catalog.js";
import type { DatabaseProvider } from "../database/index.js";

type Doc = Record<string, unknown> & { id: string };

/** Containers keyed by id; each doc stored with its partition key value. */
function fakeDb(containers: Record<string, { pkField: string; docs: Doc[] }>) {
  const handle = (id: string) => {
    const c = containers[id]!;
    return {
      async queryWithParams(sql: string, params: Array<{ value: unknown }>, opts?: { partitionKey?: string }) {
        if (sql === "SELECT c.id FROM c") {
          return c.docs.filter((d) => d[c.pkField] === opts?.partitionKey).map((d) => ({ id: d.id }));
        }
        const user = params[0]!.value;
        const field = /c\["([^"]+)"\] AS pk/.exec(sql)![1]!;
        return c.docs.filter((d) => d.userId === user).map((d) => ({ id: d.id, pk: d[field] }));
      },
      async delete(docId: string, pk: string) {
        const i = c.docs.findIndex((d) => d.id === docId && d[c.pkField] === pk);
        if (i < 0) return false;
        c.docs.splice(i, 1);
        return true;
      },
    };
  };
  return {
    name: "fake",
    async initialize() {},
    async getOrCreateContainer(def: { id?: string }) {
      return handle(def.id!);
    },
    getDatabaseId: () => "fake",
  } as unknown as DatabaseProvider;
}

const catalog = [
  { id: "memories", partitionKey: { paths: ["/userId"] } },
  { id: "session-messages-v2", partitionKey: { paths: ["/pk"] } },
  { id: "identity-links", partitionKey: { paths: ["/userId"] } },
  { id: "identity-channel-index", partitionKey: { paths: ["/id"] } },
  { id: "rate-limits", partitionKey: { paths: ["/id"] } },
] as CatalogContainer[];

test("erasure removes the user's documents everywhere and nobody else's", async () => {
  const data = {
    memories: { pkField: "userId", docs: [
      { id: "m1", userId: "alice", text: "likes tea" },
      { id: "m2", userId: "bob", text: "likes coffee" },
    ] },
    "session-messages-v2": { pkField: "pk", docs: [
      { id: "i1:000000", pk: "alice:s1:i1", userId: "alice" },
      { id: "i2:000000", pk: "alice:s2:i2", userId: "alice" },
      { id: "i9:000000", pk: "bob:s1:i9", userId: "bob" },
    ] },
    "identity-links": { pkField: "userId", docs: [{ id: "telegram:1", userId: "alice" }] },
    "identity-channel-index": { pkField: "id", docs: [
      { id: "telegram:1", userId: "alice" },
      { id: "telegram:2", userId: "bob" },
    ] },
    "rate-limits": { pkField: "id", docs: [{ id: "alice:m:1", count: 3 }] }, // no user field: left to expire
  };
  const calls: string[] = [];
  const report = await eraseUserData(fakeDb(data), "alice", {
    catalog,
    sandbox: { deleteUserSandboxes: async (u) => (calls.push(`sandbox:${u}`), 2) },
    exports: { deleteUserFiles: async (u) => (calls.push(`exports:${u}`), 1) },
  });

  assert.deepEqual(report.containers, {
    memories: 1,
    "session-messages-v2": 2,
    "identity-links": 1,
    "identity-channel-index": 1,
  });
  assert.equal(report.sandboxes, 2);
  assert.equal(report.exportedFiles, 1);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(calls, ["sandbox:alice", "exports:alice"]);

  const left = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.docs.map((d) => d.id)]));
  assert.deepEqual(left, {
    memories: ["m2"],
    "session-messages-v2": ["i9:000000"],
    "identity-links": [],
    "identity-channel-index": ["telegram:2"],
    "rate-limits": ["alice:m:1"],
  });
});

test("a failing step is reported and the rest still runs", async () => {
  const report = await eraseUserData(fakeDb({}), "alice", {
    catalog: [{ id: "memories", partitionKey: { paths: ["/userId"] } }] as CatalogContainer[],
    exports: { deleteUserFiles: async () => { throw new Error("storage down"); } },
    sandbox: { deleteUserSandboxes: async () => 1 },
  });
  assert.equal(report.errors.length, 2, "the unknown container and the exports");
  assert.equal(report.sandboxes, 1);
});

test("against the in-memory Cosmos harness, the real queries find and delete the user's documents", async () => {
  const { InMemoryCosmosDatabase } = await import("../database/testing/in-memory-cosmos.js");
  const db = new InMemoryCosmosDatabase();
  const defs = [
    { id: "memories", partitionKey: { paths: ["/userId"] } },
    { id: "cron-due-index", partitionKey: { paths: ["/shardId"] } },
  ] as CatalogContainer[];
  const memories = await db.getOrCreateContainer(defs[0]!);
  const due = await db.getOrCreateContainer(defs[1]!);
  await memories.create({ id: "m1", userId: "alice" });
  await memories.create({ id: "m2", userId: "bob" });
  await due.create({ id: "j1", shardId: "3", userId: "alice" });
  await due.create({ id: "j2", shardId: "5", userId: "bob" });

  const report = await eraseUserData(db, "alice", { catalog: defs, sandbox: {} });
  assert.deepEqual(report.containers, { memories: 1, "cron-due-index": 1 });
  assert.equal(report.skipped.length, 1, "a sandbox backend without per-user deletion is reported, not ignored");
  assert.equal(await memories.read("m2", "bob") !== null, true);
  assert.equal(await due.read("j2", "5") !== null, true);
  assert.equal(await memories.read("m1", "alice"), null);
});
