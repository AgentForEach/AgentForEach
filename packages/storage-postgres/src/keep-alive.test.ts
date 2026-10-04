import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { PostgresStorage } from "./adapter.js";

// A pool that answers every query; no server needed.
const fakePool = { query: async () => ({ rows: [], rowCount: 1 }) } as unknown as pg.Pool;

test("work later callers share is handed to keepAlive, once each", async () => {
  const kept: Promise<unknown>[] = [];
  const storage = new PostgresStorage({
    pool: fakePool,
    provisionTables: false,
    sweepIntervalMs: 0,
    keepAlive: (work) => kept.push(work),
  });
  await Promise.all([storage.initialize(), storage.initialize()]);
  assert.equal(kept.length, 1, "the connection check, shared by both callers");
  const spec = { name: "notes", partitionKey: "userId" };
  await Promise.all([storage.collection(spec), storage.collection(spec)]);
  assert.equal(kept.length, 2, "one collection's setup, shared by both callers");
  await storage.close();
});
