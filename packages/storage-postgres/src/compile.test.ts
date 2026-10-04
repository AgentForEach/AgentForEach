import test from "node:test";
import assert from "node:assert/strict";

import { StorageError, and, contains, eq, gt, isDefined, lte, missing, ne, not, oneOf, or } from "@agentforeach/storage";
import {
  compileCount,
  compileFilter,
  compileFind,
  compileHybridSearch,
  compileVectorSearch,
  fieldExpression,
} from "./compile.js";
import { embeddingOf, fullTextColumn, schemaSql, tableIndexes, tableName, textSearchConfig } from "./schema.js";
import { sqlState, toStorageError } from "./errors.js";
import { PostgresStorage, storageAdapter } from "./adapter.js";

const T = '"public"."docs"';

/** Expected SQL, with paths written `'{a,b}'` for readability: elements get their quotes here. */
const sql = (text: string): string =>
  text.replace(/'\{([^}]*)\}'::text\[\]/g, (_, path: string) => `'{${path.split(",").map((s) => `"${s}"`).join(",")}}'::text[]`);
const search = {
  name: "memories",
  partitionKey: "userId",
  vector: { field: "vector", dimensions: 3, distance: "cosine" as const },
  fullText: { fields: ["text"], language: "en-US" },
};

test("fields are jsonb paths; values are parameters", () => {
  assert.equal(fieldExpression("state.status"), sql("(t.doc #> '{state,status}'::text[])"));
  // A segment spelled null is a field name, not a NULL array element.
  assert.equal(fieldExpression("meta.NULL"), `(t.doc #> '{"meta","NULL"}'::text[])`);
  const { text, values } = compileFilter(and(eq("userId", "u1"), ne("n", 3), missing("opt")));
  assert.equal(
    text,
    sql(
        "(((t.doc #> '{userId}'::text[]) = $1::jsonb) AND ((t.doc #> '{n}'::text[]) <> $2::jsonb) AND " +
        "((NOT ((t.doc #> '{opt}'::text[]) IS NOT NULL)) OR ((t.doc #> '{opt}'::text[]) = $3::jsonb)))"),
  );
  assert.deepEqual(values, ['"u1"', "3", "null"]);
  assert.throws(() => compileFilter({ op: "eq", field: "a'b", value: 1 }), StorageError);
});

test("ranges compare within one type and are unknown across types", () => {
  assert.equal(
    compileFilter(gt("n", 1)).text,
    sql(
        "(CASE WHEN jsonb_typeof((t.doc #> '{n}'::text[])) = 'number' THEN (t.doc #> '{n}'::text[]) > $1::jsonb END)"),
  );
  assert.equal(
    compileFilter(lte("s", "b")).text,
    sql(
        `(CASE WHEN jsonb_typeof((t.doc #> '{s}'::text[])) = 'string' THEN (t.doc #>> '{s}'::text[]) COLLATE "C" <= $1::text END)`),
  );
  assert.equal(compileFilter(lte("x", null)).text, sql("(CASE WHEN jsonb_typeof((t.doc #> '{x}'::text[])) = 'null' THEN TRUE END)"));
  assert.equal(compileFilter(gt("x", [1])).text, "(NULL::boolean)");
});

test("in, contains, isDefined, not, and the empty cases", () => {
  assert.equal(compileFilter(oneOf("cat", [])).text, "FALSE");
  assert.equal(compileFilter(and()).text, "TRUE");
  assert.equal(compileFilter(or()).text, "FALSE");
  const inList = compileFilter(oneOf("cat", ["x", 1]));
  assert.equal(inList.text, sql("((t.doc #> '{cat}'::text[]) IN ($1::jsonb, $2::jsonb))"));
  assert.deepEqual(inList.values, ['"x"', "1"]);
  const ci = compileFilter(contains("s", "AN", { ignoreCase: true }));
  assert.equal(
    ci.text,
    sql(
        "(CASE WHEN jsonb_typeof((t.doc #> '{s}'::text[])) = 'string' THEN strpos(lower((t.doc #>> '{s}'::text[])), lower($1::text)) > 0 END)"),
  );
  assert.deepEqual(ci.values, ["AN"]);
  assert.equal(compileFilter(not(isDefined("a"))).text, sql("(NOT ((t.doc #> '{a}'::text[]) IS NOT NULL))"));
});

test("find: partition, live rows, filter, order, limit, projection", () => {
  const { text, values } = compileFind(T, {
    partitionKey: "p1",
    where: eq("kind", "a"),
    orderBy: { field: "at", direction: "desc" },
    limit: 5,
    select: ["id", { field: "state.status", as: "status" }],
  });
  assert.equal(
    text,
    sql(
        `SELECT (t.doc #> '{id}'::text[])::text AS c0, (t.doc #> '{state,status}'::text[])::text AS c1 FROM "public"."docs" t ` +
        "WHERE t.pk = $1::text AND (t.expires_at IS NULL OR t.expires_at > now()) AND ((t.doc #> '{kind}'::text[]) = $2::jsonb) " +
        "ORDER BY CASE jsonb_typeof((t.doc #> '{at}'::text[])) WHEN 'null' THEN 1 WHEN 'boolean' THEN 2 WHEN 'number' THEN 3 " +
        "WHEN 'string' THEN 4 WHEN 'array' THEN 5 WHEN 'object' THEN 6 ELSE 0 END DESC, " +
        "CASE WHEN jsonb_typeof((t.doc #> '{at}'::text[])) IN ('boolean', 'number') THEN (t.doc #> '{at}'::text[]) END DESC, " +
        `(CASE WHEN jsonb_typeof((t.doc #> '{at}'::text[])) = 'string' THEN (t.doc #>> '{at}'::text[]) END) COLLATE "C" DESC, t.pk, t.id LIMIT 5`),
  );
  assert.deepEqual(values, ["p1", '"a"']);
  assert.equal(
    compileFind(T).text,
    sql(
        `SELECT t.doc, t.etag FROM "public"."docs" t WHERE (t.expires_at IS NULL OR t.expires_at > now())`),
  );
  assert.equal(
    compileCount(T, { where: and() }).text,
    sql(
        `SELECT count(*) AS n FROM "public"."docs" t WHERE (t.expires_at IS NULL OR t.expires_at > now())`),
  );
  assert.throws(() => compileFind(T, { limit: -1 }), StorageError);
  assert.throws(() => compileFind(T, { select: ["a;b"] }), StorageError);
});

test("vector search: exact cosine, unscored rows last", () => {
  const { text, values } = compileVectorSearch('"public"."memories"', search, { partitionKey: "u1", vector: [1, 0, 0.5], limit: 3 });
  assert.equal(
    text,
    sql(
        "SELECT t.doc, t.etag, (CASE WHEN vector_dims(t.embedding) = 3 THEN coalesce(nullif(1 - (t.embedding <=> $1::vector), 'NaN'::float8), 0) END) AS _score " +
        `FROM "public"."memories" t WHERE t.pk = $2::text AND (t.expires_at IS NULL OR t.expires_at > now()) ORDER BY _score DESC NULLS LAST, t.pk, t.id LIMIT 3`),
  );
  assert.deepEqual(values, ["[1,0,0.5]", "u1"]);
  assert.throws(() => compileVectorSearch(T, search, { vector: [1, 0], limit: 1 }), StorageError);
});

test("hybrid search: dense ranks per component, weighted RRF", () => {
  const { text, values } = compileHybridSearch('"public"."memories"', search, {
    partitionKey: "u1",
    rank: [
      { kind: "fullText", field: "text", terms: ["Green tea", "the tea!"] },
      { kind: "vector", vector: [1, 0, 0] },
    ],
    weights: [2, 1],
    limit: 10,
    select: ["id"],
  });
  assert.equal(
    text,
    sql(
        "SELECT t.c0 FROM (SELECT (t.doc #> '{id}'::text[])::text AS c0, t.pk, t.id, " +
        `dense_rank() OVER (ORDER BY ts_rank_cd(t."fts:english:text", to_tsquery('english'::regconfig, $1::text)) DESC NULLS LAST) AS r0, ` +
        "dense_rank() OVER (ORDER BY (CASE WHEN vector_dims(t.embedding) = 3 THEN coalesce(nullif(1 - (t.embedding <=> $2::vector), 'NaN'::float8), 0) END) DESC NULLS LAST) AS r1 " +
        `FROM "public"."memories" t WHERE t.pk = $5::text AND (t.expires_at IS NULL OR t.expires_at > now())) t ` +
        "ORDER BY $3::float8 / (60 + t.r0) + $4::float8 / (60 + t.r1) DESC, t.pk, t.id LIMIT 10"),
  );
  // Words split as BM25 splits them, deduplicated, OR'ed: no tsquery syntax gets through.
  assert.deepEqual(values, ["green | tea | the", "[1,0,0]", 2, 1, "u1"]);
  const injected = compileHybridSearch('"public"."memories"', search, {
    rank: [{ kind: "fullText", field: "text", terms: ["a' & !b:* | (c"] }],
    limit: 1,
  });
  assert.equal(injected.values[0], "a | b | c");
});

test("schema: one table per collection, columns and indexes from the spec", () => {
  assert.deepEqual(schemaSql(search), [
    "CREATE EXTENSION IF NOT EXISTS vector",
    sql(
      'CREATE TABLE IF NOT EXISTS "public"."memories" ("pk" text NOT NULL, "id" text NOT NULL, "doc" jsonb NOT NULL, ' +
        '"etag" text NOT NULL, "expires_at" timestamptz, "embedding" vector, "fts:english:text" tsvector GENERATED ALWAYS AS ' +
        "(to_tsvector('english'::regconfig, CASE WHEN jsonb_typeof(doc #> '{text}'::text[]) = 'string' THEN doc #>> '{text}'::text[] ELSE '' END)) STORED, " +
        "PRIMARY KEY (pk, id))",
    ),
    // Columns a newer spec adds reach tables created by an older release.
    'ALTER TABLE "public"."memories" ADD COLUMN IF NOT EXISTS "embedding" vector',
    sql(
      `ALTER TABLE "public"."memories" ADD COLUMN IF NOT EXISTS "fts:english:text" tsvector GENERATED ALWAYS AS ` +
        "(to_tsvector('english'::regconfig, CASE WHEN jsonb_typeof(doc #> '{text}'::text[]) = 'string' THEN doc #>> '{text}'::text[] ELSE '' END)) STORED",
    ),
  ]);
  const ttl = schemaSql({ name: "rate-limits", partitionKey: "key", defaultTtl: -1, indexes: ["state.at"] }, { schema: "app" });
  assert.equal(ttl.length, 4);
  assert.equal(ttl[0], 'CREATE SCHEMA IF NOT EXISTS "app"', "a schema other than public is created");
  assert.match(ttl[2], /^CREATE INDEX IF NOT EXISTS "rate-limits_expires_at_[0-9a-f]{10}" ON "app"\."rate-limits" \(expires_at\) WHERE expires_at IS NOT NULL$/);
  assert.match(ttl[3], /^CREATE INDEX IF NOT EXISTS "rate-limits_doc_state_at_[0-9a-f]{10}" ON "app"\."rate-limits" \(\(doc #> '\{"state","at"\}'::text\[\]\)\)$/);

  // Index names never collide: not between fields ("a.b" vs "a_b"), not
  // across collections ("x" + "doc.a" vs "x_doc" + "a"), and never exceed 63 bytes.
  const names = [
    ...tableIndexes({ name: "x", partitionKey: "pk", defaultTtl: 5, indexes: ["a.b", "a_b", "doc_a"] }),
    ...tableIndexes({ name: "x_doc", partitionKey: "pk", indexes: ["a"] }),
    ...tableIndexes({ name: "x".repeat(63), partitionKey: "pk", defaultTtl: 5, indexes: ["y".repeat(60)] }),
  ].map((index) => index.name);
  assert.equal(new Set(names).size, names.length, names.join(" "));
  assert.ok(names.every((name) => Buffer.byteLength(name) <= 63));
  assert.throws(() => tableName({ name: "x".repeat(64), partitionKey: "pk" }, "public"), StorageError);
  assert.throws(() => schemaSql({ name: "docs", partitionKey: "pk" }, { schema: 'bad"; drop' }), StorageError);
});

test("text search configurations follow the language; unknown languages use simple", () => {
  assert.equal(textSearchConfig("en-US"), "english");
  assert.equal(textSearchConfig("de"), "german");
  assert.equal(textSearchConfig("hi-IN"), "hindi");
  assert.equal(textSearchConfig("ja-JP"), "simple");
  assert.equal(textSearchConfig("constructor"), "simple");
  assert.equal(fullTextColumn("a.b", "english"), "fts:english:a.b");
});

test("embedding column: exactly `dimensions` numbers in float32 range, else NULL", () => {
  assert.deepEqual(embeddingOf(search, { vector: [1, 2, 3] }), [1, 2, 3]);
  assert.equal(embeddingOf(search, { vector: [1, 2] }), null);
  assert.equal(embeddingOf(search, { vector: [1, "2", 3] }), null);
  assert.equal(embeddingOf(search, { vector: [1e39, 0, 0] }), null);
  assert.equal(embeddingOf(search, {}), null);
  assert.equal(embeddingOf({ name: "x", partitionKey: "pk" }, { vector: [1, 2, 3] }), null);
});

test("errors: SQLSTATEs the contract names become StorageErrors", () => {
  const pgError = (code: string) => Object.assign(new Error("boom"), { code });
  assert.equal((toStorageError(pgError("23505")) as StorageError).code, "Conflict");
  for (const code of ["40P01", "57014", "25006", "57P01", "53300"]) {
    assert.equal((toStorageError(pgError(code)) as StorageError).code, "Throttled", code);
  }
  assert.equal((toStorageError(pgError("22P05")) as StorageError).statusCode, 400);
  const other = pgError("42P01");
  assert.equal(toStorageError(other), other);
  const network = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  assert.equal(sqlState(network), undefined);
  assert.equal(toStorageError(network), network);
});

test("the adapter needs a connection; the plugin maps generic host options", async () => {
  assert.throws(() => new PostgresStorage({}), /connectionString, a pool or a poolSource/);
  // The pool connects lazily, so building the adapter touches no server.
  const adapter = (await storageAdapter.create({
    endpoint: "postgres://u:p@127.0.0.1:1/db",
    provisionContainers: false,
    sweepIntervalMs: 0,
  })) as PostgresStorage;
  assert.equal(adapter.name, "postgres");
  assert.deepEqual(adapter.capabilities, { vectorSearch: true, hybridSearch: true });
  const pool = adapter.getPool().options as unknown as Record<string, unknown>;
  assert.equal(pool.connectionString, "postgres://u:p@127.0.0.1:1/db");
  assert.deepEqual([pool.connectionTimeoutMillis, pool.statement_timeout, pool.query_timeout], [10_000, 30_000, 35_000]);
  await adapter.close();
  await adapter.close(); // idempotent
  const behindPooler = new PostgresStorage({ connectionString: "postgres://u:p@127.0.0.1:1/db", serverTimeouts: false, sweepIntervalMs: 0 });
  const pooled = behindPooler.getPool().options as unknown as Record<string, unknown>;
  assert.deepEqual([pooled.statement_timeout, pooled.idle_in_transaction_session_timeout, pooled.query_timeout], [undefined, undefined, 35_000]);
  await behindPooler.close();
  await assert.rejects(adapter.collection({ name: "docs", partitionKey: "pk" }), /closed/);
});
