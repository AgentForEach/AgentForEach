import test from "node:test";
import assert from "node:assert/strict";

import type {
  BaseDocument,
  ContainerHandle,
  ContainerOptions,
  DatabaseProvider,
  PatchOperation,
  QueryOptions,
  QueryParameter,
} from "../database/index.js";
import {
  SessionStore,
  SessionReplacedError,
  messagePartitionKey,
  resetSessionConfigCache,
} from "./index.js";
import type { Session, SessionMessage } from "./types.js";

// ============================================================================
// In-Memory Database Mock
// ============================================================================

/**
 * In-memory container that is partition-key aware and supports the subset
 * of Cosmos SQL used by SessionStore and MessageStore:
 *
 *   - Equality:           c.sessionId = @sid, c.role = 'user'
 *   - Range:              c.seq >= @from AND c.seq < @to, c.seq > @seq
 *   - ORDER BY:           c.seq DESC/ASC, c.updatedAt DESC
 *   - TOP @limit
 *   - Projection:         c.messageSeq AS messageCount
 *   - Literal equality:   c.idempotencyKey = @key
 *
 * Two containers are created by SessionStore.initialize():
 *   - "sessions"          partition key: /userId
 *   - "session-messages"  partition key: /sessionId
 */
class InMemoryContainer<T extends BaseDocument> implements ContainerHandle<T> {
  private docs = new Map<string, T>();
  private etags = new Map<string, string>();
  private partitionKeyPath: string;

  constructor(partitionKeyPath = "/userId") {
    // Strip leading slash: "/userId" -> "userId"
    this.partitionKeyPath = partitionKeyPath.replace(/^\//, "");
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  async create(document: T): Promise<T> {
    if (this.docs.has(document.id)) {
      const err: Record<string, unknown> = new Error(
        "Conflict",
      ) as unknown as Record<string, unknown>;
      err.code = 409;
      throw err;
    }
    const etag = `etag-${Date.now()}-${Math.random()}`;
    this.docs.set(document.id, structuredClone(document));
    this.etags.set(document.id, etag);
    return structuredClone(document);
  }

  async upsert(document: T): Promise<T> {
    const etag = `etag-${Date.now()}-${Math.random()}`;
    this.docs.set(document.id, structuredClone(document));
    this.etags.set(document.id, etag);
    return structuredClone(document);
  }

  async read(id: string, partitionKey: string): Promise<T | null> {
    const doc = this.docs.get(id);
    if (!doc) return null;
    if (
      (doc as Record<string, unknown>)[this.partitionKeyPath] !== partitionKey
    )
      return null;
    return structuredClone(doc);
  }

  async replace(id: string, partitionKey: string, document: T): Promise<T> {
    const existing = await this.read(id, partitionKey);
    if (!existing) throw new Error("not found");
    const etag = `etag-${Date.now()}-${Math.random()}`;
    this.docs.set(id, structuredClone(document));
    this.etags.set(id, etag);
    return structuredClone(document);
  }

  async patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
  ): Promise<T> {
    const existing = await this.read(id, partitionKey);
    if (!existing) throw new Error("not found");
    const target = existing as unknown as Record<string, unknown>;

    for (const op of operations) {
      const path = op.path.replace(/^\//, "").split("/");
      if (path.length === 0) continue;
      if (op.op === "set") {
        const key = path[path.length - 1];
        let ptr = target;
        for (let i = 0; i < path.length - 1; i += 1) {
          if (!ptr[path[i]] || typeof ptr[path[i]] !== "object") {
            ptr[path[i]] = {};
          }
          ptr = ptr[path[i]] as Record<string, unknown>;
        }
        ptr[key] = op.value;
      }
    }

    this.docs.set(id, structuredClone(existing));
    return structuredClone(existing);
  }

  async delete(id: string, partitionKey: string): Promise<boolean> {
    const existing = await this.read(id, partitionKey);
    if (!existing) return false;
    this.docs.delete(id);
    this.etags.delete(id);
    return true;
  }

  // --------------------------------------------------------------------------
  // Query
  // --------------------------------------------------------------------------

  async query<R = T>(
    _querySpec: unknown,
    options: QueryOptions = {},
  ): Promise<R[]> {
    const partitionKey = options.partitionKey;
    const out: unknown[] = [];
    for (const doc of this.docs.values()) {
      if (
        partitionKey !== undefined &&
        (doc as Record<string, unknown>)[this.partitionKeyPath] !== partitionKey
      ) {
        continue;
      }
      out.push(structuredClone(doc));
    }
    return out as R[];
  }

  /**
   * Mini SQL evaluator that handles the query patterns used by
   * SessionStore and MessageStore.
   */
  async queryWithParams<R = T>(
    sql: string,
    parameters: QueryParameter[] = [],
    options: QueryOptions = {},
  ): Promise<R[]> {
    const paramMap = new Map<string, unknown>();
    for (const p of parameters) {
      paramMap.set(p.name, p.value);
    }

    // Collect all docs, optionally filtered by partition key option
    let candidates: T[] = [];
    for (const doc of this.docs.values()) {
      if (
        options.partitionKey !== undefined &&
        (doc as Record<string, unknown>)[this.partitionKeyPath] !==
          options.partitionKey
      ) {
        continue;
      }
      candidates.push(structuredClone(doc));
    }

    // Apply WHERE conditions
    candidates = candidates.filter((doc) => {
      const obj = doc as Record<string, unknown>;
      return this.evaluateWhere(sql, obj, paramMap);
    });

    // Apply ORDER BY
    const orderMatch = sql.match(
      /ORDER\s+BY\s+c\.(\w+)\s+(ASC|DESC)/i,
    );
    if (orderMatch) {
      const field = orderMatch[1];
      const dir = orderMatch[2].toUpperCase();
      candidates.sort((a, b) => {
        const aVal = (a as Record<string, unknown>)[field];
        const bVal = (b as Record<string, unknown>)[field];
        if (typeof aVal === "number" && typeof bVal === "number") {
          return dir === "ASC" ? aVal - bVal : bVal - aVal;
        }
        const aStr = String(aVal ?? "");
        const bStr = String(bVal ?? "");
        return dir === "ASC"
          ? aStr.localeCompare(bStr)
          : bStr.localeCompare(aStr);
      });
    }

    // Apply TOP (from SQL or maxResults option)
    let limit: number | undefined;
    const topMatch = sql.match(/TOP\s+(@\w+|\d+)/i);
    if (topMatch) {
      const topVal = topMatch[1];
      limit = topVal.startsWith("@")
        ? (paramMap.get(topVal) as number)
        : parseInt(topVal, 10);
    }
    if (options.maxResults !== undefined) {
      limit =
        limit !== undefined
          ? Math.min(limit, options.maxResults)
          : options.maxResults;
    }
    if (limit !== undefined) {
      candidates = candidates.slice(0, limit);
    }

    // Apply projection (c.messageSeq AS messageCount, column selection)
    if (this.hasProjection(sql)) {
      return candidates.map((doc) =>
        this.applyProjection(sql, doc as Record<string, unknown>),
      ) as unknown as R[];
    }

    return candidates as unknown as R[];
  }

  async count(
    whereClause?: string,
    parameters?: QueryParameter[],
    options?: QueryOptions,
  ): Promise<number> {
    if (!whereClause) return this.docs.size;
    // Build a fake SQL so we can reuse evaluateWhere
    const sql = `SELECT COUNT(1) FROM c WHERE ${whereClause}`;
    const results = await this.queryWithParams(sql, parameters, options);
    return results.length;
  }

  // --------------------------------------------------------------------------
  // Raw container mock (for appendMessages optimistic concurrency)
  // --------------------------------------------------------------------------

  getRawContainer(): unknown {
    const docs = this.docs;
    const etags = this.etags;
    const pkPath = this.partitionKeyPath;

    return {
      item(id: string, partitionKey: string) {
        return {
          async read() {
            const doc = docs.get(id);
            if (
              !doc ||
              (doc as Record<string, unknown>)[pkPath] !== partitionKey
            ) {
              return { resource: undefined };
            }
            const etag = etags.get(id);
            return {
              resource: { ...structuredClone(doc), _etag: etag },
            };
          },

          async replace(
            document: unknown,
            opts?: {
              accessCondition?: { type: string; condition: string };
            },
          ) {
            const existing = docs.get(id);
            if (
              !existing ||
              (existing as Record<string, unknown>)[pkPath] !== partitionKey
            ) {
              const err: Record<string, unknown> = new Error(
                "Not found",
              ) as unknown as Record<string, unknown>;
              err.code = 404;
              throw err;
            }
            if (opts?.accessCondition?.condition) {
              const currentEtag = etags.get(id);
              if (
                currentEtag &&
                currentEtag !== opts.accessCondition.condition
              ) {
                const err: Record<string, unknown> = new Error(
                  "Precondition failed",
                ) as unknown as Record<string, unknown>;
                err.code = 412;
                throw err;
              }
            }
            const newEtag = `etag-${Date.now()}-${Math.random()}`;
            docs.set(id, structuredClone(document) as T);
            etags.set(id, newEtag);
            return { resource: structuredClone(document) };
          },
        };
      },
    };
  }

  // --------------------------------------------------------------------------
  // SQL Helpers
  // --------------------------------------------------------------------------

  /**
   * Evaluate WHERE clause conditions against a document.
   * Handles:
   *   c.field = @param         (parameter equality)
   *   c.field = 'literal'      (literal equality)
   *   c.field >= @param        (gte)
   *   c.field < @param         (lt)
   *   c.field > @param         (gt)
   *   Multiple conditions joined by AND
   */
  private evaluateWhere(
    sql: string,
    obj: Record<string, unknown>,
    params: Map<string, unknown>,
  ): boolean {
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:\s+ORDER\s+BY|\s*$)/i);
    if (!whereMatch) return true;

    const whereClause = whereMatch[1];
    // Split on AND (word boundary to avoid matching field names)
    const conditions = whereClause.split(/\s+AND\s+/i);

    for (const cond of conditions) {
      const trimmed = cond.trim();

      // c.field >= @param
      const gteMatch = trimmed.match(/c\.(\w+)\s*>=\s*(@\w+)/);
      if (gteMatch) {
        const val = obj[gteMatch[1]];
        const paramVal = params.get(gteMatch[2]);
        if (typeof val === "number" && typeof paramVal === "number") {
          if (val < paramVal) return false;
        }
        continue;
      }

      // c.field > @param
      const gtMatch = trimmed.match(/c\.(\w+)\s*>\s*(@\w+)/);
      if (gtMatch) {
        const val = obj[gtMatch[1]];
        const paramVal = params.get(gtMatch[2]);
        if (typeof val === "number" && typeof paramVal === "number") {
          if (val <= paramVal) return false;
        }
        continue;
      }

      // c.field < @param
      const ltMatch = trimmed.match(/c\.(\w+)\s*<\s*(@\w+)/);
      if (ltMatch) {
        const val = obj[ltMatch[1]];
        const paramVal = params.get(ltMatch[2]);
        if (typeof val === "number" && typeof paramVal === "number") {
          if (val >= paramVal) return false;
        }
        continue;
      }

      // c.field = 'literal'
      const literalMatch = trimmed.match(/c\.(\w+)\s*=\s*'([^']*)'/);
      if (literalMatch) {
        if (obj[literalMatch[1]] !== literalMatch[2]) return false;
        continue;
      }

      // c.field = @param
      const eqMatch = trimmed.match(/c\.(\w+)\s*=\s*(@\w+)/);
      if (eqMatch) {
        const val = obj[eqMatch[1]];
        const paramVal = params.get(eqMatch[2]);
        if (val !== paramVal) return false;
        continue;
      }
    }

    return true;
  }

  /**
   * Check if the SELECT clause is a projection (not SELECT * or SELECT TOP ... *).
   */
  private hasProjection(sql: string): boolean {
    const selectMatch = sql.match(/SELECT\s+(TOP\s+(?:@\w+|\d+)\s+)?(.+?)\s+FROM/i);
    if (!selectMatch) return false;
    const columns = selectMatch[2].trim();
    return columns !== "*" && !columns.startsWith("COUNT");
  }

  /**
   * Apply column projection including aliased columns like
   * "c.messageSeq AS messageCount".
   */
  private applyProjection(
    sql: string,
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    const selectMatch = sql.match(/SELECT\s+(TOP\s+(?:@\w+|\d+)\s+)?(.+?)\s+FROM/i);
    if (!selectMatch) return obj;

    const columnsPart = selectMatch[2].trim();
    const columns = columnsPart.split(",").map((c) => c.trim());

    const result: Record<string, unknown> = {};
    for (const col of columns) {
      // c.field AS alias
      const aliasMatch = col.match(/c\.(\w+)\s+AS\s+(\w+)/i);
      if (aliasMatch) {
        result[aliasMatch[2]] = obj[aliasMatch[1]];
        continue;
      }
      // c.field
      const fieldMatch = col.match(/c\.(\w+)/);
      if (fieldMatch) {
        result[fieldMatch[1]] = obj[fieldMatch[1]];
      }
    }
    return result;
  }
}

// ============================================================================
// In-Memory Database Provider
// ============================================================================

class InMemoryDatabaseProvider implements DatabaseProvider {
  readonly name = "memory";
  private containers = new Map<string, InMemoryContainer<BaseDocument>>();

  async initialize(): Promise<void> {
    return;
  }

  async getOrCreateContainer<T extends BaseDocument = BaseDocument>(
    options: ContainerOptions,
  ): Promise<ContainerHandle<T>> {
    const id = options.id;
    if (!id) throw new Error("container id required");

    const existing = this.containers.get(id);
    if (existing) return existing as unknown as ContainerHandle<T>;

    // Determine partition key path from options
    const pkPath =
      options.partitionKey?.paths?.[0] ?? "/id";

    const container = new InMemoryContainer<BaseDocument>(pkPath);
    this.containers.set(id, container);
    return container as unknown as ContainerHandle<T>;
  }

  getDatabaseId(): string {
    return "memory";
  }
}

// ============================================================================
// Helpers
// ============================================================================

function msg(role: "user" | "assistant", content: string): SessionMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

function msgWithKey(
  role: "user" | "assistant",
  content: string,
  idempotencyKey: string,
): SessionMessage {
  return { role, content, timestamp: new Date().toISOString(), idempotencyKey };
}

async function setupStore(overrides?: {
  maxHistoryMessages?: number;
  ttlSeconds?: number;
  compactionThreshold?: number;
  compactionRetainCount?: number;
}): Promise<SessionStore> {
  resetSessionConfigCache();
  const db = new InMemoryDatabaseProvider();
  const store = new SessionStore(db, {
    maxHistoryMessages: overrides?.maxHistoryMessages ?? 100,
    ttlSeconds: overrides?.ttlSeconds ?? 86400,
    compactionThreshold: overrides?.compactionThreshold ?? 60,
    compactionRetainCount: overrides?.compactionRetainCount ?? 20,
  });
  await store.initialize();
  return store;
}

// ============================================================================
// Tests -- getOrCreate
// ============================================================================

test("getOrCreate creates a new session with explicit sessionId", async () => {
  const store = await setupStore();
  const session = await store.getOrCreate("u1", "default", "sess-1");

  assert.equal(session.userId, "u1");
  assert.equal(session.agentId, "default");
  assert.equal(session.sessionId, "sess-1");
  assert.equal(session.id, "u1:sess-1");
  assert.equal(session.messageSeq, 0);
  assert.ok(session.createdAt);
  assert.ok(session.updatedAt);
  assert.equal(session.ttl, 86400);

  // No messages array on the session document
  assert.equal((session as Record<string, unknown>).messages, undefined);
});

test("getOrCreate returns existing session", async () => {
  const store = await setupStore();
  const first = await store.getOrCreate("u1", "default", "sess-1");
  const second = await store.getOrCreate("u1", "default", "sess-1");

  assert.equal(first.id, second.id);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(first.createdAt, second.createdAt);
});

test("getOrCreate auto-generates sessionId when omitted", async () => {
  const store = await setupStore();
  const session = await store.getOrCreate("u1", "default");

  assert.ok(session.sessionId);
  assert.ok(session.sessionId.includes("-"));
  assert.equal(session.id, `u1:${session.sessionId}`);
});

test("getOrCreate uses default agentId when omitted", async () => {
  const store = await setupStore();
  const session = await store.getOrCreate("u1", undefined, "sess-1");

  assert.equal(session.agentId, "default");
});

// ============================================================================
// Tests -- get
// ============================================================================

test("get returns null for non-existent session", async () => {
  const store = await setupStore();
  const result = await store.get("u1", "nonexistent");

  assert.equal(result, null);
});

test("get returns existing session", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  const result = await store.get("u1", "sess-1");

  assert.ok(result);
  assert.equal(result.sessionId, "sess-1");
});

test("get enforces userId partition isolation", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  // Different user cannot read u1's session
  const result = await store.get("u2", "sess-1");
  assert.equal(result, null);
});

// ============================================================================
// Tests -- appendMessages
// ============================================================================

test("appendMessages adds messages to session", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  const updated = await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
    msg("assistant", "Hi there!"),
  ]);

  // Session document tracks messageSeq, not an embedded messages array
  assert.equal(updated.messageSeq, 2);

  // Messages are in the separate message store
  const messages = await store.getMessages("u1", "sess-1");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "Hello");
  assert.equal(messages[0].seq, 0);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "Hi there!");
  assert.equal(messages[1].seq, 1);
});

test("appendMessages accumulates across calls", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  await store.appendMessages("u1", "sess-1", [
    msg("user", "First"),
    msg("assistant", "Reply 1"),
  ]);

  const updated = await store.appendMessages("u1", "sess-1", [
    msg("user", "Second"),
    msg("assistant", "Reply 2"),
  ]);

  assert.equal(updated.messageSeq, 4);

  const messages = await store.getMessages("u1", "sess-1");
  assert.equal(messages.length, 4);
  assert.equal(messages[0].content, "First");
  assert.equal(messages[0].seq, 0);
  assert.equal(messages[3].content, "Reply 2");
  assert.equal(messages[3].seq, 3);
});

test("appendMessages resets TTL on each update", async () => {
  const store = await setupStore({ ttlSeconds: 3600 });
  await store.getOrCreate("u1", "default", "sess-1");

  const updated = await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
  ]);

  assert.equal(updated.ttl, 3600);
});

test("appendMessages updates conversationState", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  const updated = await store.appendMessages(
    "u1",
    "sess-1",
    [msg("user", "Hello"), msg("assistant", "Hi")],
    { previousResponseId: "resp-123", containerId: "ctr-456" },
  );

  assert.equal(updated.conversationState?.previousResponseId, "resp-123");
  assert.equal(updated.conversationState?.containerId, "ctr-456");
});

test("appendMessages merges conversationState with existing", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  await store.appendMessages(
    "u1",
    "sess-1",
    [msg("user", "q1"), msg("assistant", "a1")],
    { containerId: "ctr-1" },
  );

  const updated = await store.appendMessages(
    "u1",
    "sess-1",
    [msg("user", "q2"), msg("assistant", "a2")],
    { previousResponseId: "resp-2" },
  );

  // Both fields should be present (shallow merge)
  assert.equal(updated.conversationState?.containerId, "ctr-1");
  assert.equal(updated.conversationState?.previousResponseId, "resp-2");
});

test("appendMessages throws for non-existent session", async () => {
  const store = await setupStore();

  await assert.rejects(
    () => store.appendMessages("u1", "nonexistent", [msg("user", "Hello")]),
    { message: /^Session not found: #[0-9a-f]{12}$/ },
  );
});

test("appendMessages sets lastMessagePreview", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  const updated = await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
    msg("assistant", "The weather is nice today."),
  ]);

  assert.equal(updated.lastMessagePreview, "The weather is nice today.");
});

test("appendMessages truncates long lastMessagePreview", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  const longText = "A".repeat(200);
  const updated = await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
    msg("assistant", longText),
  ]);

  assert.ok(updated.lastMessagePreview);
  assert.ok(updated.lastMessagePreview.length <= 120);
  assert.ok(updated.lastMessagePreview.endsWith("\u2026"));
});

// ============================================================================
// Tests -- delete
// ============================================================================

test("delete removes a session", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  const deleted = await store.delete("u1", "sess-1");
  assert.equal(deleted, true);

  const result = await store.get("u1", "sess-1");
  assert.equal(result, null);
});

test("delete returns false for non-existent session", async () => {
  const store = await setupStore();
  const deleted = await store.delete("u1", "nonexistent");
  assert.equal(deleted, false);
});

// ============================================================================
// Tests -- list
// ============================================================================

test("list returns summaries with messageCount from messageSeq", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
    msg("assistant", "Hi there!"),
  ]);

  const summaries = await store.list("u1");

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].sessionId, "sess-1");
  assert.equal(summaries[0].agentId, "default");
  assert.equal(summaries[0].messageCount, 2);
  assert.ok(summaries[0].createdAt);
  assert.ok(summaries[0].updatedAt);
});

test("list filters by agentId", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "agent-a", "sess-a");
  await store.getOrCreate("u1", "agent-b", "sess-b");

  const filtered = await store.list("u1", "agent-a");

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].sessionId, "sess-a");
});

test("list respects limit", async () => {
  const store = await setupStore();
  for (let i = 0; i < 5; i++) {
    await store.getOrCreate("u1", "default", `sess-${i}`);
    // Ensure distinct updatedAt for ordering
    await store.appendMessages("u1", `sess-${i}`, [
      msg("user", `msg-${i}`),
    ]);
  }

  const limited = await store.list("u1", undefined, { limit: 3 });
  assert.equal(limited.length, 3);
});

test("list returns lastMessage from denormalized preview", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
    msg("assistant", "Goodbye"),
  ]);

  const summaries = await store.list("u1");

  assert.equal(summaries[0].lastMessage, "Goodbye");
});

test("list isolates users", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.getOrCreate("u2", "default", "sess-2");

  const u1Sessions = await store.list("u1");
  const u2Sessions = await store.list("u2");

  assert.equal(u1Sessions.length, 1);
  assert.equal(u1Sessions[0].sessionId, "sess-1");
  assert.equal(u2Sessions.length, 1);
  assert.equal(u2Sessions[0].sessionId, "sess-2");
});

// ============================================================================
// Tests -- getProviderHistory
// ============================================================================

test("getProviderHistory maps messages to provider format", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  const session = await store.appendMessages("u1", "sess-1", [
    msg("user", "What is 2+2?"),
    msg("assistant", "4"),
  ]);

  const { history } = await store.getProviderHistory(session);

  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: "user", content: "What is 2+2?" });
  assert.deepEqual(history[1], { role: "assistant", content: "4" });
});

test("getProviderHistory filters empty content messages", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
    msg("assistant", ""), // Empty -- should be filtered
  ]);
  const session = await store.appendMessages("u1", "sess-1", [
    msg("user", "Try again"),
    msg("assistant", "Here you go"),
  ]);

  const { history } = await store.getProviderHistory(session);

  assert.equal(history.length, 3);
  assert.equal(history[0].content, "Hello");
  assert.equal(history[1].content, "Try again");
  assert.equal(history[2].content, "Here you go");
});

test("getProviderHistory returns empty array for empty session", async () => {
  const store = await setupStore();
  const session = await store.getOrCreate("u1", "default", "sess-1");

  const { history } = await store.getProviderHistory(session);

  assert.deepEqual(history, []);
});

// ============================================================================
// Tests -- getMessages
// ============================================================================

test("getMessages returns messages in chronological order", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.appendMessages("u1", "sess-1", [
    msg("user", "First"),
    msg("assistant", "Second"),
  ]);
  await store.appendMessages("u1", "sess-1", [
    msg("user", "Third"),
    msg("assistant", "Fourth"),
  ]);

  const messages = await store.getMessages("u1", "sess-1");

  assert.equal(messages.length, 4);
  assert.equal(messages[0].content, "First");
  assert.equal(messages[0].seq, 0);
  assert.equal(messages[1].content, "Second");
  assert.equal(messages[1].seq, 1);
  assert.equal(messages[2].content, "Third");
  assert.equal(messages[2].seq, 2);
  assert.equal(messages[3].content, "Fourth");
  assert.equal(messages[3].seq, 3);
});

test("getMessages returns empty array for session with no messages", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");

  const messages = await store.getMessages("u1", "sess-1");

  assert.deepEqual(messages, []);
});

// ============================================================================
// Tests -- updateCompaction
// ============================================================================

test("updateCompaction updates compaction summary on session", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.appendMessages("u1", "sess-1", [
    msg("user", "q1"),
    msg("assistant", "a1"),
    msg("user", "q2"),
    msg("assistant", "a2"),
  ]);

  await store.updateCompaction(
    "u1",
    "sess-1",
    "Summary of conversation about q1 and q2.",
    3,
  );

  const session = await store.get("u1", "sess-1");
  assert.ok(session);
  assert.equal(
    session.compactionSummary,
    "Summary of conversation about q1 and q2.",
  );
  assert.equal(session.lastCompactedSeq, 3);
  assert.ok(session.lastCompactedAt);
});

test("updateCompaction preserves other session fields", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  const updated = await store.appendMessages(
    "u1",
    "sess-1",
    [msg("user", "q1"), msg("assistant", "a1")],
    { previousResponseId: "resp-1" },
  );

  await store.updateCompaction("u1", "sess-1", "My summary", 1);

  const session = await store.get("u1", "sess-1");
  assert.ok(session);
  assert.equal(session.compactionSummary, "My summary");
  assert.equal(session.lastCompactedSeq, 1);
  // Preserved fields
  assert.equal(session.userId, "u1");
  assert.equal(session.agentId, "default");
  assert.equal(session.sessionId, "sess-1");
  assert.equal(session.messageSeq, updated.messageSeq);
  // The provider chain holds the compacted turns: it's dropped.
  assert.equal(session.conversationState, undefined);
});

// ============================================================================
// Tests -- findByIdempotencyKey
// ============================================================================

test("findByIdempotencyKey returns assistant message for matching key", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.appendMessages("u1", "sess-1", [
    msgWithKey("user", "Hello", "idem-1"),
    msg("assistant", "Hi there!"),
  ]);

  const found = await store.findByIdempotencyKey((await store.get("u1", "sess-1"))!, "idem-1");

  assert.ok(found);
  assert.equal(found.role, "assistant");
  assert.equal(found.content, "Hi there!");
});

test("findByIdempotencyKey returns null for non-existent key", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "sess-1");
  await store.appendMessages("u1", "sess-1", [
    msg("user", "Hello"),
    msg("assistant", "Hi"),
  ]);

  const found = await store.findByIdempotencyKey((await store.get("u1", "sess-1"))!, "no-such-key");

  assert.equal(found, null);
});

// ============================================================================
// Tests -- tenant isolation (messages are only reachable through the owner's session)
// ============================================================================

async function setupStoreWithDb(): Promise<{ store: SessionStore; db: InMemoryDatabaseProvider }> {
  resetSessionConfigCache();
  const db = new InMemoryDatabaseProvider();
  const store = new SessionStore(db, { maxHistoryMessages: 100, ttlSeconds: 86400 });
  await store.initialize();
  return { store, db };
}

test("two users with the same sessionId never see or touch each other's messages", async () => {
  const store = await setupStore();
  await store.getOrCreate("alice", "default", "shared-id");
  await store.appendMessages("alice", "shared-id", [msg("user", "alice secret"), msg("assistant", "ok")]);

  // Bob reuses Alice's sessionId (e.g. guessed "telegram-<chatId>").
  const bob = await store.getOrCreate("bob", "default", "shared-id");
  assert.equal(bob.messageSeq, 0);
  assert.deepEqual((await store.getProviderHistory(bob)).history, []);

  // Bob can append without colliding with Alice's message ids…
  await store.appendMessages("bob", "shared-id", [msg("user", "bob here")]);
  assert.deepEqual(
    (await store.getMessages("bob", "shared-id")).map((m) => m.content),
    ["bob here"],
  );

  // …and deleting his session leaves Alice's messages intact.
  await store.delete("bob", "shared-id");
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget purge run
  assert.deepEqual(
    (await store.getMessages("alice", "shared-id")).map((m) => m.content),
    ["alice secret", "ok"],
  );
});

test("reading messages of a session the caller doesn't own returns nothing", async () => {
  const store = await setupStore();
  await store.getOrCreate("alice", "default", "s1");
  await store.appendMessages("alice", "s1", [msg("user", "private")]);

  assert.deepEqual(await store.getMessages("mallory", "s1"), []);
  assert.deepEqual(await store.getAllMessages("mallory", "s1"), []);
});

test("a session recreated after /new starts empty with fresh message ids", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "telegram-42");
  await store.appendMessages("u1", "telegram-42", [msg("user", "old"), msg("assistant", "old reply")]);
  await store.delete("u1", "telegram-42");

  const again = await store.getOrCreate("u1", "default", "telegram-42");
  assert.equal(again.messageSeq, 0);
  assert.deepEqual((await store.getProviderHistory(again)).history, []);
  // Same seq numbers as the old messages, but no id collision.
  await store.appendMessages("u1", "telegram-42", [msg("user", "new")]);
  assert.deepEqual((await store.getMessages("u1", "telegram-42")).map((m) => m.content), ["new"]);
});

test("a session recreated after TTL expiry doesn't inherit stale history", async () => {
  const { store, db } = await setupStoreWithDb();
  const first = await store.getOrCreate("u1", "default", "whatsapp-9");
  await store.appendMessages("u1", "whatsapp-9", [msg("user", "stale")]);

  // TTL removes the session doc but not its messages.
  const sessions = await db.getOrCreateContainer<Session>({ id: "sessions" });
  await sessions.delete(first.id, "u1");

  const fresh = await store.getOrCreate("u1", "default", "whatsapp-9");
  assert.notEqual(fresh.instanceId, first.instanceId);
  assert.deepEqual((await store.getProviderHistory(fresh)).history, []);
  await store.appendMessages("u1", "whatsapp-9", [msg("user", "fresh")]);
  assert.deepEqual((await store.getMessages("u1", "whatsapp-9")).map((m) => m.content), ["fresh"]);
});

test("group chat members keep separate histories and /new only resets the caller's", async () => {
  const store = await setupStore();
  for (const member of ["m1", "m2"]) {
    await store.getOrCreate(member, "default", "telegram--100123");
    await store.appendMessages(member, "telegram--100123", [msg("user", `hi from ${member}`)]);
  }
  await store.delete("m1", "telegram--100123");
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(
    (await store.getMessages("m2", "telegram--100123")).map((m) => m.content),
    ["hi from m2"],
  );
});

test("message documents carry the owner-scoped partition key and a TTL", async () => {
  const store = await setupStore();
  const s = await store.getOrCreate("u1", "default", "s1");
  await store.appendMessages("u1", "s1", [msg("user", "x")]);
  const [m] = await store.getMessages("u1", "s1");
  assert.equal(m.pk, messagePartitionKey(s));
  assert.equal(m.pk, `u1:s1:${s.instanceId}`);
  assert.equal(m.userId, "u1");
  assert.equal(typeof m.ttl, "number");
});

test("a write meant for a replaced session instance is refused (e.g. a reply finishing after /new)", async () => {
  const store = await setupStore();
  const before = await store.getOrCreate("u1", "default", "s1");
  await store.delete("u1", "s1");
  await store.getOrCreate("u1", "default", "s1"); // new instance

  await assert.rejects(
    store.appendMessages("u1", "s1", [msg("assistant", "late reply")], undefined, undefined, before.instanceId),
    SessionReplacedError,
  );
  assert.deepEqual(await store.getMessages("u1", "s1"), []);
});

test("a compaction that started before another one finished is refused", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "s1");
  // Both started from lastCompactedSeq 0; the later-starting one (to 42) wins.
  assert.equal(await store.updateCompaction("u1", "s1", "summary to 42", 42, undefined, 0), true);
  assert.equal(await store.updateCompaction("u1", "s1", "summary to 40", 40, undefined, 0), false);
  const after = await store.get("u1", "s1");
  assert.equal(after?.lastCompactedSeq, 42);
  assert.equal(after?.compactionSummary, "summary to 42");
});

test("compaction drops the provider chain but keeps the code-interpreter container", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "s1");
  await store.appendMessages("u1", "s1", [msg("user", "q"), msg("assistant", "a")], {
    previousResponseId: "resp-9",
    containerId: "cntr-1",
  });
  await store.updateCompaction("u1", "s1", "summary", 1);
  const after = await store.get("u1", "s1");
  assert.deepEqual(after?.conversationState, { containerId: "cntr-1" });
});

test("a turn that was running when compaction landed can't bring the old chain back", async () => {
  const store = await setupStore();
  const loaded = await store.getOrCreate("u1", "default", "s1");
  await store.appendMessages("u1", "s1", [msg("user", "q"), msg("assistant", "a")], {
    previousResponseId: "resp-1",
    containerId: "cntr-1",
  });
  // Compaction lands while the next turn is streaming from resp-1.
  await store.updateCompaction("u1", "s1", "summary", 1);
  await store.appendMessages(
    "u1",
    "s1",
    [msg("user", "q2"), msg("assistant", "a2")],
    { previousResponseId: "resp-2", containerId: "cntr-1" },
    undefined,
    undefined,
    undefined,
    loaded.lastCompactedSeq ?? 0,
  );
  assert.deepEqual((await store.get("u1", "s1"))?.conversationState, { containerId: "cntr-1" });

  // The next turn, loaded after the compaction, chains again.
  const after = (await store.get("u1", "s1"))!;
  await store.appendMessages("u1", "s1", [msg("user", "q3")], { previousResponseId: "resp-3" }, undefined, undefined, undefined, after.lastCompactedSeq ?? 0);
  assert.equal((await store.get("u1", "s1"))?.conversationState?.previousResponseId, "resp-3");
});

test("compaction results for a replaced instance aren't written onto the new session", async () => {
  const store = await setupStore();
  const before = await store.getOrCreate("u1", "default", "s1");
  await store.delete("u1", "s1");
  await store.getOrCreate("u1", "default", "s1");

  await store.updateCompaction("u1", "s1", "old conversation summary", 40, before.instanceId);
  const after = await store.get("u1", "s1");
  assert.equal(after?.compactionSummary, undefined);
  assert.equal(after?.lastCompactedSeq, undefined);
});

test("run lease: one holder at a time, released by its holder, expires on its own", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "s-lease");
  const now = Date.now();

  assert.equal(await store.acquireRunLease("u1", "s-lease", "run-a", now + 60_000, now), true);
  assert.equal(await store.acquireRunLease("u1", "s-lease", "run-b", now + 60_000, now), false);
  // A second execution of the same request (retry, redelivery) is refused too.
  assert.equal(await store.acquireRunLease("u1", "s-lease", "run-a", now + 90_000, now), false);

  await store.releaseRunLease("u1", "s-lease", "run-b"); // not the holder: no effect
  assert.equal(await store.acquireRunLease("u1", "s-lease", "run-b", now + 60_000, now), false);

  await store.releaseRunLease("u1", "s-lease", "run-a");
  assert.equal(await store.acquireRunLease("u1", "s-lease", "run-b", now + 60_000, now), true);

  // A holder that died: its lease lapses.
  assert.equal(await store.acquireRunLease("u1", "s-lease", "run-c", now + 60_000, now + 61_000), true);
});

test("appending messages keeps the run lease", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "s-lease2");
  const now = Date.now();
  await store.acquireRunLease("u1", "s-lease2", "run-a", now + 60_000, now);
  await store.appendMessages("u1", "s-lease2", [msg("user", "hi")]);
  assert.equal(await store.acquireRunLease("u1", "s-lease2", "run-b", now + 60_000, now), false);
});

test("run lease: renewed while alive, lost once it lapses", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "s-renew");
  const t0 = Date.now();
  assert.equal(await store.acquireRunLease("u1", "s-renew", "lease-a", t0 + 60_000, t0, "run-a"), true);
  assert.equal((await store.peekActiveRun("u1", "s-renew"))?.runId, "run-a");
  assert.equal(await store.renewRunLease("u1", "s-renew", "lease-a", t0 + 120_000), true);
  // Still held at t0 + 90 s thanks to the renewal.
  assert.equal(await store.acquireRunLease("u1", "s-renew", "lease-b", t0 + 150_000, t0 + 90_000, "run-b"), false);
  // After it lapses another execution takes it, and the old holder can't renew.
  assert.equal(await store.acquireRunLease("u1", "s-renew", "lease-b", t0 + 200_000, t0 + 121_000, "run-b"), true);
  assert.equal(await store.renewRunLease("u1", "s-renew", "lease-a", t0 + 240_000), false);
});

test("appending is refused for an execution that no longer holds the run lease", async () => {
  const store = await setupStore();
  await store.getOrCreate("u1", "default", "s-fence");
  const now = Date.now();
  await store.acquireRunLease("u1", "s-fence", "lease-a", now + 60_000, now, "run-a");
  await store.appendMessages("u1", "s-fence", [msg("user", "ok")], undefined, undefined, undefined, "lease-a");
  // lease-a lapses and lease-b takes over
  await store.acquireRunLease("u1", "s-fence", "lease-b", now + 200_000, now + 61_000, "run-b");
  await assert.rejects(
    store.appendMessages("u1", "s-fence", [msg("assistant", "stale")], undefined, undefined, undefined, "lease-a"),
    /Run lease lost/,
  );
});
