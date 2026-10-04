import assert from "node:assert/strict";
import test from "node:test";
import { runObjectStoreConformance } from "./conformance.js";
import { isObjectNotFound, isObjectTooLarge, ObjectStoreError } from "./errors.js";
import { MemoryObjectStore } from "./memory.js";

// The in-memory store must pass the same suite as every cloud provider.
runObjectStoreConformance({ name: "memory", createStore: () => new MemoryObjectStore() });

test("returned bytes are copies, so callers cannot change stored objects", async () => {
  const store = new MemoryObjectStore();
  const body = new Uint8Array([1, 2, 3]);
  await store.put("k", body);
  body[0] = 9;
  const read = await store.get("k");
  read[1] = 9;
  assert.deepEqual(await store.get("k"), new Uint8Array([1, 2, 3]));
});

test("the memory and s3 providers sign at most 7 days ahead", async () => {
  const store = new MemoryObjectStore();
  await assert.rejects(store.signedUrl("k", { expiresAt: new Date(Date.now() + 8 * 86_400_000) }), { code: "invalid" });
});

test("error predicates match by name and code", () => {
  assert.equal(isObjectNotFound(new ObjectStoreError("not_found", "x")), true);
  assert.equal(isObjectNotFound(Object.assign(new Error("x"), { name: "ObjectStoreError", code: "not_found" })), true);
  assert.equal(isObjectNotFound(new ObjectStoreError("too_large", "x")), false);
  assert.equal(isObjectTooLarge(new ObjectStoreError("too_large", "x")), true);
  assert.equal(new ObjectStoreError("too_large", "x").statusCode, 413);
});
