/**
 * SQL parity: every query the gateway stores send to Cosmos today, copied
 * verbatim from their source, against what this compiler produces for the
 * same query written with the storage SDK (the form the stores move to).
 *
 * Both sides are compared after inlining parameters, because parameter
 * names are arbitrary, and after normalizing whitespace, quote style,
 * `c["x"]` vs `c.x` and redundant `AS x` aliases. What remains is the query
 * Cosmos executes; if it is the same text, the behaviour is the same.
 *
 * Partition scope is compared too: a query sent with `{ partitionKey }`
 * today must carry the same `partitionKey` in its SDK form (otherwise the
 * same text would scan every partition).
 *
 * The adapter adds one thing at run time for hybrid search: it forces the
 * query plan (and pins the partition in WHERE when the query doesn't
 * already). The gateway sent memory's hybrid query partition-scoped without
 * the plan, and Cosmos returned the documents unranked; see adapter.ts.
 *
 * Not here: the legacy cron sweep and its next-wake query
 * (`queryLegacyDueJobs`, `queryLegacyNextWake`: IS_NUMBER and `%` over
 * cross-partition jobs), which are off by default and not part of the
 * shared contract; and scripts/langsmith-thread-tokens.mjs, an offline
 * script outside the runtime.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { SqlQuerySpec } from "@azure/cosmos";
import {
  RESERVED_WORDS,
  and,
  contains,
  eq,
  gt,
  gte,
  isDefined,
  lt,
  lte,
  missing,
  not,
  oneOf,
  or,
  present,
  type CollectionSpec,
  type CountQuery,
  type HybridSearchQuery,
  type Query,
  type VectorSearchQuery,
} from "@agentforeach/storage";
import { compileCount, compileHybridSearch, compileQuery, compileVectorSearch } from "./compile.js";

/** A compiled SDK query with the partition it is scoped to. */
type Scoped = { spec: SqlQuerySpec; partitionKey?: string };
const q = (query: Query): Scoped => ({ spec: compileQuery(query), partitionKey: query.partitionKey });
const cnt = (query: CountQuery): Scoped => ({ spec: compileCount(query), partitionKey: query.partitionKey });
const vec = (spec: CollectionSpec, query: VectorSearchQuery): Scoped => ({
  spec: compileVectorSearch(spec, query).spec,
  partitionKey: query.partitionKey,
});
const hyb = (spec: CollectionSpec, query: HybridSearchQuery): Scoped => ({
  spec: compileHybridSearch(spec, query),
  partitionKey: query.partitionKey,
});

type Params = Record<string, unknown>;

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function inline(sql: string, parameters: Array<{ name: string; value: unknown }>): string {
  const byLength = [...parameters].sort((a, b) => b.name.length - a.name.length);
  let out = sql;
  for (const { name, value } of byLength) {
    out = out.replace(new RegExp(`${name}(?![A-Za-z0-9_])`, "g"), () => literal(value));
  }
  return out;
}

/** Normalize SQL outside string literals; literals are compared exactly. */
function normalize(sql: string, aliases: Record<string, string> = {}): string {
  const quoted = sql
    .replace(/'([^']*)'/g, (_m, s: string) => literal(s))
    // c["x"] and c.x are the same unless x is a keyword (c.value does not parse).
    .replace(/c\["([A-Za-z_][A-Za-z0-9_]*)"\]/g, (m, name: string) => (RESERVED_WORDS.has(name.toUpperCase()) ? m : `c.${name}`));
  return quoted
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // a string literal
      let out = part
        .replace(/(c(?:\.[A-Za-z_][A-Za-z0-9_]*)+) AS ([A-Za-z_][A-Za-z0-9_]*)/g, (m, path: string, alias: string) =>
          path.split(".").pop() === alias ? path : m,
        );
      for (const [from, to] of Object.entries(aliases)) {
        out = out.replace(new RegExp(`AS ${from}\\b`, "g"), `AS ${to}`);
      }
      return out.replace(/\s+/g, " ").replace(/([([]) /g, "$1").replace(/ ([)\]])/g, "$1");
    })
    .join("")
    .trim();
}

type Today = { sql: string; params?: Params; aliases?: Record<string, string>; partitionKey?: string };

function same(today: Today, sdk: Scoped): void {
  const before = normalize(
    inline(today.sql, Object.entries(today.params ?? {}).map(([name, value]) => ({ name, value }))),
    today.aliases,
  );
  const after = normalize(inline(sdk.spec.query, (sdk.spec.parameters ?? []) as Array<{ name: string; value: unknown }>));
  assert.equal(after, before);
  assert.equal(sdk.partitionKey, today.partitionKey, "partition scope");
}

// A few values used throughout.
const userId = "u-1";
const agentId = "agent-1";
const pk = "u-1:s-1:i-1";
const nowMs = 1_760_000_000_000;
const staleBeforeMs = nowMs - 600_000;
const cutoff = "2026-09-17T00:00:00.000Z";
const shard = "3"; // due-index and heartbeat partitions are shard ids as strings

// The heartbeat claim filter, shared by the cron queries below.
const claimable = or(missing("runningToken"), and(isDefined("runningAtMs"), lte("runningAtMs", staleBeforeMs)));
const notDeadLettered = missing("deadLetteredAtMs");

// ---------------------------------------------------------------------------
// sessions / session-messages-v2
// ---------------------------------------------------------------------------

test("sessions.list (with and without agentId)", () => {
  const columns =
    "c.sessionId, c.agentId, c.messageSeq AS messageCount, " + "c.lastMessagePreview, c.createdAt, c.updatedAt";
  const select = ["sessionId", "agentId", { field: "messageSeq", as: "messageCount" }, "lastMessagePreview", "createdAt", "updatedAt"];
  same(
    {
      sql: `SELECT ${columns} FROM c ` + "WHERE c.userId = @userId AND c.agentId = @agentId " + "ORDER BY c.updatedAt DESC",
      partitionKey: userId, params: { "@userId": userId, "@agentId": agentId },
    },
    q({ partitionKey: userId, where: and(eq("userId", userId), eq("agentId", agentId)), orderBy: { field: "updatedAt", direction: "desc" }, select }),
  );
  same(
    { sql: `SELECT ${columns} FROM c ` + "WHERE c.userId = @userId " + "ORDER BY c.updatedAt DESC", partitionKey: userId, params: { "@userId": userId } },
    q({ partitionKey: userId, where: eq("userId", userId), orderBy: { field: "updatedAt", direction: "desc" }, select }),
  );
});

test("messages.getRecent / getAll / getRange / count", () => {
  same(
    { sql: "SELECT TOP @limit * FROM c WHERE c.pk = @pk ORDER BY c.seq DESC", partitionKey: pk, params: { "@pk": pk, "@limit": 40 } },
    q({ partitionKey: pk, where: eq("pk", pk), orderBy: { field: "seq", direction: "desc" }, limit: 40 }),
  );
  same(
    { sql: "SELECT * FROM c WHERE c.pk = @pk ORDER BY c.seq ASC", partitionKey: pk, params: { "@pk": pk } },
    q({ partitionKey: pk, where: eq("pk", pk), orderBy: { field: "seq", direction: "asc" } }),
  );
  same(
    {
      sql: "SELECT * FROM c WHERE c.pk = @pk AND c.seq >= @from AND c.seq < @to ORDER BY c.seq ASC",
      partitionKey: pk, params: { "@pk": pk, "@from": 3, "@to": 9 },
    },
    q({ partitionKey: pk, where: and(eq("pk", pk), gte("seq", 3), lt("seq", 9)), orderBy: { field: "seq", direction: "asc" } }),
  );
  same(
    { sql: "SELECT VALUE COUNT(1) FROM c WHERE c.pk = @pk", partitionKey: pk, params: { "@pk": pk } },
    cnt({ partitionKey: pk, where: eq("pk", pk) }),
  );
});

test("messages.deleteAll / deleteBefore id scans", () => {
  same(
    { sql: "SELECT c.id FROM c WHERE c.pk = @pk", partitionKey: pk, params: { "@pk": pk } },
    q({ partitionKey: pk, where: eq("pk", pk), select: ["id"] }),
  );
  same(
    { sql: "SELECT c.id FROM c WHERE c.pk = @pk AND c.seq < @before", partitionKey: pk, params: { "@pk": pk, "@before": 12 } },
    q({ partitionKey: pk, where: and(eq("pk", pk), lt("seq", 12)), select: ["id"] }),
  );
});

test("messages.findByRunId / findByIdempotencyKey", () => {
  same(
    {
      sql: "SELECT * FROM c WHERE c.pk = @pk AND c.runId = @runId AND c.role = 'assistant'",
      partitionKey: pk, params: { "@pk": pk, "@runId": "run-1" },
    },
    q({ partitionKey: pk, where: and(eq("pk", pk), eq("runId", "run-1"), eq("role", "assistant")) }),
  );
  same(
    {
      sql: "SELECT * FROM c WHERE c.pk = @pk AND c.idempotencyKey = @key AND c.role = 'user' ORDER BY c.seq DESC",
      partitionKey: pk, params: { "@pk": pk, "@key": "k-1" },
    },
    q({
      partitionKey: pk,
      where: and(eq("pk", pk), eq("idempotencyKey", "k-1"), eq("role", "user")),
      orderBy: { field: "seq", direction: "desc" },
    }),
  );
  same(
    {
      sql: "SELECT * FROM c WHERE c.pk = @pk AND c.seq > @seq AND c.role = 'assistant' ORDER BY c.seq ASC",
      partitionKey: pk, params: { "@pk": pk, "@seq": 7 },
    },
    q({ partitionKey: pk, where: and(eq("pk", pk), gt("seq", 7), eq("role", "assistant")), orderBy: { field: "seq", direction: "asc" } }),
  );
});

// ---------------------------------------------------------------------------
// hitl / episodes / digests / skills / prompt / usage / identity / erasure
// ---------------------------------------------------------------------------

test("hitl.listPending", () => {
  same(
    {
      sql: "SELECT * FROM c WHERE c.userId = @userId AND c.state.status = 'pending' ORDER BY c.createdAt DESC",
      partitionKey: userId, params: { "@userId": userId },
    },
    q({ partitionKey: userId, where: and(eq("userId", userId), eq("state.status", "pending")), orderBy: { field: "createdAt", direction: "desc" } }),
  );
});

const episodesSpec: CollectionSpec = {
  name: "episodes",
  partitionKey: "userId",
  vector: { field: "vector", dimensions: 3, distance: "cosine" },
  fullText: { fields: ["summary"], language: "en-US" },
};

test("episodes.semanticSearch / getRecent / getActive", () => {
  const queryVector = [0.1, 0.2, 0.3];
  same(
    {
      sql: `
        SELECT TOP @limit
          c.id, c.userId, c.theme, c.summary, c.topics,
          c.highlights, c.status, c.salience, c.decisions, c.pending,
          c.createdAt, c.updatedAt,
          VectorDistance(c.vector, @queryVector) AS distance
        FROM c
        WHERE c.userId = @userId
          AND c.updatedAt >= @cutoff
        ORDER BY VectorDistance(c.vector, @queryVector)
      `,
      partitionKey: userId, params: { "@userId": userId, "@queryVector": queryVector, "@limit": 3, "@cutoff": cutoff },
      // The similarity column's alias is internal to the adapter.
      aliases: { distance: "vectorDistance" },
    },
    vec(episodesSpec, {
      partitionKey: userId,
      where: and(eq("userId", userId), gte("updatedAt", cutoff)),
      vector: queryVector,
      limit: 3,
      select: ["id", "userId", "theme", "summary", "topics", "highlights", "status", "salience", "decisions", "pending", "createdAt", "updatedAt"],
    }),
  );
  same(
    {
      sql: `
        SELECT TOP @limit *
        FROM c
        WHERE c.userId = @userId
          AND c.updatedAt >= @cutoff
        ORDER BY c.updatedAt DESC
      `,
      partitionKey: userId, params: { "@userId": userId, "@limit": 5, "@cutoff": cutoff },
    },
    q({ partitionKey: userId, where: and(eq("userId", userId), gte("updatedAt", cutoff)), orderBy: { field: "updatedAt", direction: "desc" }, limit: 5 }),
  );
  same(
    {
      sql: `
        SELECT TOP @limit *
        FROM c
        WHERE c.userId = @userId
          AND c.status = "active"
        ORDER BY c.updatedAt DESC
      `,
      partitionKey: userId, params: { "@userId": userId, "@limit": 5 },
    },
    q({ partitionKey: userId, where: and(eq("userId", userId), eq("status", "active")), orderBy: { field: "updatedAt", direction: "desc" }, limit: 5 }),
  );
});

test("digests.getRecent / searchByKeyword (with and without maxAgeDays)", () => {
  same(
    {
      sql: `
        SELECT TOP @limit *
        FROM c
        WHERE c.userId = @userId
        ORDER BY c.createdAt DESC
      `,
      partitionKey: userId, params: { "@userId": userId, "@limit": 5 },
    },
    q({ partitionKey: userId, where: eq("userId", userId), orderBy: { field: "createdAt", direction: "desc" }, limit: 5 }),
  );
  const base = `
      SELECT TOP @limit *
      FROM c
      WHERE c.userId = @userId
        AND CONTAINS(LOWER(c.summary), @keyword)
    `;
  same(
    { sql: base + ` ORDER BY c.createdAt DESC`, partitionKey: userId, params: { "@userId": userId, "@keyword": "invoice", "@limit": 5 } },
    q({
      partitionKey: userId,
      where: and(eq("userId", userId), contains("summary", "Invoice", { ignoreCase: true })),
      orderBy: { field: "createdAt", direction: "desc" },
      limit: 5,
    }),
  );
  same(
    {
      sql: base + ` AND c.createdAt >= @cutoff` + ` ORDER BY c.createdAt DESC`,
      partitionKey: userId, params: { "@userId": userId, "@keyword": "invoice", "@limit": 5, "@cutoff": cutoff },
    },
    q({
      partitionKey: userId,
      where: and(eq("userId", userId), contains("summary", "invoice", { ignoreCase: true }), gte("createdAt", cutoff)),
      orderBy: { field: "createdAt", direction: "desc" },
      limit: 5,
    }),
  );
});

test("skills.getAllForUser / prompt.loadAll", () => {
  same(
    {
      sql: "SELECT * FROM c WHERE c.userId = @userId AND IS_DEFINED(c.enabled) ORDER BY c.skillId",
      partitionKey: userId, params: { "@userId": userId },
    },
    q({ partitionKey: userId, where: and(eq("userId", userId), isDefined("enabled")), orderBy: { field: "skillId" } }),
  );
  same(
    { sql: "SELECT * FROM c WHERE c.userId = @userId AND c.agentId = @agentId", partitionKey: userId, params: { "@userId": userId, "@agentId": agentId } },
    q({ partitionKey: userId, where: and(eq("userId", userId), eq("agentId", agentId)) }),
  );
});

test("usage.getRecords / getSummary (optional date bounds)", () => {
  const from = "2026-09-01T00:00:00Z";
  const to = "2026-09-30T00:00:00Z";
  for (const [f, t] of [[undefined, undefined], [from, undefined], [undefined, to], [from, to]] as const) {
    const conditions = ["c.userId = @userId"];
    const params: Params = { "@userId": userId };
    if (f) { conditions.push("c.timestamp >= @from"); params["@from"] = f; }
    if (t) { conditions.push("c.timestamp <= @to"); params["@to"] = t; }
    const where = and(eq("userId", userId), f && gte("timestamp", f), t && lte("timestamp", t));
    same(
      { sql: `SELECT TOP @limit * FROM c WHERE ${conditions.join(" AND ")} ORDER BY c.timestamp DESC`, params: { ...params, "@limit": 50 }, partitionKey: userId },
      q({ partitionKey: userId, where, orderBy: { field: "timestamp", direction: "desc" }, limit: 50 }),
    );
    same(
      { sql: `SELECT * FROM c WHERE ${conditions.join(" AND ")} ORDER BY c.timestamp DESC`, params, partitionKey: userId },
      q({ partitionKey: userId, where, orderBy: { field: "timestamp", direction: "desc" } }),
    );
  }
});

test("identity: legacy lookup, backfill scan, user links, active pairing codes", () => {
  same({ sql: "SELECT * FROM c WHERE c.id = @id", params: { "@id": "telegram:42" } }, q({ where: eq("id", "telegram:42") }));
  same({ sql: "SELECT c.id, c.userId FROM c" }, q({ select: ["id", "userId"] }));
  same(
    { sql: "SELECT * FROM c WHERE c.userId = @userId", params: { "@userId": userId }, partitionKey: userId },
    q({ partitionKey: userId, where: eq("userId", userId) }),
  );
  same(
    { sql: "SELECT * FROM c WHERE c.userId = @userId AND c.expiresAt > @now", params: { "@userId": userId, "@now": cutoff } },
    q({ where: and(eq("userId", userId), gt("expiresAt", cutoff)) }),
  );
});

test("account erasure scans", () => {
  same({ sql: "SELECT c.id FROM c", partitionKey: userId }, q({ partitionKey: userId, select: ["id"] }));
  // Every partition-key field outside /userId in the catalog.
  for (const field of ["pk", "shardId", "jobId", "id", "code", "scope"]) {
    same(
      { sql: `SELECT c.id, c["${field}"] AS pk FROM c WHERE c.userId = @user`, params: { "@user": userId } },
      q({ where: eq("userId", userId), select: ["id", { field, as: "pk" }] }),
    );
  }
});

// ---------------------------------------------------------------------------
// memories
// ---------------------------------------------------------------------------

const memoriesSpec: CollectionSpec = {
  name: "memories",
  partitionKey: "userId",
  vector: { field: "vector", dimensions: 3, distance: "cosine" },
  fullText: { fields: ["text"], language: "en-US" },
};
const memoryColumns = ["id", "userId", "text", "category", "importance", "createdAt", "lastAccessedAt", "contentHash", "accessCount", "source", "tags"];
const memoryColumnsSql = `
          c.id, c.userId, c.text, c.category, c.importance,
          c.createdAt, c.lastAccessedAt, c.contentHash,
          c.accessCount, c.source, c.tags`;

test("memory.vectorSearch (with and without categories)", () => {
  const queryVector = [0.3, 0.2, 0.1];
  for (const categories of [[], ["preference", "fact"]]) {
    const params: Params = { "@userId": userId, "@queryVector": queryVector };
    categories.forEach((c, i) => (params[`@cat${i}`] = c));
    const categoryFilter = categories.length ? `AND c.category IN (${categories.map((_, i) => `@cat${i}`).join(", ")})` : "";
    same(
      {
        sql: `
        SELECT TOP 5
          ${memoryColumnsSql},
          VectorDistance(c.vector, @queryVector) AS vectorDistance
        FROM c
        WHERE c.userId = @userId ${categoryFilter}
        ORDER BY VectorDistance(c.vector, @queryVector)
      `,
        params,
        partitionKey: userId,
      },
      vec(memoriesSpec, {
        partitionKey: userId,
        where: and(eq("userId", userId), categories.length > 0 && oneOf("category", categories)),
        vector: queryVector,
        limit: 5,
        select: memoryColumns,
      }),
    );
  }
});

test("memory.hybridSearch (keywords, categories, and the raw-text fallback)", () => {
  const queryVector = [0.3, 0.2, 0.1];
  const cases = [
    { keywords: ["coffee", "morning"], categories: ["preference"] },
    { keywords: ["coffee"], categories: [] },
    { keywords: [], categories: ["preference", "fact"] },
    { keywords: [], categories: [] },
  ];
  for (const { keywords, categories } of cases) {
    const params: Params = { "@userId": userId, "@queryVector": queryVector };
    categories.forEach((c, i) => (params[`@cat${i}`] = c));
    keywords.forEach((k, i) => (params[`@term${i}`] = k));
    const categoryFilter = categories.length ? `AND c.category IN (${categories.map((_, i) => `@cat${i}`).join(", ")})` : "";
    const fullTextScoreArgs = keywords.length ? keywords.map((_, i) => `@term${i}`).join(", ") : "@emptyTerm";
    if (!keywords.length) params["@emptyTerm"] = "what do I drink";
    same(
      {
        sql: `
        SELECT TOP 8
          ${memoryColumnsSql}
        FROM c
        WHERE c.userId = @userId ${categoryFilter}
        ORDER BY RANK RRF(
          FullTextScore(c.text, ${fullTextScoreArgs}),
          VectorDistance(c.vector, @queryVector),
          [2, 1]
        )
      `,
        params,
        partitionKey: userId,
      },
      hyb(memoriesSpec, {
        partitionKey: userId,
        where: and(eq("userId", userId), categories.length > 0 && oneOf("category", categories)),
        rank: [
          { kind: "fullText", field: "text", terms: keywords.length ? keywords : ["what do I drink"] },
          { kind: "vector", vector: queryVector },
        ],
        weights: [2, 1],
        limit: 8,
        select: memoryColumns,
      }),
    );
  }
});

test("memory.findByContentHash / count / countBySource", () => {
  same(
    { sql: "SELECT TOP 1 * FROM c WHERE c.userId = @userId AND c.contentHash = @hash", partitionKey: userId, params: { "@userId": userId, "@hash": "abc" } },
    q({ partitionKey: userId, where: and(eq("userId", userId), eq("contentHash", "abc")), limit: 1 }),
  );
  same(
    { sql: "SELECT VALUE COUNT(1) FROM c WHERE c.userId = @userId", partitionKey: userId, params: { "@userId": userId } },
    cnt({ partitionKey: userId, where: eq("userId", userId) }),
  );
  same(
    {
      sql: "SELECT VALUE COUNT(1) FROM c WHERE c.userId = @userId AND c.source = @source",
      partitionKey: userId,
      params: { "@userId": userId, "@source": "auto-capture" },
    },
    cnt({ partitionKey: userId, where: and(eq("userId", userId), eq("source", "auto-capture")) }),
  );
  same(
    {
      sql: "SELECT VALUE COUNT(1) FROM c WHERE c.userId = @userId AND c.source = @source AND c.createdAt >= @since",
      partitionKey: userId, params: { "@userId": userId, "@source": "auto-capture", "@since": cutoff },
    },
    cnt({ partitionKey: userId, where: and(eq("userId", userId), eq("source", "auto-capture"), gte("createdAt", cutoff)) }),
  );
});

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

test("cron jobs: list, prune scan, count, backfill, runs", () => {
  same(
    { sql: "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.state.nextRunAtMs ASC", params: { "@userId": userId } },
    q({ where: eq("userId", userId), orderBy: { field: "state.nextRunAtMs", direction: "asc" } }),
  );
  same(
    {
      sql: "SELECT * FROM c WHERE c.userId = @userId AND c.enabled = true ORDER BY c.state.nextRunAtMs ASC",
      params: { "@userId": userId },
    },
    q({ where: and(eq("userId", userId), eq("enabled", true)), orderBy: { field: "state.nextRunAtMs", direction: "asc" } }),
  );
  same({ sql: "SELECT * FROM c WHERE c.userId = @userId", params: { "@userId": userId } }, q({ where: eq("userId", userId) }));
  same(
    { sql: "SELECT VALUE COUNT(1) FROM c WHERE c.userId = @userId", params: { "@userId": userId } },
    cnt({ where: eq("userId", userId) }),
  );
  same({ sql: "SELECT * FROM c WHERE c.enabled = true" }, q({ where: eq("enabled", true) }));
  same(
    { sql: `SELECT TOP 20 * FROM c WHERE c.jobId = @jobId ORDER BY c.ts DESC`, params: { "@jobId": "job-1" } },
    q({ where: eq("jobId", "job-1"), orderBy: { field: "ts", direction: "desc" }, limit: 20 }),
  );
});

test("cron due index: candidates and next wake", () => {
  same(
    {
      sql:
        `SELECT TOP 100 c.id, c.id AS jobId, c.userId FROM c ` +
        "WHERE c.enabled = true " +
        "AND IS_DEFINED(c.nextRunAtMs) AND c.nextRunAtMs != null AND c.nextRunAtMs <= @nowMs " +
        "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
        "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
        "ORDER BY c.nextRunAtMs ASC",
      params: { "@nowMs": nowMs, "@staleBeforeMs": staleBeforeMs },
      partitionKey: shard,
    },
    q({
      partitionKey: shard,
      where: and(eq("enabled", true), present("nextRunAtMs"), lte("nextRunAtMs", nowMs), claimable),
      orderBy: { field: "nextRunAtMs", direction: "asc" },
      limit: 100,
      select: ["id", { field: "id", as: "jobId" }, "userId"],
    }),
  );
  same(
    {
      sql:
        "SELECT TOP 1 c.nextRunAtMs AS nextRunAtMs FROM c " +
        "WHERE c.enabled = true " +
        "AND IS_DEFINED(c.nextRunAtMs) AND c.nextRunAtMs != null " +
        "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
        "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
        "ORDER BY c.nextRunAtMs ASC",
      params: { "@staleBeforeMs": staleBeforeMs },
      partitionKey: shard,
    },
    q({
      partitionKey: shard,
      where: and(eq("enabled", true), present("nextRunAtMs"), claimable),
      orderBy: { field: "nextRunAtMs", direction: "asc" },
      limit: 1,
      select: ["nextRunAtMs"],
    }),
  );
});

test("cron heartbeat events: pending cap, claim candidates, target count, next wake", () => {
  same(
    {
      sql:
        "SELECT VALUE COUNT(1) FROM c " +
        "WHERE c.userId = @userId " +
        "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null)",
      params: { "@userId": userId },
    },
    cnt({ where: and(eq("userId", userId), notDeadLettered) }),
  );

  const due = and(isDefined("dueAtMs"), lte("dueAtMs", nowMs), notDeadLettered, claimable);
  const targets = [
    undefined,
    { agentId: undefined, sessionId: undefined },
    { agentId, sessionId: undefined },
    { agentId: undefined, sessionId: "s-1" },
    { agentId, sessionId: "s-1" },
  ];
  for (const target of targets) {
    const targetSql = target
      ? "AND c.userId = @userId " +
        (target.agentId ? "AND c.agentId = @agentId " : "AND (NOT IS_DEFINED(c.agentId) OR c.agentId = null) ") +
        (target.sessionId ? "AND c.sessionId = @sessionId " : "AND (NOT IS_DEFINED(c.sessionId) OR c.sessionId = null) ")
      : "";
    const params: Params = { "@nowMs": nowMs, "@staleBeforeMs": staleBeforeMs };
    if (target) params["@userId"] = userId;
    if (target?.agentId) params["@agentId"] = target.agentId;
    if (target?.sessionId) params["@sessionId"] = target.sessionId;
    const targetFilter = target
      ? and(
          eq("userId", userId),
          target.agentId ? eq("agentId", target.agentId) : missing("agentId"),
          target.sessionId ? eq("sessionId", target.sessionId) : missing("sessionId"),
        )
      : undefined;

    same(
      {
        sql:
          `SELECT TOP 25 * FROM c ` +
          "WHERE IS_DEFINED(c.dueAtMs) AND c.dueAtMs <= @nowMs " +
          "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null) " +
          "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
          "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
          targetSql +
          "ORDER BY c.dueAtMs ASC",
        params,
        partitionKey: shard,
      },
      q({ partitionKey: shard, where: and(due, targetFilter), orderBy: { field: "dueAtMs", direction: "asc" }, limit: 25 }),
    );

    if (target) {
      same(
        {
          sql:
            "SELECT VALUE COUNT(1) FROM c " +
            "WHERE IS_DEFINED(c.dueAtMs) AND c.dueAtMs <= @nowMs " +
            "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null) " +
            "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
            "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
            targetSql,
          params,
          partitionKey: shard,
        },
        cnt({ partitionKey: shard, where: and(due, targetFilter) }),
      );
    }
  }

  same(
    {
      sql:
        "SELECT TOP 1 c.dueAtMs AS dueAtMs FROM c " +
        "WHERE IS_DEFINED(c.dueAtMs) " +
        "AND (NOT IS_DEFINED(c.deadLetteredAtMs) OR c.deadLetteredAtMs = null) " +
        "AND (NOT IS_DEFINED(c.runningToken) OR c.runningToken = null " +
        "OR (IS_DEFINED(c.runningAtMs) AND c.runningAtMs <= @staleBeforeMs)) " +
        "ORDER BY c.dueAtMs ASC",
      params: { "@staleBeforeMs": staleBeforeMs },
      partitionKey: shard,
    },
    q({
      partitionKey: shard,
      where: and(isDefined("dueAtMs"), notDeadLettered, claimable),
      orderBy: { field: "dueAtMs", direction: "asc" },
      limit: 1,
      select: ["dueAtMs"],
    }),
  );
});

test("the normalizer itself is not too forgiving", () => {
  assert.notEqual(normalize("SELECT * FROM c WHERE c.a = 1 AND (c.b = 2 OR c.c = 3)"), normalize("SELECT * FROM c WHERE c.a = 1 AND c.b = 2 OR c.c = 3"));
  assert.notEqual(normalize(`SELECT * FROM c WHERE c.a = "1"`), normalize("SELECT * FROM c WHERE c.a = 1"));
  assert.notEqual(normalize("SELECT c.a AS b FROM c"), normalize("SELECT c.a FROM c"));
  assert.throws(() => same({ sql: "SELECT * FROM c WHERE c.x = @x", params: { "@x": 1 } }, q({ where: not(eq("x", 1)) })));
  // Whitespace inside string literals is significant; c.value is not c["value"].
  assert.notEqual(normalize(`SELECT * FROM c WHERE c.a = "x  y"`), normalize(`SELECT * FROM c WHERE c.a = "x y"`));
  assert.notEqual(normalize(`SELECT c.value FROM c`), normalize(`SELECT c["value"] FROM c`));
  // Partition scope must match.
  assert.throws(
    () => same({ sql: "SELECT c.id FROM c", partitionKey: userId }, q({ select: ["id"] })),
    /partition scope/,
  );
});
