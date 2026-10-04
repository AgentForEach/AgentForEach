import test from "node:test";
import assert from "node:assert/strict";
import { and, contains, eq, isDefined, ne, not, oneOf, or, type CollectionSpec } from "@agentforeach/storage";
import { compileCount, compileFilter, compileHybridSearch, compileQuery, compileVectorSearch, fieldExpression } from "./compile.js";

const where = (filter: Parameters<typeof compileFilter>[0]) => compileFilter(filter).sql;

test("field paths: dotted, with brackets for Cosmos keywords", () => {
  assert.equal(fieldExpression("state.status"), "c.state.status");
  assert.equal(fieldExpression("value"), 'c["value"]');
  assert.equal(fieldExpression("data.order.top"), 'c.data["order"]["top"]');
  assert.throws(() => fieldExpression("a]"), { code: "BadRequest" });
});

test("parentheses only where AND and OR mix; nested same-op groups flatten", () => {
  assert.equal(where(and(eq("a", 1), and(eq("b", 2), eq("c", 3)))), "c.a = @a AND c.b = @b AND c.c = @c");
  assert.equal(where(or(eq("a", 1), or(eq("b", 2)))), "c.a = @a OR c.b = @b");
  assert.equal(where(and(eq("a", 1), or(eq("b", 2), eq("c", 3)))), "c.a = @a AND (c.b = @b OR c.c = @c)");
  assert.equal(where(or(eq("a", 1), and(eq("b", 2), eq("c", 3)))), "c.a = @a OR (c.b = @b AND c.c = @c)");
  assert.equal(where(and(or(eq("a", 1)))), "c.a = @a", "single children unwrap");
});

test("NOT: bare before a function call, parenthesized otherwise", () => {
  assert.equal(where(not(isDefined("a"))), "NOT IS_DEFINED(c.a)");
  assert.equal(where(not(eq("a", 1))), "NOT (c.a = @a)");
  assert.equal(where(not(and(eq("a", 1), eq("b", 2)))), "NOT (c.a = @a AND c.b = @b)");
  assert.equal(where(not(contains("s", "x"))), "NOT CONTAINS(c.s, @s)");
});

test("null is a literal; other values are parameters named after the field", () => {
  const compiled = compileFilter(and(eq("a", null), ne("b", null), eq("user.id", "u"), eq("id", "x"), eq("id", "y")));
  assert.equal(compiled.sql, "c.a = null AND c.b != null AND c.user.id = @id AND c.id = @id1 AND c.id = @id2");
  assert.deepEqual(compiled.parameters, [
    { name: "@id", value: "u" },
    { name: "@id1", value: "x" },
    { name: "@id2", value: "y" },
  ]);
});

test("IN, CONTAINS and empty groups", () => {
  assert.equal(where(oneOf("cat", ["a", "b"])), "c.cat IN (@cat0, @cat1)");
  assert.equal(where(oneOf("cat", [])), "false");
  const lowered = compileFilter(contains("s", "MiXeD", { ignoreCase: true }));
  assert.equal(lowered.sql, "CONTAINS(LOWER(c.s), @s)");
  assert.deepEqual(lowered.parameters, [{ name: "@s", value: "mixed" }]);
  assert.equal(where(and()), "true");
  assert.equal(where(or()), "false");
  assert.equal(compileQuery({ where: and() }).query, "SELECT * FROM c", "an empty AND means no WHERE");
});

test("SELECT shape: TOP literal, projection aliases, ORDER BY direction only when given", () => {
  assert.equal(
    compileQuery({ limit: 3, select: ["a", { field: "b.c", as: "d" }, { field: "e", as: "e" }], orderBy: { field: "a" } }).query,
    "SELECT TOP 3 c.a, c.b.c AS d, c.e FROM c ORDER BY c.a",
  );
  assert.equal(compileQuery({ orderBy: { field: "a", direction: "asc" } }).query, "SELECT * FROM c ORDER BY c.a ASC");
  assert.equal(compileCount().query, "SELECT VALUE COUNT(1) FROM c");
  assert.throws(() => compileQuery({ select: ["value"] }), /reserved word/);
  assert.throws(() => compileQuery({ select: [{ field: "a", as: "x-y" }] }), /invalid projection key/);
  assert.throws(() => compileQuery({ limit: 1.5 }), { code: "BadRequest" });
});

const searchSpec: CollectionSpec = {
  name: "s",
  partitionKey: "pk",
  vector: { field: "embedding", dimensions: 2, distance: "cosine" },
  fullText: { fields: ["text"], language: "en-US" },
};

test("vector search selects the document and the similarity, ordered by distance", () => {
  const compiled = compileVectorSearch(searchSpec, { where: eq("pk", "p"), vector: [1, 0], limit: 4 });
  assert.equal(
    compiled.spec.query,
    "SELECT TOP 4 c AS document, VectorDistance(c.embedding, @vector) AS vectorDistance FROM c WHERE c.pk = @pk ORDER BY VectorDistance(c.embedding, @vector)",
  );
  assert.equal(compiled.scoreAlias, "vectorDistance");
  // A projection that already uses the name pushes the score to a free alias.
  const taken = compileVectorSearch(searchSpec, { vector: [1, 0], limit: 1, select: [{ field: "a", as: "vectorDistance" }] });
  assert.equal(taken.scoreAlias, "vectorDistance1");
  assert.match(taken.spec.query, /^SELECT TOP 1 c\.a AS vectorDistance, VectorDistance\(c\.embedding, @vector\) AS vectorDistance1 FROM c/);
  assert.throws(() => compileVectorSearch(searchSpec, { vector: [1], limit: 1 }), { code: "BadRequest" });
});

test("hybrid search: RRF with weights in component order; single components rank alone", () => {
  const fullText = { kind: "fullText" as const, field: "text", terms: ["a", "b"] };
  const vector = { kind: "vector" as const, vector: [0, 1] };
  assert.equal(
    compileHybridSearch(searchSpec, { rank: [vector, fullText], weights: [1, 3], limit: 2 }).query,
    "SELECT TOP 2 * FROM c ORDER BY RANK RRF(VectorDistance(c.embedding, @vector), FullTextScore(c.text, @term, @term1), [1, 3])",
  );
  assert.equal(
    compileHybridSearch(searchSpec, { rank: [fullText, vector], limit: 2 }).query,
    "SELECT TOP 2 * FROM c ORDER BY RANK RRF(FullTextScore(c.text, @term, @term1), VectorDistance(c.embedding, @vector))",
  );
  assert.equal(
    compileHybridSearch(searchSpec, { rank: [fullText], limit: 2 }).query,
    "SELECT TOP 2 * FROM c ORDER BY RANK FullTextScore(c.text, @term, @term1)",
  );
  assert.throws(() => compileHybridSearch(searchSpec, { rank: [{ ...fullText, terms: [] }], limit: 1 }), /at least one non-empty term/);
  assert.throws(() => compileHybridSearch(searchSpec, { rank: [{ ...fullText, field: "other" }], limit: 1 }), /full-text policy/);
});
