import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage, type StorageAdapter } from "@agentforeach/storage";
import { MessageStore } from "./messages-store.js";
import { resetSessionConfigCache } from "./config.js";
import type { MessageDocument } from "./types.js";

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
  const db = new InMemoryStorage();
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

// ============================================================================
// Tests -- guards
// ============================================================================

test("append refuses a message outside the given partition", async () => {
  const store = await setup();
  await assert.rejects(store.append("pkA", [makeMsg("pkB", 0, "user", "x")]), /every message must be in the given partition/);
});

test("a messages container partitioned on the wrong key fails startup with the upgrade advice", async () => {
  resetSessionConfigCache();
  const wrongKey: StorageAdapter = {
    name: "stub",
    capabilities: { vectorSearch: false, hybridSearch: false },
    async initialize() {},
    async collection(spec) {
      // What the Cosmos adapter reports for an old "session-messages" container.
      throw new Error(`cosmosdb: container "${spec.name}" is partitioned on /sessionId, expected /pk`);
    },
  };
  const store = new MessageStore(wrongKey, {
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
  });
  await assert.rejects(store.initialize(), (err: Error) => {
    assert.match(err.message, /Messages container "session-messages" is partitioned on \/sessionId, expected \/pk\./);
    assert.match(err.message, /session-messages-v2/);
    return true;
  });
});
