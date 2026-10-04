/**
 * The adapter's plumbing against a recording stand-in for @azure/cosmos:
 * which SDK calls it makes, with which options, and how Cosmos errors come
 * back. (Behaviour against a real account is the conformance suite's job:
 * see live.test.ts.)
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { CosmosClient } from "@azure/cosmos";
import { and, createStorageAdapter, eq, isConflict, isPreconditionFailed, isThrottled, registerStorageAdapter } from "@agentforeach/storage";
import { CosmosStorage, storageAdapter } from "./adapter.js";

type Call = { op: string; args: unknown[] };

function cosmosError(code: number): Error {
  return Object.assign(new Error(`cosmos ${code}`), { code, statusCode: code });
}

/** A container whose every call is recorded and answered by `respond`. */
function stubContainer(respond: (call: Call) => unknown = () => ({ resource: { id: "a", pk: "p", _etag: '"e1"' } })) {
  const calls: Call[] = [];
  const answer = async (op: string, ...args: unknown[]) => {
    const call = { op, args };
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return result;
  };
  const container = {
    item: (id: string, pk: string) => ({
      read: () => answer("read", id, pk),
      replace: (body: unknown, options?: unknown) => answer("replace", id, pk, body, options),
      patch: (ops: unknown, options?: unknown) => answer("patch", id, pk, ops, options),
      delete: (options?: unknown) => answer("delete", id, pk, options),
    }),
    items: {
      create: (body: unknown) => answer("create", body),
      upsert: (body: unknown) => answer("upsert", body),
      query: (spec: unknown, options?: unknown) => ({ fetchAll: () => answer("query", spec, options) }),
    },
    read: () => answer("readContainer"),
  };
  return { container, calls };
}

/** A client whose database hands out the stub container. */
function stubClient(container: unknown) {
  const calls: Call[] = [];
  const database = {
    containers: {
      createIfNotExists: async (definition: unknown) => {
        calls.push({ op: "createContainer", args: [definition] });
        return { container };
      },
    },
    container: (id: string) => {
      calls.push({ op: "container", args: [id] });
      return container;
    },
  };
  const client = {
    databases: {
      createIfNotExists: async (body: unknown) => {
        calls.push({ op: "createDatabase", args: [body] });
        return { database };
      },
    },
    database: (id: string) => {
      calls.push({ op: "database", args: [id] });
      return database;
    },
  };
  return { client: client as unknown as CosmosClient, calls };
}

const spec = { name: "docs", partitionKey: "pk" };

async function collection(respond?: (call: Call) => unknown, options: { provisionContainers?: boolean } = {}) {
  const { container, calls } = stubContainer(respond);
  const { client, calls: clientCalls } = stubClient(container);
  const storage = new CosmosStorage({ client, ...options });
  return { docs: await storage.collection<{ id: string; pk: string; [k: string]: unknown }>(spec), calls, clientCalls, storage };
}

test("read: a missing item (no resource, or a thrown 404) is null; other errors propagate", async () => {
  assert.equal(await (await collection(() => ({ resource: undefined }))).docs.read("a", "p"), null);
  assert.equal(await (await collection(() => cosmosError(404))).docs.read("a", "p"), null);
  await assert.rejects((await collection(() => cosmosError(500))).docs.read("a", "p"), /cosmos 500/);
  const { docs, calls } = await collection();
  assert.deepEqual(await docs.read("a", "p"), { id: "a", pk: "p", _etag: '"e1"' });
  assert.deepEqual(calls[0], { op: "read", args: ["a", "p"] });
});

test("writes send the document without system fields or undefined values", async () => {
  const { docs, calls } = await collection();
  await docs.create({ id: "a", pk: "p", _etag: '"old"', _ts: 1, _rid: "r", gone: undefined, keep: 1 });
  await docs.upsert({ id: "a", pk: "p", _self: "s", keep: 2 });
  assert.deepEqual(calls.map((c) => c.args[0]), [{ id: "a", pk: "p", keep: 1 }, { id: "a", pk: "p", keep: 2 }]);
});

test("create: a 409 becomes Conflict, keeping the Cosmos error as the cause", async () => {
  const original = cosmosError(409);
  const { docs } = await collection(() => original);
  await assert.rejects(docs.create({ id: "a", pk: "p" }), (err: Error & { cause?: unknown }) => {
    assert.ok(isConflict(err));
    assert.equal(err.cause, original);
    return true;
  });
});

test("replace, patch and delete pass ifMatch as an IfMatch access condition", async () => {
  const { docs, calls } = await collection();
  await docs.replace("a", "p", { id: "a", pk: "p" }, { ifMatch: '"e1"' });
  await docs.replace("a", "p", { id: "a", pk: "p" });
  await docs.patch("a", "p", [{ op: "incr", path: "/n", value: 1 }], { ifMatch: '"e1"' });
  await docs.delete("a", "p", { ifMatch: '"e1"' });
  const ifMatch = { accessCondition: { type: "IfMatch", condition: '"e1"' } };
  assert.deepEqual(calls[0].args.slice(3), [ifMatch]);
  assert.deepEqual(calls[1].args.slice(3), [undefined]);
  assert.deepEqual(calls[2].args.slice(2), [[{ op: "incr", path: "/n", value: 1 }], ifMatch]);
  assert.deepEqual(calls[3].args.slice(2), [ifMatch]);
});

test("replace checks the body's id and partition key before calling Cosmos", async () => {
  const { docs, calls } = await collection();
  await assert.rejects(docs.replace("a", "p", { id: "b", pk: "p" }), { code: "BadRequest" });
  await assert.rejects(docs.replace("a", "p", { id: "a", pk: "q" }), { code: "BadRequest" });
  await assert.rejects(docs.patch("a", "p", []), { code: "BadRequest" });
  assert.equal(calls.length, 0);
});

test("412 is PreconditionFailed, 429 is Throttled; delete of a missing item is false", async () => {
  await assert.rejects((await collection(() => cosmosError(412))).docs.replace("a", "p", { id: "a", pk: "p" }, { ifMatch: "x" }), isPreconditionFailed);
  await assert.rejects((await collection(() => cosmosError(412))).docs.delete("a", "p", { ifMatch: "x" }), isPreconditionFailed);
  await assert.rejects((await collection(() => cosmosError(429))).docs.upsert({ id: "a", pk: "p" }), isThrottled);
  assert.equal(await (await collection(() => cosmosError(404))).docs.delete("a", "p"), false);
  assert.equal(await (await collection(() => ({}))).docs.delete("a", "p"), true);
});

test("queries are partition-scoped through the SDK option, or cross-partition without it", async () => {
  const { docs, calls } = await collection(() => ({ resources: [{ id: "a" }] }));
  assert.deepEqual(await docs.find({ partitionKey: "p", where: eq("n", 1), limit: 5 }), [{ id: "a" }]);
  await docs.find({ where: eq("n", 1) });
  assert.deepEqual(calls[0].args, [
    { query: "SELECT TOP 5 * FROM c WHERE c.n = @n", parameters: [{ name: "@n", value: 1 }] },
    { partitionKey: "p" },
  ]);
  assert.deepEqual(calls[1].args[1], undefined);
  assert.deepEqual(await docs.find({ partitionKey: "p", limit: 0 }), []);
  assert.equal(calls.length, 2, "limit 0 never reaches Cosmos");
});

test("count, vector search and hybrid search are partition-scoped the same way", async () => {
  const searchSpec = {
    name: "search",
    partitionKey: "pk",
    vector: { field: "v", dimensions: 2, distance: "cosine" as const },
    fullText: { fields: ["t"], language: "en-US" },
  };
  const { container, calls } = stubContainer(() => ({ resources: [] }));
  const storage = new CosmosStorage({ client: stubClient(container).client });
  const search = await storage.collection(searchSpec);
  await search.count({ partitionKey: "p" });
  await search.vectorSearch({ partitionKey: "p", vector: [1, 0], limit: 1 });
  await search.hybridSearch({ partitionKey: "p", rank: [{ kind: "fullText", field: "t", terms: ["x"] }], limit: 1 });
  await search.count();
  await search.vectorSearch({ vector: [1, 0], limit: 1 });
  await search.hybridSearch({ rank: [{ kind: "fullText", field: "t", terms: ["x"] }], limit: 1 });
  // Hybrid search forces the query plan: with only a partition key, the SDK
  // skips it and Cosmos returns the documents unranked (seen on a live account).
  assert.deepEqual(calls.map((c) => c.args[1]), [
    { partitionKey: "p" },
    { partitionKey: "p" },
    { partitionKey: "p", forceQueryPlan: true },
    undefined,
    undefined,
    { forceQueryPlan: true },
  ]);
});

test("hybrid search pins its partition in the WHERE clause (the SDK's ranked pipeline fans out)", async () => {
  const searchSpec = {
    name: "search",
    partitionKey: "userId",
    vector: { field: "v", dimensions: 2, distance: "cosine" as const },
    fullText: { fields: ["t"], language: "en-US" },
  };
  const { container, calls } = stubContainer(() => ({ resources: [] }));
  const search = await new CosmosStorage({ client: stubClient(container).client }).collection(searchSpec);
  const rank = [{ kind: "fullText" as const, field: "t", terms: ["x"] }];
  await search.hybridSearch({ partitionKey: "u1", rank, limit: 1 });
  await search.hybridSearch({ partitionKey: "u1", where: eq("cat", "a"), rank, limit: 1 });
  await search.hybridSearch({ partitionKey: "u1", where: and(eq("userId", "u1"), eq("cat", "a")), rank, limit: 1 });
  await search.hybridSearch({ where: eq("cat", "a"), rank, limit: 1 });
  const queries = calls.map((c) => (c.args[0] as { query: string }).query.replace(/ ORDER BY .*/, ""));
  assert.deepEqual(queries, [
    "SELECT TOP 1 * FROM c WHERE c.userId = @userId",
    "SELECT TOP 1 * FROM c WHERE c.userId = @userId AND c.cat = @cat",
    "SELECT TOP 1 * FROM c WHERE c.userId = @userId AND c.cat = @cat",
    "SELECT TOP 1 * FROM c WHERE c.cat = @cat",
  ]);
});

test("Cosmos system fields other than _etag are stripped from every returned document", async () => {
  const system = { _rid: "r", _self: "s", _ts: 1, _attachments: "a", _etag: '"e"' };
  const stored = { id: "a", pk: "p", n: 1, ...system };
  const { docs } = await collection((call) =>
    call.op === "query" ? { resources: [stored] } : call.op === "delete" ? {} : { resource: stored },
  );
  const expected = { id: "a", pk: "p", n: 1, _etag: '"e"' };
  assert.deepEqual(await docs.read("a", "p"), expected);
  assert.deepEqual(await docs.create({ id: "a", pk: "p" }), expected);
  assert.deepEqual(await docs.upsert({ id: "a", pk: "p" }), expected);
  assert.deepEqual(await docs.replace("a", "p", { id: "a", pk: "p" }), expected);
  assert.deepEqual(await docs.patch("a", "p", [{ op: "set", path: "/n", value: 1 }]), expected);
  assert.deepEqual(await docs.find({ partitionKey: "p" }), [expected]);
  // Projections return exactly what was selected.
  assert.deepEqual(await docs.find({ partitionKey: "p", select: ["id"] }), [stored]);
});

test("invalid patches are refused before reaching Cosmos", async () => {
  const { docs, calls } = await collection();
  await assert.rejects(docs.patch("a", "p", [{ op: "replace", path: "/a", value: 1 } as never]), { code: "BadRequest" });
  await assert.rejects(docs.patch("a", "p", [{ op: "set", path: "/list/0", value: 1 }]), { code: "BadRequest" });
  await assert.rejects(docs.patch("a", "p", [{ op: "set", path: "/__proto__/x", value: 1 }]), { code: "BadRequest" });
  const ops = Array.from({ length: 11 }, () => ({ op: "incr" as const, path: "/n", value: 1 }));
  await assert.rejects(docs.patch("a", "p", ops), { code: "BadRequest" });
  await assert.rejects(docs.patch("a", "p", [{ op: "set", path: "/id", value: "b" }]), { code: "BadRequest" });
  await assert.rejects(docs.patch("a", "p", [{ op: "set", path: "/pk", value: "q" }]), { code: "BadRequest" });
  assert.equal(calls.length, 0);
});

test("a 404 in string form (code: 'NotFound') is still a missing item", async () => {
  const notFound = () => Object.assign(new Error("gone"), { code: "NotFound" });
  assert.equal(await (await collection(notFound)).docs.read("a", "p"), null);
  assert.equal(await (await collection(notFound)).docs.delete("a", "p"), false);
});

test("close() disposes only a client the adapter created", async () => {
  let disposed = 0;
  const { client } = stubClient({});
  (client as unknown as { dispose: () => void }).dispose = () => {
    disposed++;
  };
  await new CosmosStorage({ client }).close();
  assert.equal(disposed, 0, "a client passed in belongs to the caller");
  const own = new CosmosStorage({ endpoint: "https://x.documents.azure.com:443/", key: "a2V5" });
  let ownDisposed = 0;
  (own.getClient() as unknown as { dispose: () => void }).dispose = () => {
    ownDisposed++;
  };
  await own.close();
  assert.equal(ownDisposed, 1);
});

test("count reads the single VALUE, defaulting to 0", async () => {
  assert.equal(await (await collection(() => ({ resources: [7] }))).docs.count({ partitionKey: "p" }), 7);
  assert.equal(await (await collection(() => ({ resources: [] }))).docs.count(), 0);
});

test("vector search rows become { document, score }; a row without a score gets null", async () => {
  const unscored = stubContainer(() => ({ resources: [{ document: { id: "n", pk: "p" } }] }));
  const vecs0 = await new CosmosStorage({ client: stubClient(unscored.container).client }).collection({
    name: "v0",
    partitionKey: "pk",
    vector: { field: "v", dimensions: 2, distance: "cosine" },
  });
  assert.deepEqual(await vecs0.vectorSearch({ vector: [1, 0], limit: 1 }), [{ document: { id: "n", pk: "p" }, score: null }]);

  const vectorSpec = { name: "vecs", partitionKey: "pk", vector: { field: "v", dimensions: 2, distance: "cosine" as const } };
  const rows = [{ document: { id: "a", pk: "p", v: [1, 0] }, vectorDistance: 0.9 }];
  const { container } = stubContainer(() => ({ resources: rows }));
  const storage = new CosmosStorage({ client: stubClient(container).client });
  const vecs = await storage.collection(vectorSpec);
  assert.deepEqual(await vecs.vectorSearch({ vector: [1, 0], limit: 1 }), [{ document: rows[0].document, score: 0.9 }]);

  const projected = stubContainer(() => ({ resources: [{ id: "a", vectorDistance: 0.5 }] }));
  const storage2 = new CosmosStorage({ client: stubClient(projected.container).client });
  const vecs2 = await storage2.collection(vectorSpec);
  assert.deepEqual(await vecs2.vectorSearch({ vector: [1, 0], limit: 1, select: ["id"] }), [{ document: { id: "a" }, score: 0.5 }]);
});

test("provisioning creates the database and the container from the spec, once", async () => {
  const { storage, clientCalls } = await collection();
  await storage.collection(spec);
  assert.deepEqual(clientCalls, [
    { op: "createDatabase", args: [{ id: "agentforeach" }] },
    { op: "createContainer", args: [{ id: "docs", partitionKey: { paths: ["/pk"], kind: "Hash", version: 2 }, indexingPolicy: {
      automatic: true, indexingMode: "consistent", includedPaths: [{ path: "/*" }], excludedPaths: [{ path: '/"_etag"/?' }],
    } }] },
  ]);
});

test("without provisioning, containers are only referenced: no control-plane calls", async () => {
  const { clientCalls, calls } = await collection(undefined, { provisionContainers: false });
  assert.deepEqual(clientCalls, [
    { op: "database", args: ["agentforeach"] },
    { op: "container", args: ["docs"] },
  ]);
  assert.equal(calls.length, 0);
});

test("verifyPartitionKey reads the container once and refuses a mismatch", async () => {
  const verified = { ...spec, adapterOptions: { cosmosdb: { verifyPartitionKey: true } } };
  const ok = stubContainer(() => ({ resource: { partitionKey: { paths: ["/pk"] } } }));
  const storage = new CosmosStorage({ client: stubClient(ok.container).client, provisionContainers: false });
  await storage.collection(verified);
  assert.deepEqual(ok.calls.map((c) => c.op), ["readContainer"]);

  const wrong = stubContainer(() => ({ resource: { partitionKey: { paths: ["/userId"] } } }));
  const storage2 = new CosmosStorage({ client: stubClient(wrong.container).client, provisionContainers: false });
  await assert.rejects(storage2.collection(verified), /partitioned on \/userId, expected \/pk/);
  // A failed open is not cached: a later call tries again.
  await assert.rejects(storage2.collection(verified), /partitioned on/);
  assert.equal(wrong.calls.length, 2);
});

test("verifyPartitionKey also checks an existing container when provisioning, from the createIfNotExists response", async () => {
  const verified = { ...spec, adapterOptions: { cosmosdb: { verifyPartitionKey: true } } };
  const client = (paths: string[]) => {
    const { client } = stubClient({});
    const database = { containers: { createIfNotExists: async () => ({ container: {}, resource: { partitionKey: { paths } } }) } };
    (client as unknown as { databases: unknown }).databases = { createIfNotExists: async () => ({ database }) };
    return client;
  };
  await new CosmosStorage({ client: client(["/pk"]) }).collection(verified);
  await assert.rejects(new CosmosStorage({ client: client(["/sessionId"]) }).collection(verified), /partitioned on \/sessionId, expected \/pk/);
  // Without the option nothing is checked.
  await new CosmosStorage({ client: client(["/sessionId"]) }).collection(spec);
});

test("construction needs a key, a credential or a client; capabilities can be narrowed", () => {
  assert.throws(() => new CosmosStorage({}), /endpoint is required/);
  assert.throws(() => new CosmosStorage({ endpoint: "https://x.documents.azure.com:443/" }), /key or an Entra ID credential/);
  const storage = new CosmosStorage({ client: stubClient({}).client, capabilities: { hybridSearch: false } });
  assert.deepEqual(storage.capabilities, { vectorSearch: true, hybridSearch: false });
  assert.equal(storage.name, "cosmosdb");
});

test("the plugin builds the adapter through the SDK registry", async () => {
  registerStorageAdapter("cosmosdb-test", storageAdapter.create);
  const adapter = await createStorageAdapter("cosmosdb-test", { client: stubClient({}).client, databaseId: "db" });
  assert.ok(adapter instanceof CosmosStorage);
  assert.equal((adapter as CosmosStorage).getDatabaseId(), "db");
});
