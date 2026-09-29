import test from "node:test";
import assert from "node:assert/strict";

import {
  CosmosLikeError,
  InMemoryCosmosDatabase,
  UnsupportedQueryError,
  runQuery,
} from "./in-memory-cosmos.js";

type Doc = { id: string; userId: string; [key: string]: unknown };

async function container() {
  const db = new InMemoryCosmosDatabase();
  return db.getOrCreateContainer<Doc>({ id: "docs", partitionKey: { paths: ["/userId"] } });
}

test("documents are partitioned: one id can live in two partitions", async () => {
  const docs = await container();
  await docs.create({ id: "1", userId: "alice", n: 1 });
  await docs.create({ id: "1", userId: "bob", n: 2 });
  assert.equal((await docs.read("1", "alice"))?.n, 1);
  assert.equal((await docs.read("1", "bob"))?.n, 2);
  assert.equal(await docs.read("1", "carol"), null);
  assert.equal(await docs.count(), 2);
});

test("errors look like Cosmos errors: 409 on duplicate create, 404 on missing replace", async () => {
  const docs = await container();
  await docs.create({ id: "1", userId: "alice" });
  await assert.rejects(docs.create({ id: "1", userId: "alice" }), { code: 409, statusCode: 409 });
  await assert.rejects(docs.replace("2", "alice", { id: "2", userId: "alice" }), { code: 404 });
  assert.equal(await docs.delete("2", "alice"), false);
  assert.equal(await docs.delete("1", "alice"), true);
});

test("raw item.read of a missing item resolves with no resource, like the SDK", async () => {
  const docs = await container();
  const { resource, statusCode } = await docs.getRawContainer().item("nope", "alice").read();
  assert.equal(resource, undefined);
  assert.equal(statusCode, 404);
});

test("every write gets a new _etag and IfMatch with a stale etag fails with 412", async () => {
  const docs = await container();
  const raw = docs.getRawContainer();
  const created = await docs.create({ id: "1", userId: "alice", v: 1 });
  const etag = created._etag as string;
  assert.match(etag, /^".+"$/);

  const { resource: replaced } = await raw
    .item("1", "alice")
    .replace<Doc>({ id: "1", userId: "alice", v: 2 }, { accessCondition: { type: "IfMatch", condition: etag } });
  assert.notEqual(replaced?._etag, etag);

  await assert.rejects(
    raw.item("1", "alice").replace({ id: "1", userId: "alice", v: 3 }, {
      accessCondition: { type: "IfMatch", condition: etag },
    }),
    (err: unknown) => err instanceof CosmosLikeError && err.code === 412,
  );
  assert.equal((await docs.read("1", "alice"))?.v, 2);
});

test("stored documents are JSON copies: undefined fields vanish, callers can't mutate storage", async () => {
  const docs = await container();
  const input = { id: "1", userId: "alice", gone: undefined, nested: { a: 1 } };
  await docs.create(input);
  input.nested.a = 99;
  const stored = await docs.read("1", "alice");
  assert.equal("gone" in stored!, false);
  assert.deepEqual(stored!.nested, { a: 1 });
});

test("replace refuses a body whose partition key differs from the request", async () => {
  const docs = await container();
  await docs.create({ id: "1", userId: "alice" });
  await assert.rejects(docs.replace("1", "alice", { id: "1", userId: "bob" }), { code: 400 });
});

test("patch applies set / incr / remove", async () => {
  const docs = await container();
  await docs.create({ id: "1", userId: "alice", n: 1, gone: true, state: { a: 1 } });
  const patched = await docs.patch("1", "alice", [
    { op: "incr", path: "/n", value: 2 },
    { op: "set", path: "/state/b", value: "x" },
    { op: "remove", path: "/gone" },
  ]);
  assert.equal(patched.n, 3);
  assert.deepEqual(patched.state, { a: 1, b: "x" });
  assert.equal("gone" in patched, false);
});

test("partition-scoped queries only see their partition", async () => {
  const docs = await container();
  await docs.create({ id: "1", userId: "alice" });
  await docs.create({ id: "2", userId: "bob" });
  const scoped = await docs.query({ query: "SELECT * FROM c" }, { partitionKey: "alice" });
  assert.deepEqual(scoped.map((d) => d.id), ["1"]);
  assert.equal((await docs.query({ query: "SELECT * FROM c" })).length, 2);
});

test("container TTL hides expired documents", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const db = new InMemoryCosmosDatabase();
  const docs = await db.getOrCreateContainer<Doc>({
    id: "ttl",
    partitionKey: { paths: ["/userId"] },
    defaultTtl: 60,
  });
  await docs.create({ id: "short", userId: "u" });
  await docs.create({ id: "forever", userId: "u", ttl: -1 });
  t.mock.timers.tick(61_000);
  assert.equal(await docs.read("short", "u"), null);
  assert.ok(await docs.read("forever", "u"));
});

test("beforeOperation hooks can inject faults", async () => {
  const docs = await container();
  const remove = docs.raw.beforeOperation(({ op }) => {
    if (op === "create") throw new CosmosLikeError(503, "Service Unavailable");
  });
  await assert.rejects(docs.create({ id: "1", userId: "alice" }), { code: 503 });
  remove();
  await docs.create({ id: "1", userId: "alice" });
});

// -- SQL evaluator -----------------------------------------------------------

const rows = [
  { id: "a", n: 3, s: "x", flag: true, tags: ["red"], state: { next: 30 } },
  { id: "b", n: 1, s: "y", flag: false, tags: [], state: { next: null } },
  { id: "c", s: "z", state: {} },
  { id: "d", n: 2, s: "x", runningToken: "t", state: { next: 10 } },
];

const ids = (result: unknown[]) => result.map((r) => (r as { id: string }).id);

test("WHERE: comparisons, AND/OR/NOT and IS_DEFINED with parameters", () => {
  assert.deepEqual(
    ids(runQuery({ query: "SELECT * FROM c WHERE c.n >= @min AND c.s = 'x'", parameters: [{ name: "@min", value: 2 }] }, rows)),
    ["a", "d"],
  );
  assert.deepEqual(
    ids(runQuery({ query: "SELECT * FROM c WHERE NOT IS_DEFINED(c.runningToken) OR c.runningToken = null" }, rows)),
    ["a", "b", "c"],
  );
  assert.deepEqual(ids(runQuery({ query: "SELECT * FROM c WHERE c.flag = true" }, rows)), ["a"]);
  assert.deepEqual(ids(runQuery({ query: 'SELECT * FROM c WHERE ARRAY_CONTAINS(c.tags, "red")' }, rows)), ["a"]);
  assert.deepEqual(ids(runQuery({ query: "SELECT * FROM c WHERE (c.n % 2) = 0" }, rows)), ["d"]);
});

test("WHERE: undefined never matches; cross-type equality is false, ordering is undefined", () => {
  // c.n is missing on "c": neither n < 5 nor NOT (n < 5) holds.
  assert.deepEqual(ids(runQuery({ query: "SELECT * FROM c WHERE c.n < 5" }, rows)), ["a", "b", "d"]);
  assert.deepEqual(ids(runQuery({ query: "SELECT * FROM c WHERE NOT (c.n < 5)" }, rows)), []);
  // A number is != null (the stores filter with `x != null`).
  assert.deepEqual(
    ids(runQuery({ query: "SELECT * FROM c WHERE IS_DEFINED(c.state.next) AND c.state.next != null" }, rows)),
    ["a", "d"],
  );
  assert.deepEqual(ids(runQuery({ query: "SELECT * FROM c WHERE c.s < 5" }, rows)), []);
});

test("ORDER BY sorts by type then value, keeping undefined first; TOP limits after ordering", () => {
  assert.deepEqual(ids(runQuery({ query: "SELECT * FROM c ORDER BY c.state.next ASC" }, rows)), ["c", "b", "d", "a"]);
  assert.deepEqual(ids(runQuery({ query: "SELECT TOP 2 * FROM c ORDER BY c.n DESC" }, rows)), ["a", "d"]);
  assert.deepEqual(
    ids(runQuery({ query: "SELECT TOP @k * FROM c ORDER BY c.n", parameters: [{ name: "@k", value: 1 }] }, rows)),
    ["c"],
  );
});

test("projections: fields with aliases, VALUE expressions and VALUE COUNT(1)", () => {
  assert.deepEqual(runQuery({ query: "SELECT TOP 1 c.id, c.id AS key, c.state.next AS next FROM c WHERE c.n = 3" }, rows), [
    { id: "a", key: "a", next: 30 },
  ]);
  assert.deepEqual(runQuery({ query: "SELECT VALUE c.n FROM c WHERE IS_NUMBER(c.n)" }, rows), [3, 1, 2]);
  assert.deepEqual(runQuery({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.s = 'x'" }, rows), [2]);
});

test("queries outside the implemented subset fail loudly", () => {
  for (const query of [
    "SELECT * FROM c OFFSET 0 LIMIT 10",
    "SELECT * FROM c JOIN t IN c.tags",
    "SELECT * FROM c WHERE STARTSWITH(c.s, 'x')",
    "SELECT * FROM c WHERE c.s IN ('x', 'y')",
    "SELECT DISTINCT c.s FROM c",
    "SELECT * FROM c ORDER BY c.s, c.n",
    "SELECT * FROM c WHERE d.n = 1",
  ]) {
    assert.throws(() => runQuery({ query }, rows), UnsupportedQueryError, query);
  }
});
