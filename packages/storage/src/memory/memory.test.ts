import test from "node:test";
import assert from "node:assert/strict";

import { runStorageConformance } from "../conformance/index.js";
import { isConflict } from "../errors.js";
import { InMemoryStorage } from "./adapter.js";

// The in-memory adapter must pass the same suite as every other adapter,
// on a fake clock so the TTL tests run instantly.
let now = Date.parse("2026-01-01T00:00:00Z");
runStorageConformance({
  name: "memory",
  createAdapter: () => new InMemoryStorage({ now: () => now }),
  advanceTime: async (ms) => {
    now += ms;
  },
});

type Doc = { id: string; pk: string; [key: string]: unknown };
const spec = { name: "docs", partitionKey: "pk" };

test("collections are shared by name and the first definition wins", async () => {
  const storage = new InMemoryStorage();
  const first = await storage.collection<Doc>(spec);
  const second = await storage.collection<Doc>({ ...spec, defaultTtl: 5 });
  assert.equal(first, second);
  assert.equal(first.spec.defaultTtl, undefined);
  assert.equal(storage.getCollection("docs"), first);
  assert.throws(() => storage.getCollection("other"), /no collection "other"/);
});

test("invalid collection definitions are rejected", async () => {
  const storage = new InMemoryStorage();
  await assert.rejects(storage.collection({ name: "bad name", partitionKey: "pk" }), { code: "BadRequest" });
  await assert.rejects(storage.collection({ name: "x", partitionKey: "a b" }), { code: "BadRequest" });
  await assert.rejects(storage.collection({ name: "x", partitionKey: "pk", defaultTtl: 0 }), { code: "BadRequest" });
  await assert.rejects(
    storage.collection({ name: "x", partitionKey: "pk", vector: { field: "v", dimensions: 0, distance: "cosine" } }),
    { code: "BadRequest" },
  );
});

test("hooks see every operation and can inject faults or concurrent writers", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<Doc>(spec);
  const seen: string[] = [];
  const remove = docs.beforeOperation((ctx) => {
    seen.push(`${ctx.collection}:${ctx.op}:${ctx.id ?? "-"}`);
  });
  await docs.create({ id: "a", pk: "p" });
  await docs.read("a", "p");
  await docs.find({ partitionKey: "p" });
  remove();
  await docs.read("a", "p");
  assert.deepEqual(seen, ["docs:create:a", "docs:read:a", "docs:find:-"]);

  // A writer slipping in between this create's call and its effect wins.
  const removeRacer = docs.beforeOperation(async (ctx) => {
    if (ctx.op === "create" && ctx.id === "b") {
      removeRacer();
      await docs.create({ id: "b", pk: "p", by: "racer" });
    }
  });
  await assert.rejects(docs.create({ id: "b", pk: "p", by: "me" }), isConflict);
  assert.equal(docs.peek("b", "p")?.by, "racer");

  docs.beforeOperation(() => {
    throw new Error("injected");
  });
  await assert.rejects(docs.read("a", "p"), /injected/);
});

test("peek, all and clear inspect without hooks and hide expired documents", async () => {
  let clock = 0;
  const storage = new InMemoryStorage({ now: () => clock });
  const docs = await storage.collection<Doc>({ ...spec, defaultTtl: 10 });
  await docs.create({ id: "a", pk: "p1" });
  await docs.create({ id: "b", pk: "p2", ttl: -1 });
  assert.equal(docs.peek("a", "p1")?.id, "a");
  assert.equal(typeof docs.peek("a", "p1")?._etag, "string");
  assert.deepEqual(docs.all().map((d) => d.id).sort(), ["a", "b"]);
  clock += 10_000;
  assert.equal(docs.peek("a", "p1"), undefined);
  assert.deepEqual(docs.all().map((d) => d.id), ["b"]);
  docs.clear();
  assert.deepEqual(docs.all(), []);
});

test("returned documents are copies: mutating them does not touch storage", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<Doc>(spec);
  const input = { id: "a", pk: "p", list: [1] };
  const created = await docs.create(input);
  input.list.push(2);
  (created.list as number[]).push(3);
  const read = await docs.read("a", "p");
  (read!.list as number[]).push(4);
  assert.deepEqual(docs.peek("a", "p")?.list, [1]);
});

test("vector search puts documents without a usable vector last, unscored; no policy is BadRequest", async () => {
  const storage = new InMemoryStorage();
  const vectors = await storage.collection<Doc>({
    name: "vectors",
    partitionKey: "pk",
    vector: { field: "embedding", dimensions: 2, distance: "cosine" },
  });
  await vectors.create({ id: "ok", pk: "p", embedding: [1, 0] });
  await vectors.create({ id: "none", pk: "p" });
  await vectors.create({ id: "short", pk: "p", embedding: [1] });
  const results = await vectors.vectorSearch({ partitionKey: "p", vector: [1, 0], limit: 10 });
  assert.deepEqual(results.map((r) => [r.document.id, r.score]), [["ok", 1], ["none", null], ["short", null]]);
  assert.deepEqual((await vectors.vectorSearch({ partitionKey: "p", vector: [1, 0], limit: 1 })).map((r) => r.document.id), ["ok"]);

  const plain = await storage.collection<Doc>(spec);
  await assert.rejects(plain.vectorSearch({ vector: [1, 0], limit: 1 }), { code: "BadRequest" });
  await assert.rejects(
    plain.hybridSearch({ rank: [{ kind: "fullText", field: "text", terms: ["x"] }], limit: 1 }),
    { code: "BadRequest" },
  );
});
