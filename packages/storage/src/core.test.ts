import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  StorageError,
  and,
  createStorageAdapter,
  eq,
  evaluateFilter,
  getRegisteredStorageAdapters,
  isConflict,
  isNotFound,
  isPreconditionFailed,
  missing,
  mutate,
  ne,
  oneOf,
  or,
  present,
  reciprocalRankFusion,
  registerStorageAdapter,
  bm25Scores,
  cosineSimilarity,
  InMemoryStorage,
  MAX_PATCH_OPERATIONS,
  applyPatch,
  checkFilter,
  checkPatch,
  checkPatchTargets,
  checkSelection,
  denseRanks,
  fuseRanks,
  tokenize,
  isDefined,
  readField,
  type StorageAdapter,
} from "./index.js";

// -- Errors -------------------------------------------------------------------

test("errors carry a portable code and the Cosmos-style status code", () => {
  const err = new StorageError("PreconditionFailed", "stale");
  assert.equal(err.code, "PreconditionFailed");
  assert.equal(err.statusCode, 412);
  assert.ok(isPreconditionFailed(err));
  assert.ok(!isConflict(err));
  assert.equal(new StorageError("NotFound", "x").statusCode, 404);
  assert.equal(new StorageError("Conflict", "x").statusCode, 409);
  assert.equal(new StorageError("Throttled", "x").statusCode, 429);
});

test("predicates recognise a StorageError from another copy of the SDK", () => {
  const foreign = Object.assign(new Error("x"), { name: "StorageError", code: "NotFound" });
  assert.ok(isNotFound(foreign));
  assert.ok(!isNotFound(Object.assign(new Error("x"), { code: "NotFound" })), "the name must match too");
  assert.ok(!isNotFound(undefined));
});

// -- Filters ------------------------------------------------------------------

test("builders validate field paths and values", () => {
  assert.throws(() => eq("a b", 1), { code: "BadRequest" });
  assert.throws(() => eq("a..b", 1), { code: "BadRequest" });
  assert.throws(() => eq("a", undefined as never), { code: "BadRequest" });
  assert.throws(() => oneOf("a", "x" as never), { code: "BadRequest" });
  assert.deepEqual(eq("state.status", "x"), { op: "eq", field: "state.status", value: "x" });
});

test("and/or drop falsy entries so optional clauses can be inline", () => {
  const agentId: string | undefined = undefined;
  assert.deepEqual(and(eq("a", 1), agentId && eq("agentId", agentId), false, null), {
    op: "and",
    filters: [{ op: "eq", field: "a", value: 1 }],
  });
  assert.deepEqual(or(), { op: "or", filters: [] });
});

test("missing and present expand to the Cosmos IS_DEFINED/null pairs", () => {
  assert.deepEqual(missing("x"), {
    op: "or",
    filters: [{ op: "not", filter: { op: "isDefined", field: "x" } }, { op: "eq", field: "x", value: null }],
  });
  assert.deepEqual(present("x"), {
    op: "and",
    filters: [{ op: "isDefined", field: "x" }, { op: "ne", field: "x", value: null }],
  });
});

test("evaluateFilter follows three-valued logic", () => {
  assert.equal(evaluateFilter(eq("x", 1), {}), undefined);
  assert.equal(evaluateFilter(ne("x", null), { x: 0 }), true);
  assert.equal(evaluateFilter(eq("x", { a: 1, b: [2] }), { x: { b: [2], a: 1 } }), true, "key order does not matter");
  assert.equal(evaluateFilter(or(eq("x", 1), eq("y", 1)), { y: 1 }), true);
  assert.equal(evaluateFilter(or(eq("x", 1), eq("y", 1)), { y: 2 }), undefined);
  assert.equal(evaluateFilter(and(eq("x", 1), eq("y", 1)), { y: 2 }), false);
});

// -- Ranking ------------------------------------------------------------------

test("cosine similarity, BM25 and weighted RRF", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [2, 2]) - 1) < 1e-12);

  const scores = bm25Scores(["fox fox dog", "dog", "cat"], ["Fox"]);
  assert.ok(scores[0] > 0);
  assert.equal(scores[1], 0);
  assert.equal(scores[2], 0);
  // Combining marks stay inside their word (Devanagari vowel signs, accents).
  assert.deepEqual(tokenize("नमस्ते, Café-au lait!"), ["नमस्ते", "café", "au", "lait"]);
  assert.deepEqual(tokenize("cafe\u0301 42"), ["cafe\u0301", "42"]);

  assert.deepEqual(reciprocalRankFusion([["a", "b"], ["b", "a"]], [2, 1]), ["a", "b"]);
  assert.deepEqual(reciprocalRankFusion([["a", "b"], ["b", "a"]], [1, 2]), ["b", "a"]);
  assert.throws(() => reciprocalRankFusion([["a"]], [1, 2]));
});

// -- mutate -------------------------------------------------------------------

test("mutate rethrows errors other than PreconditionFailed and validates maxAttempts", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<{ id: string; pk: string }>({ name: "docs", partitionKey: "pk" });
  await docs.create({ id: "a", pk: "p" });
  await assert.rejects(mutate(docs, "a", "p", (d) => ({ ...d, pk: "other" })), { code: "BadRequest" });
  await assert.rejects(mutate(docs, "a", "p", (d) => d, { maxAttempts: 0 }), RangeError);
});

test("mutate reports notFound when the document vanishes between read and write", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<{ id: string; pk: string }>({ name: "docs", partitionKey: "pk" });
  await docs.create({ id: "a", pk: "p" });
  const result = await mutate(docs, "a", "p", async (d) => {
    await docs.delete("a", "p");
    return d;
  });
  assert.deepEqual(result, { status: "notFound" });
});

// -- Registry -----------------------------------------------------------------

test("the registry builds the in-memory adapter and registered factories", async () => {
  assert.ok(getRegisteredStorageAdapters().includes("memory"));
  const memory = await createStorageAdapter("memory");
  assert.equal(memory.name, "memory");

  let received: unknown;
  registerStorageAdapter("custom-test", (options) => {
    received = options;
    return new InMemoryStorage();
  });
  await createStorageAdapter("custom-test", { url: "x" });
  assert.deepEqual(received, { url: "x" });
});

test("unknown providers fail with the list of known ones", async () => {
  await assert.rejects(createStorageAdapter("nope"), /unknown provider "nope".*memory.*postgres/);
});

test("first-party names load their packages, or say which to install", async () => {
  // Installed (as in this monorepo), the Postgres adapter itself refuses the
  // missing connection string; not installed, the registry names the package.
  await assert.rejects(createStorageAdapter("postgres"), (err: Error) => {
    assert.match(err.message, /install @agentforeach\/storage-postgres|postgres: pass a connectionString/);
    return true;
  });
});

test("adapters load from a module path exporting storageAdapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storage-plugin-"));
  const sdk = new URL("./index.js", import.meta.url).href;
  const file = join(dir, "plugin.mjs");
  await writeFile(
    file,
    `import { InMemoryStorage } from ${JSON.stringify(sdk)};
     export const storageAdapter = {
       name: "plugin-test",
       create: (options) => Object.assign(new InMemoryStorage(), { options }),
     };`,
  );
  const adapter = (await createStorageAdapter(file, { region: "x" })) as StorageAdapter & { options: unknown };
  assert.equal(adapter.name, "memory");
  assert.deepEqual(adapter.options, { region: "x" });

  const bad = join(dir, "bad.mjs");
  await writeFile(bad, "export const nothing = 1;");
  await assert.rejects(createStorageAdapter(bad), /does not export a storage adapter/);
});

// -- Hardening (review findings) ----------------------------------------------

test("patch paths cannot reach Object.prototype", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<{ id: string; pk: string }>({ name: "docs", partitionKey: "pk" });
  await docs.create({ id: "a", pk: "p" });
  for (const path of ["/__proto__/polluted", "/constructor/prototype/polluted", "/prototype"]) {
    await assert.rejects(docs.patch("a", "p", [{ op: "set", path, value: "yes" }]), { code: "BadRequest" });
  }
  assert.throws(() => applyPatch({}, [{ op: "set", path: "/__proto__/isAdmin", value: true }]), { code: "BadRequest" });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
});

test("inherited properties are not fields", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<{ id: string; pk: string }>({ name: "docs", partitionKey: "pk" });
  await docs.create({ id: "a", pk: "p" });
  assert.equal(readField({ a: 1 }, "toString"), undefined);
  assert.throws(() => isDefined("constructor"), { code: "BadRequest" });
  await assert.rejects(docs.find({ select: ["constructor"] }), { code: "BadRequest" });
  await assert.rejects(docs.patch("a", "p", [{ op: "remove", path: "/toString" }]), { code: "BadRequest" });
  assert.equal(evaluateFilter(isDefined("hasOwnProperty"), { a: 1 }), false);
});

test("filter values must be plain, finite JSON", () => {
  for (const value of [NaN, Infinity, -Infinity, new Date(0), { a: undefined }, [1, NaN]]) {
    assert.throws(() => eq("x", value as never), { code: "BadRequest" }, String(value));
  }
  assert.throws(() => oneOf("x", [1, Infinity]), { code: "BadRequest" });
  assert.throws(() => checkFilter({ op: "lt", field: "n", value: Infinity }), { code: "BadRequest" });
  assert.doesNotThrow(() => eq("x", { a: [1, "b", null, { c: true }] }));
});

test("limits, weights and terms are validated the same for every adapter", async () => {
  const storage = new InMemoryStorage();
  const spec = {
    name: "s",
    partitionKey: "pk",
    vector: { field: "v", dimensions: 2, distance: "cosine" as const },
    fullText: { fields: ["t"], language: "en-US" },
  };
  const docs = await storage.collection(spec);
  await assert.rejects(docs.find({ limit: 1e21 }), { code: "BadRequest" });
  await assert.rejects(docs.vectorSearch({ vector: [1, 0] } as never), { code: "BadRequest" }, "limit is required");
  await assert.rejects(
    docs.hybridSearch({ rank: [{ kind: "vector", vector: [1, 0] }, { kind: "fullText", field: "t", terms: ["x"] }], weights: [Infinity, 1], limit: 1 }),
    { code: "BadRequest" },
  );
  await assert.rejects(docs.hybridSearch({ rank: [{ kind: "fullText", field: "t", terms: [] }], limit: 1 }), { code: "BadRequest" });
  await assert.rejects(docs.hybridSearch({ rank: [{ kind: "fullText", field: "t", terms: [""] }], limit: 1 }), { code: "BadRequest" });
});

test("projection keys: identifiers, not reserved words, not repeated", () => {
  for (const select of [[{ field: "a", as: "a b" }], [{ field: "a", as: "" }], ["value"], [{ field: "a", as: "__proto__" }], ["n", { field: "id", as: "n" }]]) {
    assert.throws(() => checkSelection(select as never), { code: "BadRequest" }, JSON.stringify(select));
  }
  assert.doesNotThrow(() => checkSelection(["id", { field: "state.status", as: "status" }]));
});

test("checkPatch: known ops, member paths, JSON values, at most MAX_PATCH_OPERATIONS", () => {
  const set = (path: string, value: unknown = 1) => ({ op: "set", path, value }) as never;
  assert.throws(() => checkPatch([]), { code: "BadRequest" });
  assert.throws(() => checkPatch([{ op: "replace", path: "/a", value: 1 } as never]), { code: "BadRequest" });
  assert.throws(() => checkPatch([{ op: "move", from: "/a", path: "/b" } as never]), { code: "BadRequest" });
  for (const path of ["a", "/", "/a//b", "/list/0", "/list/-", "/a~1b"]) {
    assert.throws(() => checkPatch([set(path)]), { code: "BadRequest" }, path);
  }
  assert.throws(() => checkPatch([set("/a", 1n)]), { code: "BadRequest" }, "values must be JSON-serializable");
  assert.throws(() => checkPatch([{ op: "incr", path: "/a", value: Infinity }]), { code: "BadRequest" });
  assert.throws(() => checkPatch(Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, () => set("/a"))), { code: "BadRequest" });
  assert.doesNotThrow(() => checkPatch([set("/data/favorite-color", "blue"), { op: "remove", path: "/x" }]));
});

test("incr results must stay finite", () => {
  assert.throws(() => applyPatch({ n: Number.MAX_VALUE }, [{ op: "incr", path: "/n", value: Number.MAX_VALUE }]), { code: "BadRequest" });
});

test("documents that are not JSON are BadRequest, not a TypeError", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<{ id: string; pk: string; [k: string]: unknown }>({ name: "docs", partitionKey: "pk" });
  const circular: Record<string, unknown> = { id: "a", pk: "p" };
  circular.self = circular;
  await assert.rejects(docs.create(circular as never), { code: "BadRequest" });
  await assert.rejects(docs.create({ id: "b", pk: "p", big: 1n } as never), { code: "BadRequest" });
});

test("dense ranks share ties; fuseRanks applies weighted RRF over them", () => {
  assert.deepEqual(denseRanks([0.5, 0, 0, 0.9]), [2, 3, 3, 1]);
  // twice / tie1 / tie2 from the conformance case: text [2, 1, 1], vector [-1, 0, 1].
  assert.deepEqual(fuseRanks([[2, 1, 1], [-1, 0, 1]], [1, 1]), [2, 0, 1]);
  assert.throws(() => fuseRanks([[1]], [1, 2]));
});

test("registry: inherited names are unknown providers; memory takes options; file: paths resolve from cwd", async () => {
  await assert.rejects(createStorageAdapter("constructor"), /unknown provider "constructor"/);
  let clock = 0;
  const storage = await createStorageAdapter("memory", { now: () => clock });
  const docs = await storage.collection({ name: "t", partitionKey: "pk", defaultTtl: 1 });
  await docs.create({ id: "a", pk: "p" });
  clock = 1_000;
  assert.equal(await docs.read("a", "p"), null, "the injected clock drives TTL");

  const dir = await mkdtemp(join(tmpdir(), "storage-file-"));
  const sdk = new URL("./index.js", import.meta.url).href;
  await writeFile(join(dir, "p.mjs"), `import { InMemoryStorage } from ${JSON.stringify(sdk)}; export default { name: "f", create: () => new InMemoryStorage() };`);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const adapter = await createStorageAdapter("file:./p.mjs");
    assert.equal(adapter.name, "memory");
  } finally {
    process.chdir(cwd);
  }
});

// -- Re-review findings ---------------------------------------------------------

test("registry: plugins resolve from the app directory with ESM conditions (ESM-only and dual packages)", async () => {
  const app = await mkdtemp(join(tmpdir(), "storage-app-"));
  const sdk = new URL("./index.js", import.meta.url).href;
  const plugin = (flavour: string) =>
    `import { InMemoryStorage } from ${JSON.stringify(sdk)}; export const storageAdapter = { name: "x", create: () => Object.assign(new InMemoryStorage(), { flavour: ${JSON.stringify(flavour)} }) };`;
  const install = async (name: string, manifest: object, files: Record<string, string>) => {
    const root = join(app, "node_modules", ...name.split("/"));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name, ...manifest }));
    for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
  };
  await install("@acme/esmonly", { type: "module", exports: { import: "./esm.js" } }, { "esm.js": plugin("esm-only") });
  await install("@acme/dual", { exports: { require: "./cjs.cjs", import: "./esm.mjs" } }, {
    "esm.mjs": plugin("dual-esm"),
    "cjs.cjs": "module.exports = { storageAdapter: { name: 'x', create: () => ({ flavour: 'dual-cjs' }) } };",
  });
  await install("@acme/nested", { exports: { ".": { node: { import: "./n.mjs" }, default: "./nope.mjs" } } }, { "n.mjs": plugin("nested") });
  await install("plainmain", { type: "module", main: "main.js" }, { "main.js": plugin("main") });

  const cwd = process.cwd();
  process.chdir(app);
  try {
    const flavour = async (name: string) => ((await createStorageAdapter(name)) as unknown as { flavour: string }).flavour;
    assert.equal(await flavour("@acme/esmonly"), "esm-only");
    assert.equal(await flavour("@acme/dual"), "dual-esm", "the ESM build of a dual package");
    assert.equal(await flavour("@acme/nested"), "nested");
    assert.equal(await flavour("plainmain/main.js"), "main");
  } finally {
    process.chdir(cwd);
  }
});

test("registry: percent-encoded file: URLs resolve against the working directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "storage-enc-"));
  const dir = join(base, "my dir");
  await mkdir(dir);
  const sdk = new URL("./index.js", import.meta.url).href;
  await writeFile(join(dir, "plugin.mjs"), `import { InMemoryStorage } from ${JSON.stringify(sdk)}; export default { name: "e", create: () => new InMemoryStorage() };`);
  const cwd = process.cwd();
  process.chdir(base);
  try {
    assert.equal((await createStorageAdapter("file:./my%20dir/plugin.mjs")).name, "memory");
    assert.equal((await createStorageAdapter("./my dir/plugin.mjs")).name, "memory");
  } finally {
    process.chdir(cwd);
  }
});

test("system fields cannot be filtered, ordered or projected", async () => {
  for (const field of ["_etag", "_ts", "_rid", "_self", "_attachments", "_lsn", "_ts.x"]) {
    assert.throws(() => eq(field, 1), { code: "BadRequest" }, field);
  }
  const storage = new InMemoryStorage();
  const docs = await storage.collection({ name: "d", partitionKey: "pk" });
  await assert.rejects(docs.find({ select: ["_ts"] }), { code: "BadRequest" });
  await assert.rejects(docs.find({ orderBy: { field: "_etag" } }), { code: "BadRequest" });
  assert.doesNotThrow(() => eq("_custom", 1), "other underscore names are ordinary fields");
});

test("patch set values follow document-write rules; id and partition key are refused up front", async () => {
  const storage = new InMemoryStorage();
  const docs = await storage.collection<{ id: string; tenant: { id: string }; [k: string]: unknown }>({ name: "d", partitionKey: "tenant.id" });
  await docs.create({ id: "a", tenant: { id: "t" } });
  const patched = await docs.patch("a", "t", [{ op: "set", path: "/o", value: { k: 1, opt: undefined } as never }]);
  assert.deepEqual(patched.o, { k: 1 }, "undefined members vanish, as in create");
  await assert.rejects(docs.patch("a", "t", [{ op: "set", path: "/o", value: undefined as never }]), { code: "BadRequest" });
  for (const path of ["/id", "/tenant", "/tenant/id"]) {
    assert.throws(() => checkPatchTargets(docs.spec, [{ op: "set", path, value: "x" }]), { code: "BadRequest" }, path);
  }
  assert.doesNotThrow(() => checkPatchTargets(docs.spec, [{ op: "set", path: "/tenant/name", value: "x" }]));
  // A malformed patch is BadRequest even when the document is missing (as on Cosmos).
  await assert.rejects(docs.patch("missing", "t", [{ op: "set", path: "/list/0", value: 1 }]), { code: "BadRequest" });
});
