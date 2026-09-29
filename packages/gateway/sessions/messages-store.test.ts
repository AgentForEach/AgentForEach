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
import { MessageStore } from "./messages-store.js";
import { resetSessionConfigCache } from "./config.js";
import type { MessageDocument } from "./types.js";

// ============================================================================
// In-Memory Database Mock
// ============================================================================

/**
 * In-memory container that is partition-key aware and supports the subset
 * of Cosmos SQL used by MessageStore:
 *
 *   - Equality:           c.sessionId = @sid
 *   - Literal equality:   c.role = 'user', c.role = 'assistant'
 *   - Parameter equality:  c.idempotencyKey = @key
 *   - Range:              c.seq >= @from, c.seq < @to, c.seq > @seq, c.seq < @before
 *   - ORDER BY:           c.seq DESC/ASC
 *   - TOP @limit
 *   - Projection:         SELECT c.id FROM c ...
 */
class InMemoryContainer<T extends BaseDocument> implements ContainerHandle<T> {
  private docs = new Map<string, T>();
  private etags = new Map<string, string>();
  private partitionKeyPath: string;

  constructor(partitionKeyPath = "/userId") {
    // Strip leading slash: "/sessionId" -> "sessionId"
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
   * Mini SQL evaluator that handles the query patterns used by MessageStore.
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
    const orderMatch = sql.match(/ORDER\s+BY\s+c\.(\w+)\s+(ASC|DESC)/i);
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

    // Apply projection (column selection like SELECT c.id FROM ...)
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

  getRawContainer(): unknown {
    return {};
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
    const selectMatch = sql.match(
      /SELECT\s+(TOP\s+(?:@\w+|\d+)\s+)?(.+?)\s+FROM/i,
    );
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
    const selectMatch = sql.match(
      /SELECT\s+(TOP\s+(?:@\w+|\d+)\s+)?(.+?)\s+FROM/i,
    );
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
    const pkPath = options.partitionKey?.paths?.[0] ?? "/id";

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

/** `pk` doubles as the session id here: MessageStore only sees partitions. */
function makeMsg(
  pk: string,
  seq: number,
  role: "user" | "assistant",
  content: string,
  extra?: Partial<MessageDocument>,
): MessageDocument {
  return {
    id: `${pk}:${String(seq).padStart(6, "0")}`,
    pk,
    sessionId: pk,
    userId: "test-user",
    seq,
    role,
    content,
    timestamp: new Date(Date.now() + seq * 1000).toISOString(),
    ...extra,
  };
}

// ============================================================================
// Setup
// ============================================================================

interface SessionConfig {
  containerId: string;
  messagesContainerId: string;
  ttlSeconds: number;
  messageTtlSeconds: number;
  maxHistoryMessages: number;
  defaultAgentId: string;
  compactionThreshold: number;
  compactionRetainCount: number;
  compactionModel?: string;
  compactionTemperature: number;
  compactionMaxOutputTokens: number;
  maxPreviewLength: number;
}

async function setup(overrides?: Partial<SessionConfig>): Promise<MessageStore> {
  resetSessionConfigCache();
  const db = new InMemoryDatabaseProvider();
  const config: SessionConfig = {
    containerId: "sessions",
    messagesContainerId: "session-messages",
    ttlSeconds: 86400,
    messageTtlSeconds: 604800,
    maxHistoryMessages: 100,
    defaultAgentId: "default",
    compactionThreshold: 60,
    compactionRetainCount: 20,
    compactionTemperature: 0.3,
    compactionMaxOutputTokens: 4000,
    maxPreviewLength: 120,
    ...overrides,
  };
  const store = new MessageStore(db, config);
  await store.initialize();
  return store;
}

// ============================================================================
// Tests -- append + getRecent
// ============================================================================

test("append + getRecent — stores and retrieves messages in correct chronological order", async () => {
  const store = await setup();
  const sid = "sess-1";

  const messages = [
    makeMsg(sid, 0, "user", "Hello"),
    makeMsg(sid, 1, "assistant", "Hi there!"),
    makeMsg(sid, 2, "user", "How are you?"),
    makeMsg(sid, 3, "assistant", "I am well, thanks!"),
  ];
  await store.append(sid, messages);

  const recent = await store.getRecent(sid);

  assert.equal(recent.length, 4);
  // Returned in seq ASC (chronological) order
  assert.equal(recent[0].seq, 0);
  assert.equal(recent[0].content, "Hello");
  assert.equal(recent[0].role, "user");
  assert.equal(recent[1].seq, 1);
  assert.equal(recent[1].content, "Hi there!");
  assert.equal(recent[1].role, "assistant");
  assert.equal(recent[2].seq, 2);
  assert.equal(recent[2].content, "How are you?");
  assert.equal(recent[3].seq, 3);
  assert.equal(recent[3].content, "I am well, thanks!");
});

// ============================================================================
// Tests -- getRecent with limit
// ============================================================================

test("getRecent with limit — returns only the most recent N messages", async () => {
  const store = await setup();
  const sid = "sess-2";

  const messages = [
    makeMsg(sid, 0, "user", "msg-0"),
    makeMsg(sid, 1, "assistant", "msg-1"),
    makeMsg(sid, 2, "user", "msg-2"),
    makeMsg(sid, 3, "assistant", "msg-3"),
    makeMsg(sid, 4, "user", "msg-4"),
    makeMsg(sid, 5, "assistant", "msg-5"),
  ];
  await store.append(sid, messages);

  const recent = await store.getRecent(sid, 3);

  assert.equal(recent.length, 3);
  // Should be the last 3 messages in chronological (ASC) order
  assert.equal(recent[0].seq, 3);
  assert.equal(recent[0].content, "msg-3");
  assert.equal(recent[1].seq, 4);
  assert.equal(recent[1].content, "msg-4");
  assert.equal(recent[2].seq, 5);
  assert.equal(recent[2].content, "msg-5");
});

// ============================================================================
// Tests -- getRecent uses config.maxHistoryMessages as default limit
// ============================================================================

test("getRecent uses config.maxHistoryMessages as default limit", async () => {
  const store = await setup({ maxHistoryMessages: 2 });
  const sid = "sess-3";

  const messages = [
    makeMsg(sid, 0, "user", "msg-0"),
    makeMsg(sid, 1, "assistant", "msg-1"),
    makeMsg(sid, 2, "user", "msg-2"),
    makeMsg(sid, 3, "assistant", "msg-3"),
  ];
  await store.append(sid, messages);

  // No explicit limit — should use config.maxHistoryMessages (2)
  const recent = await store.getRecent(sid);

  assert.equal(recent.length, 2);
  // Should be the last 2 messages in chronological order
  assert.equal(recent[0].seq, 2);
  assert.equal(recent[0].content, "msg-2");
  assert.equal(recent[1].seq, 3);
  assert.equal(recent[1].content, "msg-3");
});

// ============================================================================
// Tests -- getAll
// ============================================================================

test("getAll — returns all messages ordered by seq ASC", async () => {
  const store = await setup();
  const sid = "sess-4";

  const messages = [
    makeMsg(sid, 0, "user", "first"),
    makeMsg(sid, 1, "assistant", "second"),
    makeMsg(sid, 2, "user", "third"),
  ];
  await store.append(sid, messages);

  const all = await store.getAll(sid);

  assert.equal(all.length, 3);
  assert.equal(all[0].seq, 0);
  assert.equal(all[0].content, "first");
  assert.equal(all[1].seq, 1);
  assert.equal(all[1].content, "second");
  assert.equal(all[2].seq, 2);
  assert.equal(all[2].content, "third");
});

// ============================================================================
// Tests -- getRange
// ============================================================================

test("getRange — returns correct seq range [fromSeq, toSeq)", async () => {
  const store = await setup();
  const sid = "sess-5";

  const messages = [
    makeMsg(sid, 0, "user", "msg-0"),
    makeMsg(sid, 1, "assistant", "msg-1"),
    makeMsg(sid, 2, "user", "msg-2"),
    makeMsg(sid, 3, "assistant", "msg-3"),
    makeMsg(sid, 4, "user", "msg-4"),
    makeMsg(sid, 5, "assistant", "msg-5"),
  ];
  await store.append(sid, messages);

  const range = await store.getRange(sid, 1, 4);

  assert.equal(range.length, 3);
  assert.equal(range[0].seq, 1);
  assert.equal(range[0].content, "msg-1");
  assert.equal(range[1].seq, 2);
  assert.equal(range[1].content, "msg-2");
  assert.equal(range[2].seq, 3);
  assert.equal(range[2].content, "msg-3");
});

// ============================================================================
// Tests -- deleteBefore
// ============================================================================

test("deleteBefore — removes messages with seq < threshold", async () => {
  const store = await setup();
  const sid = "sess-6";

  const messages = [
    makeMsg(sid, 0, "user", "msg-0"),
    makeMsg(sid, 1, "assistant", "msg-1"),
    makeMsg(sid, 2, "user", "msg-2"),
    makeMsg(sid, 3, "assistant", "msg-3"),
    makeMsg(sid, 4, "user", "msg-4"),
    makeMsg(sid, 5, "assistant", "msg-5"),
  ];
  await store.append(sid, messages);

  const deletedCount = await store.deleteBefore(sid, 3);

  assert.equal(deletedCount, 3);

  const remaining = await store.getAll(sid);
  assert.equal(remaining.length, 3);
  // Only messages with seq >= 3 remain
  assert.equal(remaining[0].seq, 3);
  assert.equal(remaining[1].seq, 4);
  assert.equal(remaining[2].seq, 5);
});

// ============================================================================
// Tests -- findByIdempotencyKey
// ============================================================================

test("findByIdempotencyKey — finds user message and returns following assistant message", async () => {
  const store = await setup();
  const sid = "sess-7";

  const messages = [
    makeMsg(sid, 0, "user", "Hello", { idempotencyKey: "key-1" }),
    makeMsg(sid, 1, "assistant", "Hi there!"),
  ];
  await store.append(sid, messages);

  const found = await store.findByIdempotencyKey(sid, "key-1");

  assert.ok(found);
  assert.equal(found.role, "assistant");
  assert.equal(found.content, "Hi there!");
  assert.equal(found.seq, 1);
});

test("findByIdempotencyKey — returns null for non-existent key", async () => {
  const store = await setup();
  const sid = "sess-8";

  const found = await store.findByIdempotencyKey(sid, "nonexistent");

  assert.equal(found, null);
});

// ============================================================================
// Tests -- count
// ============================================================================

test("count — returns correct message count", async () => {
  const store = await setup();
  const sid = "sess-9";

  const messages = [
    makeMsg(sid, 0, "user", "msg-0"),
    makeMsg(sid, 1, "assistant", "msg-1"),
    makeMsg(sid, 2, "user", "msg-2"),
  ];
  await store.append(sid, messages);

  const n = await store.count(sid);

  assert.equal(n, 3);
});

// ============================================================================
// Tests -- append with seq padding
// ============================================================================

test("append with seq padding — IDs are correctly formatted", async () => {
  const store = await setup();
  const sid = "sess";

  const messages = [makeMsg(sid, 42, "user", "msg-42")];
  await store.append(sid, messages);

  const all = await store.getAll(sid);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "sess:000042");
  assert.equal(all[0].seq, 42);
});

// ============================================================================
// Tests -- findByIdempotencyKey with empty/whitespace key
// ============================================================================

test("findByIdempotencyKey — returns null for empty/whitespace key", async () => {
  const store = await setup();
  const sid = "sess-10";

  // Append some messages so the store is non-empty
  const messages = [
    makeMsg(sid, 0, "user", "Hello", { idempotencyKey: "real-key" }),
    makeMsg(sid, 1, "assistant", "Hi"),
  ];
  await store.append(sid, messages);

  const foundEmpty = await store.findByIdempotencyKey(sid, "");
  assert.equal(foundEmpty, null);

  const foundWhitespace = await store.findByIdempotencyKey(sid, "  ");
  assert.equal(foundWhitespace, null);

  const foundTab = await store.findByIdempotencyKey(sid, "\t");
  assert.equal(foundTab, null);
});

// ============================================================================
// Tests -- session isolation
// ============================================================================

test("messages are isolated between sessions", async () => {
  const store = await setup();

  const msgs1 = [
    makeMsg("sess-1", 0, "user", "sess-1 msg-0"),
    makeMsg("sess-1", 1, "assistant", "sess-1 msg-1"),
  ];
  const msgs2 = [
    makeMsg("sess-2", 0, "user", "sess-2 msg-0"),
    makeMsg("sess-2", 1, "assistant", "sess-2 msg-1"),
    makeMsg("sess-2", 2, "user", "sess-2 msg-2"),
  ];

  await store.append("sess-1", msgs1);
  await store.append("sess-2", msgs2);

  const all1 = await store.getAll("sess-1");
  const all2 = await store.getAll("sess-2");

  // sess-1 only has its own 2 messages
  assert.equal(all1.length, 2);
  assert.equal(all1[0].sessionId, "sess-1");
  assert.equal(all1[0].content, "sess-1 msg-0");
  assert.equal(all1[1].sessionId, "sess-1");
  assert.equal(all1[1].content, "sess-1 msg-1");

  // sess-2 only has its own 3 messages
  assert.equal(all2.length, 3);
  assert.equal(all2[0].sessionId, "sess-2");
  assert.equal(all2[0].content, "sess-2 msg-0");
  assert.equal(all2[1].sessionId, "sess-2");
  assert.equal(all2[2].sessionId, "sess-2");

  // count is also isolated
  const count1 = await store.count("sess-1");
  const count2 = await store.count("sess-2");
  assert.equal(count1, 2);
  assert.equal(count2, 3);
});
