import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage, type OperationContext } from "@agentforeach/storage";
import { StorageMemoryStore } from "./providers/storage.js";
import { resolveStoreProvider } from "./providers/index.js";
import { loadMemoryConfig, type MemoryConfig } from "./config.js";

const config: MemoryConfig = {
  ...loadMemoryConfig(),
  containerId: "memories",
  embeddingModel: "text-embedding-3-small", // 1536 dimensions
  maxFulltextTerms: 5,
};

/** A 1536-dimension unit vector whose cosine with `along(1)` is `cos`. */
function along(cos: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(1 - cos * cos);
  return v;
}

async function setup(storage = new InMemoryStorage()) {
  const store = new StorageMemoryStore(config, storage);
  await store.initialize();
  return { storage, store, memories: storage.getCollection("memories") };
}

test("store is idempotent for the same text, sequentially and concurrently", async () => {
  const { store, memories } = await setup();
  const first = await store.store("I drink green tea", along(0.5), "u1", "preference", 0.8);
  const again = await store.store("I drink green tea", along(0.5), "u1", "preference", 0.8);
  const [a, b] = await Promise.all([
    store.store("Lives in Pune", along(0.4), "u1", "fact", 0.5),
    store.store("Lives in Pune", along(0.4), "u1", "fact", 0.5),
  ]);
  assert.equal(again.id, first.id);
  assert.equal(a.id, b.id);
  assert.equal(memories.all().length, 2);
  assert.equal(await store.count("u1"), 2);
});

test("vector search: nearest first, category filter, no vectors in results, user partition only", async () => {
  const { store } = await setup();
  await store.store("far preference", along(0.1), "u1", "preference", 0.5);
  await store.store("near fact", along(0.99), "u1", "fact", 0.5);
  await store.store("mid preference", along(0.6), "u1", "preference", 0.5);
  await store.store("someone else's", along(1), "u2", "fact", 0.5);

  const all = await store.vectorSearch(along(1), "u1", 5);
  assert.deepEqual(all.map((r) => r.entry.text), ["near fact", "mid preference", "far preference"]);
  assert.ok(all.every((r) => Array.isArray(r.entry.vector) && r.entry.vector.length === 0));
  assert.ok(Math.abs(all[0].score - 0.99) < 1e-9);

  const prefs = await store.vectorSearch(along(1), "u1", 5, ["preference"]);
  assert.deepEqual(prefs.map((r) => r.entry.text), ["mid preference", "far preference"]);
});

test("hybrid search ranks full text above vector (weights [2, 1]); without hybrid support it is vector search", async () => {
  const { store } = await setup();
  // "green tea" matches only the first by keyword; the second is nearest by vector.
  await store.store("I drink green tea every morning", along(0.2), "u1", "preference", 0.8);
  await store.store("My laptop is a ThinkPad", along(0.99), "u1", "fact", 0.5);

  const ranked = await store.hybridSearch("green tea", along(1), "u1", 2);
  assert.deepEqual(ranked.map((r) => r.entry.text), ["I drink green tea every morning", "My laptop is a ThinkPad"]);
  assert.deepEqual(ranked.map((r) => r.score), [1, 0.5], "rank-based scores");

  const noHybrid = new InMemoryStorage();
  Object.defineProperty(noHybrid, "capabilities", { value: { vectorSearch: true, hybridSearch: false } });
  const { store: fallback } = await setup(noHybrid);
  await fallback.store("I drink green tea every morning", along(0.2), "u1", "preference", 0.8);
  await fallback.store("My laptop is a ThinkPad", along(0.99), "u1", "fact", 0.5);
  const viaVector = await fallback.hybridSearch("green tea", along(1), "u1", 2);
  assert.equal(viaVector[0].entry.text, "My laptop is a ThinkPad");
});

test("countBySource counts one source, optionally since a time", async () => {
  const { store, memories } = await setup();
  await store.store("a", along(0.1), "u1", "fact", 0.5, "auto-capture");
  await store.store("b", along(0.2), "u1", "fact", 0.5, "auto-capture");
  await store.store("c", along(0.3), "u1", "fact", 0.5, "tool");
  const old = memories.all<{ id: string; text: string }>().find((m) => m.text === "a")!;
  await memories.patch(old.id, "u1", [{ op: "set", path: "/createdAt", value: "2020-01-01T00:00:00.000Z" }]);

  assert.equal(await store.countBySource("u1", "auto-capture"), 2);
  assert.equal(await store.countBySource("u1", "auto-capture", "2021-01-01T00:00:00.000Z"), 1);
  assert.equal(await store.countBySource("u1", "tool"), 1);
});

test("deleteBySearch deletes only matches scoring at least 0.7", async () => {
  const { store } = await setup();
  await store.store("close", along(0.9), "u1", "fact", 0.5);
  await store.store("unrelated", along(0.3), "u1", "fact", 0.5);
  assert.equal(await store.deleteBySearch(along(1), "u1"), 1);
  assert.deepEqual((await store.vectorSearch(along(1), "u1", 5)).map((r) => r.entry.text), ["unrelated"]);
});

test("touchMemory bumps the access count atomically; findByContentHash finds exact text", async () => {
  const { store, memories } = await setup();
  const m = await store.store("exact text", along(0.5), "u1", "fact", 0.5);
  await Promise.all([store.touchMemory(m.id, "u1"), store.touchMemory(m.id, "u1"), store.touchMemory(m.id, "u1")]);
  assert.equal(memories.peek<{ accessCount: number }>(m.id, "u1")?.accessCount, 3);
  assert.equal((await store.findByContentHash("exact text", "u1"))?.id, m.id);
  assert.equal(await store.findByContentHash("exact text", "u2"), null);
});

test("every search and count is scoped to the user's partition", async () => {
  const { store, memories } = await setup();
  const scoped: OperationContext[] = [];
  memories.beforeOperation((ctx) => {
    if (["find", "count", "vectorSearch", "hybridSearch"].includes(ctx.op)) scoped.push(ctx);
  });
  await store.store("x", along(0.5), "u1", "fact", 0.5);
  await store.vectorSearch(along(1), "u1", 3);
  await store.hybridSearch("x y", along(1), "u1", 3);
  await store.count("u1");
  await store.countBySource("u1", "s");
  await store.findByContentHash("not stored", "u1");
  assert.ok(scoped.length >= 5);
  assert.ok(scoped.every((ctx) => ctx.partitionKey === "u1"), JSON.stringify(scoped));
});

test("the store provider resolves as \"storage\" and by its old name \"cosmosdb\"", () => {
  const storage = new InMemoryStorage();
  assert.ok(resolveStoreProvider({ ...config, storeProvider: "storage" }, storage) instanceof StorageMemoryStore);
  assert.ok(resolveStoreProvider({ ...config, storeProvider: "cosmosdb" }, storage) instanceof StorageMemoryStore);
});
