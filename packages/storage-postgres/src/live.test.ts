/**
 * The storage conformance suite, and PostgreSQL-specific checks, against a
 * real server. Skipped unless STORAGE_POSTGRES_URL is set, e.g.
 *
 *   docker run -d --name agentforeach-pg -e POSTGRES_PASSWORD=pw -p 55432:5432 pgvector/pgvector:pg17
 *   STORAGE_POSTGRES_URL=postgres://postgres:pw@localhost:55432/postgres npm test
 *
 * Everything runs in a throwaway schema (conformance_<random>), dropped
 * afterwards; the role needs CREATE on the database, and pgvector must be
 * installed (or installable) there. The TTL tests wait about 18 s.
 */

import test, { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  and,
  contains,
  createStorageAdapter,
  eq,
  gt,
  gte,
  isDefined,
  lt,
  lte,
  matches,
  ne,
  not,
  oneOf,
  or,
  project,
  readField,
  sortDocuments,
  compareForOrder,
  type Filter,
  type JsonValue,
} from "@agentforeach/storage";
import { runStorageConformance } from "@agentforeach/storage/conformance";
import { PostgresStorage, createPool } from "./adapter.js";

const url = process.env.STORAGE_POSTGRES_URL;
const schema = `conformance_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

if (!url) {
  test("postgres conformance (set STORAGE_POSTGRES_URL to run against a live server)", { skip: true }, () => {});
} else {
  after(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  runStorageConformance({
    name: "postgres (live)",
    createAdapter: () => new PostgresStorage({ connectionString: url, schema }),
  });

  // The same suite through a pool source, the path hosts with per-invocation pools take.
  const sourcedSchema = `${schema}_src`;
  const sourcedPools: pg.Pool[] = [];
  after(async () => {
    await Promise.all(sourcedPools.map((p) => p.end()));
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${sourcedSchema}" CASCADE`);
    await client.end();
  });
  runStorageConformance({
    name: "postgres (live, pool source)",
    createAdapter: () => {
      const pool = createPool({ connectionString: url, poolSize: 3 });
      sourcedPools.push(pool);
      return new PostgresStorage({ poolSource: () => pool, schema: sourcedSchema });
    },
  });

  describe("postgres pool sources", () => {
    it("one adapter, a pool per invocation: nothing reaches a pool from an earlier invocation", async () => {
      let current: pg.Pool | undefined;
      const storage = new PostgresStorage({ poolSource: () => current!, schema, sweepIntervalMs: 0, serverTimeouts: false });
      const spec = { name: `scoped_${randomUUID().slice(0, 8)}`, partitionKey: "pk" };
      const invocation = async (work: () => Promise<void>) => {
        current = createPool({ connectionString: url, poolSize: 2, serverTimeouts: false });
        try {
          await work();
        } finally {
          // An invocation's pool ends with it, as a Worker's would.
          await current.end();
        }
      };
      await invocation(async () => {
        await storage.initialize();
        const docs = await storage.collection(spec);
        await docs.create({ id: "a", pk: "p", n: 1 });
      });
      for (let i = 2; i <= 4; i++) {
        await invocation(async () => {
          const docs = await storage.collection(spec);
          await docs.patch("a", "p", [{ op: "incr", path: "/n", value: 1 }]); // a transaction
          const found = await docs.find({ partitionKey: "p", where: eq("n", i) });
          assert.deepEqual(found.map((d) => d.id), ["a"], `invocation ${i}`);
        });
      }
      await storage.close();
    });

    it("sweepAll deletes expired rows in every collection with a TTL, opened here or not", async () => {
      const ttl = { name: `sweep_ttl_${randomUUID().slice(0, 8)}`, partitionKey: "pk", defaultTtl: 1 };
      const kept = { name: `sweep_kept_${randomUUID().slice(0, 8)}`, partitionKey: "pk" };
      const writer = new PostgresStorage({ connectionString: url, schema, sweepIntervalMs: 0 });
      await (await writer.collection(ttl)).create({ id: "old", pk: "p" });
      await (await writer.collection(kept)).create({ id: "keep", pk: "p" });
      await writer.close();
      await new Promise((r) => setTimeout(r, 2_000));

      // A fresh adapter, as a scheduled sweep has: it has opened nothing yet.
      const sweeper = new PostgresStorage({ connectionString: url, schema, sweepIntervalMs: 0 });
      try {
        assert.equal(await sweeper.sweepAll([ttl, kept]), 1);
        const count = async (name: string) =>
          (await sweeper.getPool().query(`SELECT count(*)::int AS n FROM "${schema}"."${name}"`)).rows[0].n;
        assert.equal(await count(ttl.name), 0, "the expired row is gone");
        assert.equal(await count(kept.name), 1, "a collection without a TTL is left alone");
      } finally {
        await sweeper.close();
      }
    });
  });

  describe("postgres specifics", () => {
    let storage: PostgresStorage;
    const raw = (text: string, values: unknown[] = []) => storage.getPool().query(text, values);

    before(async () => {
      storage = new PostgresStorage({ connectionString: url, schema, sweepIntervalMs: 0 });
      await storage.initialize();
    });
    after(() => storage.close());

    it("the plugin entry point builds the adapter from generic host options", async () => {
      const adapter = await createStorageAdapter("postgres", { endpoint: url, schema, sweepIntervalMs: 0 });
      assert.equal(adapter.name, "postgres");
      await adapter.initialize();
      await adapter.close?.();
    });

    it("collection names keep their hyphens; a long name gets a short index name", async () => {
      const name = `rate-limits-${"x".repeat(40)}`;
      const docs = await storage.collection({ name, partitionKey: "pk", defaultTtl: -1 });
      await docs.create({ id: "a", pk: "p" });
      const { rows } = await raw("SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2", [schema, name]);
      assert.equal(rows.length, 2, JSON.stringify(rows)); // primary key + expires_at
      assert.ok(rows.every((r) => Buffer.byteLength(r.indexname) <= 63));
    });

    it("provisioning adds what a newer spec needs and is safe to run concurrently", async () => {
      const name = `evolving_${randomUUID().slice(0, 8)}`;
      const v1 = { name, partitionKey: "pk" };
      const first = await storage.collection(v1);
      await first.create({ id: "a", pk: "p", text: "green tea", vector: [1, 0] });

      // The same collection, a later release: vector and full-text policies.
      const v2 = { ...v1, vector: { field: "vector", dimensions: 2, distance: "cosine" as const }, fullText: { fields: ["text"], language: "en-US" } };
      const others = Array.from({ length: 4 }, () => new PostgresStorage({ connectionString: url, schema, sweepIntervalMs: 0 }));
      try {
        const handles = await Promise.all(others.map((o) => o.collection(v2)));
        // The old row has no embedding until it is written again.
        let results = await handles[0].vectorSearch({ partitionKey: "p", vector: [1, 0], limit: 5 });
        assert.deepEqual(results.map((r) => r.score), [null]);
        await handles[0].upsert({ id: "a", pk: "p", text: "green tea", vector: [1, 0] });
        results = await handles[0].vectorSearch({ partitionKey: "p", vector: [1, 0], limit: 5 });
        assert.equal(results[0].score, 1);
        const hybrid = await handles[1].hybridSearch({ partitionKey: "p", rank: [{ kind: "fullText", field: "text", terms: ["teas"] }], limit: 1 });
        assert.equal(hybrid[0]?.id, "a", "english stemming: teas -> tea");
      } finally {
        await Promise.all(others.map((o) => o.close()));
      }
    });

    it("a vector of another size, or none, is unscored; a zero vector scores 0", async () => {
      const docs = await storage.collection({
        name: `vectors_${randomUUID().slice(0, 8)}`,
        partitionKey: "pk",
        vector: { field: "embedding", dimensions: 2, distance: "cosine" },
      });
      await docs.create({ id: "ok", pk: "p", embedding: [0, 1] });
      await docs.create({ id: "zero", pk: "p", embedding: [0, 0] });
      await docs.create({ id: "short", pk: "p", embedding: [1] });
      await docs.create({ id: "strings", pk: "p", embedding: ["1", "0"] });
      await docs.create({ id: "huge", pk: "p", embedding: [1e39, 0] });
      const results = await docs.vectorSearch({ partitionKey: "p", vector: [0, 1], limit: 10 });
      assert.deepEqual(results.slice(0, 2).map((r) => [r.document.id, r.score]), [["ok", 1], ["zero", 0]]);
      assert.deepEqual(results.slice(2).map((r) => r.score), [null, null, null]);
      // Vectors read back exactly as written (the document keeps the doubles).
      await docs.upsert({ id: "precise", pk: "p", embedding: [0.1234567890123, 1 / 3] });
      assert.deepEqual((await docs.read("precise", "p"))?.embedding, [0.1234567890123, 1 / 3]);
      const zeroQuery = await docs.vectorSearch({ partitionKey: "p", where: eq("id", "ok"), vector: [0, 0], limit: 1 });
      assert.equal(zeroQuery[0].score, 0);
    });

    it("the sweep deletes expired rows and leaves live ones", async () => {
      const docs = await storage.collection({ name: `sweep_${randomUUID().slice(0, 8)}`, partitionKey: "pk", defaultTtl: 1 });
      await docs.create({ id: "short", pk: "p" });
      await docs.create({ id: "forever", pk: "p", ttl: -1 });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(await storage.sweepExpired() >= 1, true);
      const { rows } = await raw(`SELECT id FROM "${schema}"."${docs.spec.name}" ORDER BY id`);
      assert.deepEqual(rows.map((r) => r.id), ["forever"]);
    });

    it("a lone surrogate is stored as U+FFFD, and filters on it still match", async () => {
      const docs = await storage.collection({ name: "plain_specifics", partitionKey: "pk" });
      const cut = "smile \ud83d"; // "smile 😀" cut in the middle of the emoji
      await docs.create({ id: "cut", pk: "p", title: cut, k: { nested: "\ude00 tail" } });
      const read = await docs.read("cut", "p");
      assert.equal(read?.title, "smile \ufffd");
      assert.deepEqual(read?.k, { nested: "\ufffd tail" });
      assert.deepEqual((await docs.find({ partitionKey: "p", where: eq("title", cut) })).map((d) => d.id), ["cut"]);
    });

    it("a connection lost mid-transaction fails the patch, not the process", async () => {
      const docs = await storage.collection({ name: "plain_specifics", partitionKey: "pk" });
      await docs.create({ id: "locked", pk: "p", n: 0 });
      // Another session holds the row, so the patch waits in SELECT ... FOR UPDATE.
      const holder = new pg.Client({ connectionString: url });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 FROM "${schema}"."plain_specifics" WHERE pk = 'p' AND id = 'locked' FOR UPDATE`);
        const patching = docs.patch("locked", "p", [{ op: "incr", path: "/n", value: 1 }]);
        const outcome = patching.then(() => "resolved", (err: Error) => `rejected: ${err.message}`);
        let killed = 0;
        for (let i = 0; i < 50 && killed === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const { rows } = await holder.query(
            "SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE query LIKE '%FOR UPDATE%' AND query LIKE '%doc%' AND pid <> pg_backend_pid()",
          );
          killed = rows.length;
        }
        assert.equal(killed, 1, "found the waiting patch");
        assert.match(await outcome, /^rejected/);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
      }
      // The pool dropped the dead connection and carries on.
      assert.equal((await docs.patch("locked", "p", [{ op: "incr", path: "/n", value: 1 }])).n, 1);
    });

    it("case-insensitive contains folds non-ASCII letters on both sides", async () => {
      const docs = await storage.collection({ name: "plain_specifics", partitionKey: "pk" });
      await docs.create({ id: "accents", pk: "fold", s: "École d'été — ПРИВЕТ" });
      for (const needle of ["école", "ÉCOLE", "ÉTÉ", "привет"]) {
        assert.deepEqual((await docs.find({ partitionKey: "fold", where: contains("s", needle, { ignoreCase: true }) })).map((d) => d.id), ["accents"], needle);
      }
    });

    it("a relation that is not a table is refused; close is idempotent and final", async () => {
      await raw(`CREATE VIEW "${schema}"."not_a_table" AS SELECT 1 AS x`);
      await assert.rejects(storage.collection({ name: "not_a_table", partitionKey: "pk" }), { name: "StorageError", code: "BadRequest" });
      const other = new PostgresStorage({ connectionString: url, schema, sweepIntervalMs: 0 });
      await other.collection({ name: "plain_specifics", partitionKey: "pk" });
      await other.close();
      await other.close();
      await assert.rejects(other.collection({ name: "plain_specifics", partitionKey: "pk" }), /closed/);
    });

    it("values PostgreSQL cannot store are BadRequest", async () => {
      const docs = await storage.collection({ name: "plain_specifics", partitionKey: "pk" });
      await assert.rejects(docs.create({ id: "nul", pk: "p", text: "a\u0000b" }), { name: "StorageError", code: "BadRequest" });
      await assert.rejects(docs.create({ id: "nul\u0000", pk: "p" }), { name: "StorageError", code: "BadRequest" });
    });
  });

  // --------------------------------------------------------------------------
  // Randomized parity: the compiled SQL must agree with the SDK's reference
  // semantics (`matches`, `sortDocuments`) on documents and filters built to
  // hit the edges (absent vs null, mixed types, nested paths, arrays).
  // --------------------------------------------------------------------------
  describe("parity with the reference semantics", () => {
    let storage: PostgresStorage;
    const docs: Array<Record<string, unknown> & { id: string; pk: string }> = [];

    // A small deterministic PRNG, so a failure reproduces.
    let seed = 20261002;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <V>(values: readonly V[]): V => values[Math.floor(random() * values.length)];

    // Numbers whose text order differs from their numeric order (2 < 10 < 100,
    // "10" < "2"), non-ASCII case pairs, nested structures. Strings stay below
    // U+E000: UTF-8 and UTF-16 order differ above it (a documented difference).
    const VALUES: JsonValue[] = [
      null, true, false, 0, 1, 2, 9, 10, 100, -10, -2.5, 0.5, -0.5, 1e21,
      "", "a", "B", "b", "ab", "Ab", "é", "É", "École", "10", "9",
      [1], ["a"], [[1, [2]]], {}, { x: 1 }, { x: { y: [1, { z: null }] } },
    ];
    // "null" / "o.NULL": path segments a SQL array literal must quote.
    const FIELDS = ["f", "g", "o.x", "o.y", "null", "o.NULL"];
    let collection: Awaited<ReturnType<PostgresStorage["collection"]>>;

    before(async () => {
      storage = new PostgresStorage({ connectionString: url, schema, sweepIntervalMs: 0 });
      collection = await storage.collection({ name: "parity", partitionKey: "pk" });
      for (let i = 0; i < 60; i++) {
        const doc: Record<string, unknown> & { id: string; pk: string } = { id: `d${i}`, pk: i % 3 === 0 ? "q" : "p" };
        if (random() < 0.8) doc.f = pick(VALUES);
        if (random() < 0.8) doc.g = pick(VALUES);
        if (random() < 0.5) doc.null = pick(VALUES);
        const o = random();
        if (o < 0.5) {
          doc.o = { x: pick(VALUES), ...(random() < 0.5 ? { y: pick(VALUES) } : {}), ...(random() < 0.5 ? { NULL: pick(VALUES) } : {}) };
        }
        else if (o < 0.7) doc.o = pick(VALUES);
        docs.push(doc);
        await collection.create(doc);
      }
    });
    after(() => storage.close());

    function randomFilter(depth: number): Filter {
      const field = pick(FIELDS);
      const value = pick(VALUES);
      const roll = random();
      if (depth > 0 && roll < 0.25) {
        const children = Array.from({ length: Math.floor(random() * 3) }, () => randomFilter(depth - 1));
        return random() < 0.5 ? and(...children) : or(...children);
      }
      if (depth > 0 && roll < 0.35) return not(randomFilter(depth - 1));
      switch (pick(["eq", "ne", "lt", "lte", "gt", "gte", "in", "isDefined", "contains", "containsCi"] as const)) {
        case "eq": return eq(field, value);
        case "ne": return ne(field, value);
        case "lt": return lt(field, value);
        case "lte": return lte(field, value);
        case "gt": return gt(field, value);
        case "gte": return gte(field, value);
        case "in": return oneOf(field, Array.from({ length: Math.floor(random() * 3) }, () => pick(VALUES)));
        case "isDefined": return isDefined(field);
        case "contains": return contains(field, pick(["a", "b", "", "B", "1", "É"]));
        case "containsCi": return contains(field, pick(["a", "B", "É", "é", "COLE"]), { ignoreCase: true });
      }
    }

    it("filters select and count exactly the documents the reference selects", async () => {
      for (let round = 0; round < 400; round++) {
        const filter = randomFilter(3);
        // Alternately within partition "p" and across both partitions.
        const partitionKey = round % 2 === 0 ? "p" : undefined;
        const expected = docs
          .filter((d) => (partitionKey === undefined || d.pk === partitionKey) && matches(filter, d))
          .map((d) => d.id)
          .sort();
        const actual = (await collection.find({ partitionKey, where: filter, select: ["id"] })).map((d) => (d as { id: string }).id).sort();
        assert.deepEqual(actual, expected, JSON.stringify(filter));
        if (round % 4 === 1) assert.equal(await collection.count({ partitionKey, where: filter }), expected.length, JSON.stringify(filter));
      }
    });

    it("projections agree with the reference projection", async () => {
      const select = FIELDS.map((field, i) => ({ field, as: `k${i}` }));
      const actual = await collection.find<Record<string, unknown>>({ select: ["id", ...select] });
      const byId = new Map(actual.map((row) => [row.id, row]));
      for (const doc of docs) assert.deepEqual(byId.get(doc.id), project(doc, ["id", ...select]), doc.id);
    });

    it("ordering agrees with the reference order (ties aside)", async () => {
      for (const field of FIELDS) {
        for (const direction of ["asc", "desc"] as const) {
          const expected = sortDocuments(docs, { field, direction }).map((d) => readField(d, field));
          const actual = (await collection.find({ orderBy: { field, direction } })).map((d) => readField(d, field));
          // Compare the sequence of sort keys: documents with equal keys may come in any order.
          const kinds = (values: unknown[]) => values.map((v) => [typeof v, Array.isArray(v)]);
          assert.deepEqual(kinds(actual), kinds(expected), `${field} ${direction}`);
          for (let i = 0; i < expected.length; i++) {
            const order = compareForOrder(actual[i], expected[i]);
            const scalar = (v: unknown) => v === undefined || v === null || ["boolean", "number", "string"].includes(typeof v);
            if (scalar(expected[i])) assert.equal(order, 0, `${field} ${direction} at ${i}: ${JSON.stringify(actual[i])} vs ${JSON.stringify(expected[i])}`);
          }
        }
      }
    });
  });
}
