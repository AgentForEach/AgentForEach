/**
 * AgentForEach Storage SDK — Conformance suite
 *
 * One `node:test` suite every adapter must pass. It pins down the contract's
 * observable behaviour (Cosmos DB's, the original backend): etags, conflicts,
 * patches, TTL, three-valued filter logic, ordering, projection, vector and
 * hybrid search. An adapter that passes it can replace any other without
 * the runtime noticing.
 *
 * ```ts
 * import { runStorageConformance } from "@agentforeach/storage/conformance";
 *
 * runStorageConformance({
 *   name: "postgres",
 *   createAdapter: () => new PostgresStorage({ connectionString }),
 *   cleanup: (adapter, names) => dropTables(names),
 * });
 * ```
 *
 * The suite creates a few collections named `<prefix>_<run>_<kind>` and
 * isolates every test in its own partitions, so it can run against a shared
 * database. TTL tests wait in real time (about 18 s in total, with margins
 * for Cosmos' one-second `_ts` granularity and network latency) unless
 * `advanceTime` moves the adapter's clock instead.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isConflict, isNotFound, isPreconditionFailed, type StorageErrorCode } from "../errors.js";
import { MAX_PATCH_OPERATIONS, type PatchOperation } from "../types.js";
import {
  and,
  contains,
  eq,
  gt,
  isDefined,
  lt,
  lte,
  missing,
  ne,
  not,
  oneOf,
  or,
  present,
  type Filter,
} from "../filter.js";
import { mutate } from "../mutate.js";
import type { Collection, CollectionSpec, Doc, RankComponent, StorageAdapter } from "../types.js";

export type ConformanceOptions = {
  /** Shown in the suite name. */
  name: string;
  createAdapter: () => StorageAdapter | Promise<StorageAdapter>;
  /**
   * Move the adapter's clock forward. Default: wait in real time. Adapters
   * with an injectable clock (the in-memory one) pass a fake to run fast.
   */
  advanceTime?: (ms: number) => Promise<void>;
  /** Collection name prefix. Default "conformance". */
  collectionPrefix?: string;
  /** Remove the suite's collections afterwards (live databases). */
  cleanup?: (adapter: StorageAdapter, collectionNames: string[]) => Promise<void>;
};

type TestDoc = Doc & { pk: string; [key: string]: unknown };

const uniq = (): string => randomUUID().replace(/-/g, "").slice(0, 10);

async function rejectsWith(promise: Promise<unknown>, code: StorageErrorCode): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    const e = err as { name?: string; code?: unknown };
    assert.equal(e?.name, "StorageError", `expected a StorageError, got ${String(err)}`);
    assert.equal(e.code, code);
    return true;
  });
}

const ids = (docs: Array<{ id?: unknown }>): string[] => docs.map((d) => String(d.id)).sort();
const orderedIds = (docs: Array<{ id?: unknown }>): string[] => docs.map((d) => String(d.id));

export function runStorageConformance(options: ConformanceOptions): void {
  const advance = options.advanceTime ?? ((ms: number) => sleep(ms).then(() => undefined));
  const prefix = `${options.collectionPrefix ?? "conformance"}_${uniq()}`;

  const specs = {
    plain: { name: `${prefix}_plain`, partitionKey: "pk" },
    byId: { name: `${prefix}_by_id`, partitionKey: "id" },
    nested: { name: `${prefix}_nested`, partitionKey: "tenant.id" },
    ttlDefault: { name: `${prefix}_ttl_default`, partitionKey: "pk", defaultTtl: 5 },
    ttlOptIn: { name: `${prefix}_ttl_optin`, partitionKey: "pk", defaultTtl: -1 },
    search: {
      name: `${prefix}_search`,
      partitionKey: "pk",
      vector: { field: "vector", dimensions: 3, distance: "cosine" },
      fullText: { fields: ["text"], language: "en-US" },
    },
  } satisfies Record<string, CollectionSpec>;

  describe(`storage conformance: ${options.name}`, () => {
    let adapter: StorageAdapter;
    let plain: Collection<TestDoc>;
    let byId: Collection<Doc>;
    let nested: Collection<Doc>;
    let ttlDefault: Collection<TestDoc>;
    let ttlOptIn: Collection<TestDoc>;

    before(async () => {
      adapter = await options.createAdapter();
      await adapter.initialize();
      plain = await adapter.collection<TestDoc>(specs.plain);
      byId = await adapter.collection<Doc>(specs.byId);
      nested = await adapter.collection<Doc>(specs.nested);
      ttlDefault = await adapter.collection<TestDoc>(specs.ttlDefault);
      ttlOptIn = await adapter.collection<TestDoc>(specs.ttlOptIn);
    });

    after(async () => {
      if (!adapter) return;
      const names = Object.values(specs)
        .filter((s) => s !== specs.search || adapter.capabilities.vectorSearch)
        .map((s) => s.name);
      await options.cleanup?.(adapter, names);
      await adapter.close?.();
    });

    // ------------------------------------------------------------------------
    describe("documents", () => {
      it("create returns the stored document with an _etag; read returns the same", async () => {
        const pk = uniq();
        const created = await plain.create({ id: "a", pk, n: 1, nested: { x: [1, "two", null] }, gone: undefined });
        assert.equal(typeof created._etag, "string");
        assert.ok(created._etag.length > 0);
        assert.equal("gone" in created, false, "undefined fields are not stored");
        const read = await plain.read("a", pk);
        assert.ok(read);
        assert.deepEqual({ ...read, _etag: undefined }, { id: "a", pk, n: 1, nested: { x: [1, "two", null] }, _etag: undefined });
        assert.equal(read._etag, created._etag);
      });

      it("returned documents carry no system fields other than _etag", async () => {
        const pk = uniq();
        const systemFields = (doc: object) => Object.keys(doc).filter((k) => k.startsWith("_") && k !== "_etag");
        const outputs: object[] = [
          await plain.create({ id: "a", pk, n: 1 }),
          await plain.upsert({ id: "a", pk, n: 2 }),
          await plain.replace("a", pk, { id: "a", pk, n: 3 }),
          await plain.patch("a", pk, [{ op: "set", path: "/n", value: 4 }]),
          (await plain.read("a", pk))!,
          ...(await plain.find({ partitionKey: pk })),
        ];
        for (const doc of outputs) assert.deepEqual(systemFields(doc), []);
      });

      it("partition keys may be the id field or a nested field", async () => {
        const id = uniq();
        await byId.create({ id, n: 1 });
        assert.equal((await byId.read(id, id))?.n, 1);
        assert.equal((await byId.patch(id, id, [{ op: "incr", path: "/n", value: 1 }])).n, 2);
        assert.equal(await byId.delete(id, id), true);

        const tenant = uniq();
        await nested.create({ id: "a", tenant: { id: tenant }, n: 1 });
        assert.equal((await nested.read("a", tenant))?.n, 1);
        assert.deepEqual(ids(await nested.find({ partitionKey: tenant })), ["a"]);
        await rejectsWith(nested.replace("a", tenant, { id: "a", tenant: { id: uniq() } }), "BadRequest");
        await rejectsWith(nested.create({ id: "b", tenant: {} }), "BadRequest");
      });

      it("read of a missing document is null; one id can live in two partitions", async () => {
        const [p1, p2] = [uniq(), uniq()];
        assert.equal(await plain.read("nope", p1), null);
        await plain.create({ id: "same", pk: p1, n: 1 });
        await plain.create({ id: "same", pk: p2, n: 2 });
        assert.equal((await plain.read("same", p1))?.n, 1);
        assert.equal((await plain.read("same", p2))?.n, 2);
      });

      it("create of an existing id fails with Conflict (409)", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk });
        await rejectsWith(plain.create({ id: "a", pk }), "Conflict");
        await assert.rejects(plain.create({ id: "a", pk }), { statusCode: 409 });
      });

      it("of concurrent creates of one id exactly one succeeds", async () => {
        const pk = uniq();
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) => plain.create({ id: "race", pk, writer: i })),
        );
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        for (const r of results) {
          if (r.status === "rejected") assert.ok(isConflict(r.reason), String(r.reason));
        }
      });

      it("upsert creates, then overwrites with a new _etag", async () => {
        const pk = uniq();
        const first = await plain.upsert({ id: "a", pk, v: 1, old: true });
        const second = await plain.upsert({ id: "a", pk, v: 2 });
        assert.notEqual(second._etag, first._etag);
        const read = await plain.read("a", pk);
        assert.equal(read?.v, 2);
        assert.equal(read && "old" in read, false, "upsert replaces the whole document");
      });

      it("replace overwrites; NotFound when missing; BadRequest on id or partition mismatch", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk, v: 1 });
        const replaced = await plain.replace("a", pk, { id: "a", pk, v: 2 });
        assert.equal(replaced.v, 2);
        assert.equal((await plain.read("a", pk))?.v, 2);
        await rejectsWith(plain.replace("missing", pk, { id: "missing", pk }), "NotFound");
        await assert.rejects(plain.replace("missing", pk, { id: "missing", pk }), { statusCode: 404 });
        await rejectsWith(plain.replace("a", pk, { id: "b", pk }), "BadRequest");
        await rejectsWith(plain.replace("a", pk, { id: "a", pk: uniq() }), "BadRequest");
      });

      it("system fields in a written body are ignored (a stale _etag is not a condition)", async () => {
        const pk = uniq();
        const created = await plain.create({ id: "a", pk, v: 1 });
        await plain.upsert({ id: "a", pk, v: 1.5 });
        // A document read earlier and spread back carries its old metadata.
        const metadata = { _ts: 1, _rid: "x", _self: "y", _attachments: "z" };
        const replaced = await plain.replace("a", pk, { ...created, ...metadata, v: 2 });
        assert.equal(replaced.v, 2);
        assert.notEqual(replaced._etag, created._etag);
        const read = (await plain.read("a", pk)) as Record<string, unknown>;
        for (const [field, value] of Object.entries(metadata)) assert.notEqual(read[field], value, field);
      });

      it("ifMatch: a stale etag fails with PreconditionFailed (412) and changes nothing", async () => {
        const pk = uniq();
        const v1 = await plain.create({ id: "a", pk, v: 1 });
        const v2 = await plain.replace("a", pk, { id: "a", pk, v: 2 }, { ifMatch: v1._etag });
        assert.notEqual(v2._etag, v1._etag);
        await rejectsWith(plain.replace("a", pk, { id: "a", pk, v: 3 }, { ifMatch: v1._etag }), "PreconditionFailed");
        await assert.rejects(plain.replace("a", pk, { id: "a", pk, v: 3 }, { ifMatch: v1._etag }), { statusCode: 412 });
        await rejectsWith(plain.patch("a", pk, [{ op: "set", path: "/v", value: 3 }], { ifMatch: v1._etag }), "PreconditionFailed");
        await rejectsWith(plain.delete("a", pk, { ifMatch: v1._etag }), "PreconditionFailed");
        const read = await plain.read("a", pk);
        assert.equal(read?.v, 2);
        assert.equal(read?._etag, v2._etag);
        assert.equal(await plain.delete("a", pk, { ifMatch: v2._etag }), true);
        assert.equal(await plain.read("a", pk), null);
      });

      it("delete returns true once, false when missing; of concurrent deletes exactly one is true", async () => {
        const pk = uniq();
        assert.equal(await plain.delete("missing", pk), false);
        await plain.create({ id: "a", pk });
        const results = await Promise.all(Array.from({ length: 6 }, () => plain.delete("a", pk)));
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal(await plain.read("a", pk), null);
      });

      it("rejects invalid ids, partition keys and ttl values with BadRequest", async () => {
        const pk = uniq();
        for (const id of ["", "a/b", "a\\b", "a?b", "a#b"]) {
          await rejectsWith(plain.create({ id, pk }), "BadRequest");
        }
        await rejectsWith(plain.create({ id: "a" } as TestDoc), "BadRequest");
        await rejectsWith(plain.create({ id: "a", pk: 5 } as unknown as TestDoc), "BadRequest");
        for (const ttl of [0, -2, 1.5, null, 2_147_483_648]) {
          await rejectsWith(ttlOptIn.create({ id: "a", pk, ttl } as TestDoc), "BadRequest");
        }
        await rejectsWith(plain.create({ id: "x".repeat(1024), pk }), "BadRequest");
        await plain.create({ id: "y".repeat(1023), pk });
      });
    });

    // ------------------------------------------------------------------------
    describe("patch", () => {
      it("set, remove and incr apply in order and return the new document", async () => {
        const pk = uniq();
        const created = await plain.create({ id: "a", pk, count: 1, obj: { keep: 1, drop: 2 }, label: "x" });
        const patched = await plain.patch("a", pk, [
          { op: "incr", path: "/count", value: 2 },
          { op: "incr", path: "/fresh", value: 5 },
          { op: "set", path: "/obj/added", value: { deep: true } },
          { op: "remove", path: "/obj/drop" },
          { op: "set", path: "/label", value: null },
        ]);
        assert.notEqual(patched._etag, created._etag);
        const expected = { id: "a", pk, count: 3, fresh: 5, obj: { keep: 1, added: { deep: true } }, label: null };
        assert.deepEqual({ ...patched, _etag: undefined }, { ...expected, _etag: undefined });
        const read = await plain.read("a", pk);
        assert.deepEqual({ ...read, _etag: undefined }, { ...expected, _etag: undefined });
        assert.equal(read?._etag, patched._etag);
      });

      it("fails as a whole: one bad operation leaves the document unchanged", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk, v: 1, s: "text" });
        await rejectsWith(
          plain.patch("a", pk, [{ op: "set", path: "/v", value: 2 }, { op: "remove", path: "/absent" }]),
          "BadRequest",
        );
        await rejectsWith(plain.patch("a", pk, [{ op: "incr", path: "/s", value: 1 }]), "BadRequest");
        await rejectsWith(plain.patch("a", pk, [{ op: "set", path: "/no/parent", value: 1 }]), "BadRequest");
        await rejectsWith(plain.patch("a", pk, [{ op: "set", path: "/pk", value: uniq() }]), "BadRequest");
        assert.equal((await plain.read("a", pk))?.v, 1);
      });

      it("NotFound on a missing document", async () => {
        await rejectsWith(plain.patch("missing", uniq(), [{ op: "set", path: "/v", value: 1 }]), "NotFound");
      });

      it("refuses id changes, array or escaped paths, incr on null, and more than the operation limit", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk, list: [1, 2], nothing: null, n: 0 });
        await rejectsWith(plain.patch("a", pk, [{ op: "set", path: "/id", value: "b" }]), "BadRequest");
        await rejectsWith(plain.patch("a", pk, [{ op: "set", path: "/list/0", value: 9 }]), "BadRequest");
        await rejectsWith(plain.patch("a", pk, [{ op: "set", path: "/list/-", value: 9 }]), "BadRequest");
        await rejectsWith(plain.patch("a", pk, [{ op: "set", path: "/a~1b", value: 9 }]), "BadRequest");
        await rejectsWith(plain.patch("a", pk, [{ op: "incr", path: "/nothing", value: 1 }]), "BadRequest");
        const incr: PatchOperation = { op: "incr", path: "/n", value: 1 };
        await rejectsWith(plain.patch("a", pk, Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, () => incr)), "BadRequest");
        assert.equal((await plain.patch("a", pk, Array.from({ length: MAX_PATCH_OPERATIONS }, () => incr))).n, MAX_PATCH_OPERATIONS);
        assert.deepEqual((await plain.read("a", pk))?.list, [1, 2]);
      });

      it("a current ifMatch lets the patch through", async () => {
        const pk = uniq();
        const created = await plain.create({ id: "a", pk, n: 1 });
        const patched = await plain.patch("a", pk, [{ op: "incr", path: "/n", value: 1 }], { ifMatch: created._etag });
        assert.equal(patched.n, 2);
      });

      it("concurrent increments never lose an update", async () => {
        const pk = uniq();
        await plain.create({ id: "counter", pk, count: 0 });
        const n = 25;
        await Promise.all(
          Array.from({ length: n }, () => plain.patch("counter", pk, [{ op: "incr", path: "/count", value: 1 }])),
        );
        assert.equal((await plain.read("counter", pk))?.count, n);
      });
    });

    // ------------------------------------------------------------------------
    describe("mutate", () => {
      it("updates, skips, and reports notFound", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk, n: 1 });
        const updated = await mutate(plain, "a", pk, (doc) => ({ ...doc, n: (doc.n as number) + 1 }));
        assert.equal(updated.status, "updated");
        assert.equal((await plain.read("a", pk))?.n, 2);
        const skipped = await mutate(plain, "a", pk, () => undefined);
        assert.equal(skipped.status, "skipped");
        assert.equal((await mutate(plain, "missing", pk, (d) => d)).status, "notFound");
      });

      it("retries on a concurrent write and reports contention when every attempt loses", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk, n: 0 });
        const attempts: number[] = [];
        const result = await mutate(
          plain,
          "a",
          pk,
          async (doc, attempt) => {
            attempts.push(attempt);
            await plain.upsert({ ...doc, interloper: attempt }); // makes doc._etag stale
            return { ...doc, n: 99 };
          },
          { maxAttempts: 3 },
        );
        assert.deepEqual(result, { status: "contention", attempts: 3 });
        assert.deepEqual(attempts, [1, 2, 3]);
        assert.equal((await plain.read("a", pk))?.n, 0);
      });

      it("concurrent mutations all apply", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk, n: 0 });
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            mutate(plain, "a", pk, (doc) => ({ ...doc, n: (doc.n as number) + 1 }), { maxAttempts: 50 }),
          ),
        );
        assert.ok(results.every((r) => r.status === "updated"));
        assert.equal((await plain.read("a", pk))?.n, 10);
      });
    });

    // ------------------------------------------------------------------------
    describe("ttl", () => {
      it("expires by collection default or document ttl; ignores ttl when TTL is off", async () => {
        const pk = uniq();
        // defaultTtl is 5 s. Margins: Cosmos floors _ts to the second, and
        // every call here is a network round trip.
        await ttlDefault.create({ id: "default", pk });
        await ttlDefault.create({ id: "forever", pk, ttl: -1 });
        await ttlDefault.create({ id: "longer", pk, ttl: 60 });
        await ttlOptIn.create({ id: "no-ttl", pk });
        await ttlOptIn.create({ id: "short", pk, ttl: 5 });
        await plain.create({ id: "ttl-off", pk, ttl: 5 });
        assert.ok(await ttlDefault.read("default", pk), "visible before it expires");
        assert.ok(await ttlOptIn.read("short", pk));

        await advance(7_000);

        assert.equal(await ttlDefault.read("default", pk), null);
        assert.ok(await ttlDefault.read("forever", pk));
        assert.ok(await ttlDefault.read("longer", pk));
        assert.ok(await ttlOptIn.read("no-ttl", pk));
        assert.equal(await ttlOptIn.read("short", pk), null);
        assert.ok(await plain.read("ttl-off", pk), "per-document ttl is ignored without a collection TTL");

        // Expired documents are gone for every operation, not just reads.
        assert.deepEqual(ids(await ttlDefault.find({ partitionKey: pk })), ["forever", "longer"]);
        // count may still include the expired document until it is purged
        // (Cosmos does, for a while); it never undercounts.
        const counted = await ttlDefault.count({ partitionKey: pk });
        assert.ok(counted === 2 || counted === 3, `count ${counted}`);
        await rejectsWith(ttlDefault.replace("default", pk, { id: "default", pk }), "NotFound");
        await rejectsWith(ttlDefault.patch("default", pk, [{ op: "set", path: "/v", value: 1 }]), "NotFound");
        assert.equal(await ttlDefault.delete("default", pk), false);
        await ttlDefault.create({ id: "default", pk, reborn: true });
        assert.equal((await ttlDefault.read("default", pk))?.reborn, true);
      });

      it("every write restarts the clock", async () => {
        const pk = uniq();
        // ttl 6 s; rewritten at ~4 s; checked at ~7 s (control gone; the
        // rewritten alive with ~1-2 s to spare after Cosmos floors _ts to
        // the second and network latency) and at ~11 s (all gone).
        for (const id of ["control", "upserted", "replaced", "patched"]) {
          await ttlOptIn.create({ id, pk, ttl: 6 });
        }
        await advance(4_000);
        await ttlOptIn.upsert({ id: "upserted", pk, ttl: 6 });
        await ttlOptIn.replace("replaced", pk, { id: "replaced", pk, ttl: 6 });
        await ttlOptIn.patch("patched", pk, [{ op: "set", path: "/touched", value: true }]);
        await advance(3_000);
        assert.equal(await ttlOptIn.read("control", pk), null);
        for (const id of ["upserted", "replaced", "patched"]) {
          assert.ok(await ttlOptIn.read(id, pk), `${id} should still be alive`);
        }
        await advance(4_000);
        for (const id of ["upserted", "replaced", "patched"]) {
          assert.equal(await ttlOptIn.read(id, pk), null, `${id} should have expired`);
        }
      });
    });

    // ------------------------------------------------------------------------
    describe("queries", () => {
      const P = uniq();
      const P2 = uniq();
      const tag = uniq();
      const where = (filter: Filter) => ({ partitionKey: P, where: filter });

      before(async () => {
        await plain.create({ id: "a", pk: P, tag, n: 1, s: "apple", flag: true, state: { status: "pending", at: 10 }, opt: null, cat: "x", tags: ["an"] });
        await plain.create({ id: "b", pk: P, tag, n: 2, s: "Banana", flag: false, state: { status: "done", at: 20 }, cat: "y" });
        await plain.create({ id: "c", pk: P, tag, n: "3", s: "cherry pie", state: { status: "pending" }, opt: 5, cat: "z" });
        await plain.create({ id: "d", pk: P2, tag, n: 4, s: "date", flag: true, opt: null, cat: "x" });
      });

      it("scopes to one partition or spans them", async () => {
        assert.deepEqual(ids(await plain.find({ partitionKey: P })), ["a", "b", "c"]);
        assert.deepEqual(ids(await plain.find({ where: eq("tag", tag) })), ["a", "b", "c", "d"]);
        assert.equal(await plain.count({ partitionKey: P }), 3);
        assert.equal(await plain.count({ where: eq("tag", tag) }), 4);
        assert.equal(await plain.count({ where: and(eq("tag", tag), eq("cat", "x")) }), 2);
      });

      it("whole documents carry their _etag", async () => {
        const [found] = await plain.find(where(eq("n", 1)));
        assert.equal(found._etag, (await plain.read("a", P))?._etag);
      });

      it("comparisons are type-strict: eq across types is false, ne across types is true", async () => {
        assert.deepEqual(ids(await plain.find(where(eq("n", 1)))), ["a"]);
        assert.deepEqual(ids(await plain.find(where(eq("n", "3")))), ["c"]);
        assert.deepEqual(ids(await plain.find(where(eq("n", 3)))), []);
        assert.deepEqual(ids(await plain.find(where(ne("n", 1)))), ["b", "c"]);
        assert.deepEqual(ids(await plain.find(where(gt("n", 1)))), ["b"], "a string never compares with a number");
        assert.deepEqual(ids(await plain.find(where(lt("flag", true)))), ["b"], "booleans order false < true");
        assert.deepEqual(ids(await plain.find(where(oneOf("n", ["1", 2])))), ["b"], "oneOf is type-strict too");
        assert.deepEqual(ids(await plain.find(where(lte("opt", null)))), ["a"], "null compares only with null");
      });

      it("a comparison on an absent field is unknown, and NOT unknown stays unknown", async () => {
        assert.deepEqual(ids(await plain.find(where(ne("flag", true)))), ["b"]);
        assert.deepEqual(ids(await plain.find(where(not(eq("flag", true))))), ["b"]);
        assert.deepEqual(ids(await plain.find(where(or(eq("flag", true), eq("n", 2))))), ["a", "b"]);
        assert.deepEqual(ids(await plain.find(where(and(eq("flag", false), eq("n", 2))))), ["b"]);
        assert.deepEqual(ids(await plain.find(where(not(oneOf("flag", [true]))))), ["b"], "oneOf on an absent field is unknown");
        assert.deepEqual(ids(await plain.find(where(and()))), ["a", "b", "c"], "and() matches everything");
        assert.deepEqual(ids(await plain.find(where(or()))), [], "or() matches nothing");
      });

      it("absent and null are different", async () => {
        assert.deepEqual(ids(await plain.find(where(eq("opt", null)))), ["a"]);
        assert.deepEqual(ids(await plain.find(where(ne("opt", null)))), ["c"]);
        assert.deepEqual(ids(await plain.find(where(isDefined("opt")))), ["a", "c"]);
        assert.deepEqual(ids(await plain.find(where(not(isDefined("flag"))))), ["c"]);
        assert.deepEqual(ids(await plain.find(where(missing("opt")))), ["a", "b"]);
        assert.deepEqual(ids(await plain.find(where(present("opt")))), ["c"]);
      });

      it("strings compare ordinally (case-sensitive); nested paths work", async () => {
        assert.deepEqual(ids(await plain.find(where(lt("s", "b")))), ["a", "b"], '"Banana" < "b" < "cherry"');
        assert.deepEqual(ids(await plain.find(where(eq("state.status", "pending")))), ["a", "c"]);
        assert.deepEqual(ids(await plain.find(where(lte("state.at", 10)))), ["a"]);
      });

      it("oneOf and contains", async () => {
        assert.deepEqual(ids(await plain.find(where(oneOf("cat", ["x", "z"])))), ["a", "c"]);
        assert.deepEqual(ids(await plain.find(where(oneOf("n", [1, "3"])))), ["a", "c"]);
        assert.deepEqual(ids(await plain.find(where(contains("s", "an")))), ["b"]);
        assert.deepEqual(ids(await plain.find(where(contains("s", "AN")))), []);
        assert.deepEqual(ids(await plain.find(where(contains("s", "AN", { ignoreCase: true })))), ["b"]);
        assert.deepEqual(ids(await plain.find(where(contains("s", "PIE", { ignoreCase: true })))), ["c"]);
        assert.deepEqual(ids(await plain.find(where(contains("n", "3")))), ["c"], "contains on a number is unknown");
        assert.deepEqual(ids(await plain.find(where(contains("tags", "an")))), [], "contains does not look inside arrays");
        assert.deepEqual(ids(await plain.find(where(oneOf("cat", [])))), [], "an empty oneOf matches nothing");
        assert.deepEqual(ids(await plain.find(where(not(oneOf("cat", []))))), ["a", "b", "c"], "and its negation everything");
      });

      it("orders by one field across types; absent sorts first ascending, last descending", async () => {
        assert.deepEqual(orderedIds(await plain.find({ partitionKey: P, orderBy: { field: "n" } })), ["a", "b", "c"]);
        assert.deepEqual(
          orderedIds(await plain.find({ partitionKey: P, orderBy: { field: "n", direction: "desc" } })),
          ["c", "b", "a"],
        );
        assert.deepEqual(orderedIds(await plain.find({ partitionKey: P, orderBy: { field: "flag" } })), ["c", "b", "a"]);
        assert.deepEqual(
          orderedIds(await plain.find({ partitionKey: P, orderBy: { field: "flag", direction: "desc" } })),
          ["a", "b", "c"],
        );
        assert.deepEqual(orderedIds(await plain.find({ partitionKey: P, orderBy: { field: "state.at" } })), ["c", "a", "b"]);
        assert.deepEqual(orderedIds(await plain.find({ partitionKey: P, orderBy: { field: "opt" } })), ["b", "a", "c"], "absent < null < number");
        assert.deepEqual(
          orderedIds(await plain.find({ where: eq("tag", tag), orderBy: { field: "s", direction: "asc" } })),
          ["b", "a", "c", "d"],
        );
      });

      it("limits after ordering", async () => {
        assert.deepEqual(
          orderedIds(await plain.find({ partitionKey: P, orderBy: { field: "n", direction: "desc" }, limit: 1 })),
          ["c"],
        );
        assert.deepEqual(await plain.find({ partitionKey: P, limit: 0 }), []);
        assert.deepEqual(
          orderedIds(await plain.find({ where: eq("tag", tag), orderBy: { field: "s" }, limit: 2 })),
          ["b", "a"],
          "TOP across partitions",
        );
      });

      it("projects fields, with aliases, leaving out absent ones", async () => {
        const rows = await plain.find<Record<string, unknown>>({
          partitionKey: P,
          where: oneOf("id", ["a", "b"]),
          orderBy: { field: "n" },
          select: ["id", { field: "state.status", as: "status" }, "opt", "state.at", { field: "id", as: "again" }],
        });
        assert.deepEqual(rows, [
          { id: "a", status: "pending", opt: null, at: 10, again: "a" },
          { id: "b", status: "done", at: 20, again: "b" },
        ]);
      });

      it("rejects invalid field paths and limits with BadRequest", async () => {
        await rejectsWith(plain.find({ partitionKey: P, orderBy: { field: "bad path" } }), "BadRequest");
        await rejectsWith(plain.find({ partitionKey: P, limit: -1 }), "BadRequest");
        await rejectsWith(plain.find({ partitionKey: P, select: ["a;b"] }), "BadRequest");
        await rejectsWith(plain.find({ partitionKey: P, where: { op: "eq", field: "x]", value: 1 } }), "BadRequest");
      });
    });

    // ------------------------------------------------------------------------
    describe("large results", () => {
      it("find and count return every match, beyond any one page", async () => {
        // 120 documents in one partition (more than a 100-item page) and 30
        // in another: 150 across partitions.
        const tag = uniq();
        const [big, small] = [uniq(), uniq()];
        const docs = Array.from({ length: 150 }, (_, i) => ({ id: `d${i}`, pk: i < 120 ? big : small, tag, i }));
        for (let i = 0; i < docs.length; i += 25) {
          await Promise.all(docs.slice(i, i + 25).map((doc) => plain.create(doc)));
        }
        assert.equal((await plain.find({ where: eq("tag", tag) })).length, 150);
        assert.equal(await plain.count({ where: eq("tag", tag) }), 150);
        assert.equal((await plain.find({ partitionKey: big })).length, 120);
        assert.equal(await plain.count({ partitionKey: big }), 120);
        const ordered = await plain.find<{ i: number }>({ where: eq("tag", tag), orderBy: { field: "i" }, select: ["i"] });
        assert.deepEqual(ordered.map((r) => r.i), docs.map((d) => d.i));
      });
    });

    // ------------------------------------------------------------------------
    describe("vector search", () => {
      let search: Collection<TestDoc>;
      const V = uniq();
      const V2 = uniq();
      const tag = uniq();

      before(async () => {
        if (!adapter.capabilities.vectorSearch) return;
        search = await adapter.collection<TestDoc>(specs.search);
        await search.create({ id: "v1", pk: V, tag, kind: "a", vector: [1, 0, 0], text: "the quick brown fox" });
        await search.create({ id: "v2", pk: V, tag, kind: "b", vector: [0.9, 0.1, 0], text: "lazy dog sleeps" });
        await search.create({ id: "v3", pk: V, tag, kind: "a", vector: [0, 1, 0], text: "quick quick fox jumps" });
        await search.create({ id: "v4", pk: V, tag, kind: "b", vector: [-1, 0, 0], text: "nothing here" });
        await search.create({ id: "v5", pk: V2, tag, kind: "a", vector: [1, 0, 0], text: "elsewhere" });
        await search.create({ id: "v6", pk: V, tag, kind: "c", text: "no vector at all" });
      });

      it("returns the nearest documents by cosine similarity, best first", async (t) => {
        if (!adapter.capabilities.vectorSearch) return t.skip("adapter has no vector search");
        const results = await search.vectorSearch({ partitionKey: V, vector: [1, 0, 0], limit: 3 });
        assert.deepEqual(results.map((r) => r.document.id), ["v1", "v2", "v3"]);
        const all = await search.vectorSearch({ partitionKey: V, vector: [1, 0, 0], limit: 10 });
        assert.deepEqual(orderedIds(all.map((r) => r.document)), ["v1", "v2", "v3", "v4", "v6"], "no vector: last");
        assert.equal(all[4].score, null, "and unscored");
        assert.ok(Math.abs(results[0].score! - 1) < 1e-3);
        assert.ok(Math.abs(results[1].score! - 0.9 / Math.sqrt(0.82)) < 1e-3);
        assert.ok(Math.abs(results[2].score!) < 1e-3);
      });

      it("filters before ranking, projects, and spans partitions", async (t) => {
        if (!adapter.capabilities.vectorSearch) return t.skip("adapter has no vector search");
        const filtered = await search.vectorSearch({ partitionKey: V, where: eq("kind", "b"), vector: [1, 0, 0], limit: 10 });
        assert.deepEqual(filtered.map((r) => r.document.id), ["v2", "v4"]);
        assert.ok(Math.abs(filtered[1].score! + 1) < 1e-3, "opposite vectors score -1");
        const projected = await search.vectorSearch<{ id: string }>({ partitionKey: V, vector: [0, 1, 0], limit: 1, select: ["id"] });
        assert.deepEqual(projected.map((r) => r.document), [{ id: "v3" }]);
        const everywhere = await search.vectorSearch({ where: and(eq("tag", tag), eq("kind", "a")), vector: [1, 0, 0], limit: 10 });
        assert.deepEqual(ids(everywhere.slice(0, 2).map((r) => r.document)), ["v1", "v5"]);
      });

      it("rejects a query vector of the wrong size", async (t) => {
        if (!adapter.capabilities.vectorSearch) return t.skip("adapter has no vector search");
        await rejectsWith(search.vectorSearch({ partitionKey: V, vector: [1, 0], limit: 1 }), "BadRequest");
      });

      it("hybrid search fuses rankings by weight, in component order", async (t) => {
        if (!adapter.capabilities.hybridSearch) return t.skip("adapter has no hybrid search");
        const H = uniq();
        await search.create({ id: "words", pk: H, vector: [0, 1, 0], text: "alpha beta gamma" });
        await search.create({ id: "near", pk: H, vector: [1, 0, 0], text: "unrelated words" });
        const fullText: RankComponent = { kind: "fullText", field: "text", terms: ["alpha"] };
        const vector: RankComponent = { kind: "vector", vector: [1, 0, 0] };
        const top = async (rank: RankComponent[], weights: number[]) =>
          (await search.hybridSearch({ partitionKey: H, rank, weights, limit: 2 })).map((d) => d.id);
        assert.deepEqual(await top([fullText, vector], [2, 1]), ["words", "near"]);
        assert.deepEqual(await top([fullText, vector], [1, 2]), ["near", "words"]);
        assert.deepEqual(await top([vector, fullText], [2, 1]), ["near", "words"]);
        // (Explicit weights: with equal ones the two documents tie exactly, and ties have no defined order.)
        const limited = await search.hybridSearch({ partitionKey: H, rank: [fullText, vector], weights: [2, 1], limit: 1, select: ["id"] });
        assert.deepEqual(limited, [{ id: "words" }]);
      });

      it("hybrid search ranks tied scores densely", async (t) => {
        if (!adapter.capabilities.hybridSearch) return t.skip("adapter has no hybrid search");
        // Full text: "twice" scores highest; "tie1" and "tie2" score the same
        // (one match, same length) and share rank 2. Vector: tie2, tie1, twice.
        // Dense ranks fuse to tie2, twice, tie1; positional ranks would not.
        const H = uniq();
        await search.create({ id: "twice", pk: H, vector: [-1, 0, 0], text: "alpha alpha" });
        await search.create({ id: "tie1", pk: H, vector: [0, 1, 0], text: "alpha beta" });
        await search.create({ id: "tie2", pk: H, vector: [1, 0, 0], text: "alpha gamma" });
        const ranked = await search.hybridSearch<{ id: string }>({
          partitionKey: H,
          rank: [{ kind: "fullText", field: "text", terms: ["alpha"] }, { kind: "vector", vector: [1, 0, 0] }],
          weights: [1, 1],
          limit: 3,
          select: ["id"],
        });
        assert.deepEqual(ranked.map((r) => r.id), ["tie2", "twice", "tie1"]);
      });

      it("hybrid search ranks after a tie densely, whatever order the tie takes", async (t) => {
        if (!adapter.capabilities.hybridSearch) return t.skip("adapter has no hybrid search");
        // Full text: "top" ranks 1, four documents tie at rank 2, and "far"
        // (no match) is next: dense rank 3, but positional rank 6. Vector:
        // far, t1, t2, top, t3, t4. Fused with dense ranks: far (1/63 + 1/61),
        // t1 (1/62 + 1/62), top (1/61 + 1/64). With positional ranks "far"
        // drops to 1/66 + 1/61, below "top", however the tie is ordered.
        const H = uniq();
        const at = (degrees: number) => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180), 0];
        await search.create({ id: "top", pk: H, vector: at(60), text: "alpha alpha" });
        await search.create({ id: "t1", pk: H, vector: at(20), text: "alpha beta" });
        await search.create({ id: "t2", pk: H, vector: at(40), text: "alpha gamma" });
        await search.create({ id: "t3", pk: H, vector: at(80), text: "alpha delta" });
        await search.create({ id: "t4", pk: H, vector: at(100), text: "alpha omega" });
        await search.create({ id: "far", pk: H, vector: at(0), text: "zeta eta" });
        const ranked = await search.hybridSearch<{ id: string }>({
          partitionKey: H,
          rank: [{ kind: "fullText", field: "text", terms: ["alpha"] }, { kind: "vector", vector: [1, 0, 0] }],
          weights: [1, 1],
          limit: 3,
          select: ["id"],
        });
        assert.deepEqual(ranked.map((r) => r.id), ["far", "t1", "top"]);
      });
    });

    // ------------------------------------------------------------------------
    describe("errors", () => {
      it("are recognisable by the predicates", async () => {
        const pk = uniq();
        await plain.create({ id: "a", pk });
        await assert.rejects(plain.create({ id: "a", pk }), isConflict);
        await assert.rejects(plain.replace("x", pk, { id: "x", pk }), isNotFound);
        await assert.rejects(plain.replace("a", pk, { id: "a", pk }, { ifMatch: '"stale"' }), isPreconditionFailed);
      });
    });
  });
}
