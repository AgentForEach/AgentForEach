import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage } from "@agentforeach/storage";
import {
  SessionStore,
  SessionReplacedError,
  messagePartitionKey,
  resetSessionConfigCache,
} from "./index.js";
import type { Session, SessionMessage } from "./types.js";

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
  const db = new InMemoryStorage();
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

async function setupStoreWithDb(): Promise<{ store: SessionStore; db: InMemoryStorage }> {
  resetSessionConfigCache();
  const db = new InMemoryStorage();
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
  const sessions = db.getCollection<Session>("sessions");
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

// ============================================================================
// Tests -- storage SDK review: ordering, scoping, races
// ============================================================================

test("list returns the newest sessions first, exactly `limit` of them", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 1) });
  const store = await setupStore();
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1000);
    await store.getOrCreate("u1", "default", `sess-${i}`);
    await store.appendMessages("u1", `sess-${i}`, [msg("user", `msg-${i}`)]);
  }
  const page = await store.list("u1", undefined, { limit: 3 });
  assert.deepEqual(page.map((s) => s.sessionId), ["sess-4", "sess-3", "sess-2"]);
  assert.equal((await store.list("u1", undefined, { limit: 2.7 })).length, 2, "fractional limits are floored");
  assert.equal((await store.list("u1", undefined, { limit: Number.NaN })).length, 5, "a NaN limit falls back to the default");
});

test("findLastChannel finds the newest session with a channel and chat, past any number of others", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 1) });
  const { store } = await setupStoreWithDb();
  await store.getOrCreate("u1", "default", "telegram-42");
  await store.appendMessages("u1", "telegram-42", [msg("user", "hi")], undefined, { lastChannelName: "telegram", lastChatId: "42" });
  // Twelve scheduled-run sessions updated since, with a channel name but no chat.
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(1000);
    await store.getOrCreate("u1", "default", `cron:job-${i}`);
    await store.appendMessages("u1", `cron:job-${i}`, [msg("assistant", "ran")], undefined, { lastChannelName: "cron" });
  }
  assert.deepEqual(await store.findLastChannel("u1"), { channelName: "telegram", chatId: "42" });

  t.mock.timers.tick(1000);
  await store.getOrCreate("u1", "default", "whatsapp-7");
  await store.appendMessages("u1", "whatsapp-7", [msg("user", "yo")], undefined, { lastChannelName: "whatsapp", lastChatId: "7" });
  assert.deepEqual(await store.findLastChannel("u1"), { channelName: "whatsapp", chatId: "7" }, "the newest wins");
  assert.equal(await store.findLastChannel("nobody"), undefined);
});

test("appendMessages retries past a concurrent write: seqs stay contiguous and the other write is kept", async () => {
  const { store, db } = await setupStoreWithDb();
  const s = await store.getOrCreate("u1", "default", "s1");
  await store.appendMessages("u1", "s1", [msg("user", "one")]);
  const sessions = db.getCollection<Session>("sessions");
  let raced = false;
  const remove = sessions.beforeOperation(async ({ op }) => {
    if (op === "replace" && !raced) {
      raced = true;
      const current = sessions.peek<Session>(s.id, "u1")!;
      await sessions.upsert({ ...current, metadata: { ...current.metadata, note: "concurrent" } });
    }
  });
  await store.appendMessages("u1", "s1", [msg("assistant", "two"), msg("user", "three")]);
  remove();
  const after = await store.get("u1", "s1");
  assert.equal(after?.messageSeq, 3);
  assert.equal(after?.metadata?.note, "concurrent");
  assert.deepEqual((await store.getAllMessages("u1", "s1")).map((m) => [m.seq, m.content]), [[0, "one"], [1, "two"], [2, "three"]]);
});

test("concurrent getOrCreate of one session returns the same instance", async () => {
  const store = await setupStore();
  const [a, b, c] = await Promise.all([
    store.getOrCreate("u1", "default", "same"),
    store.getOrCreate("u1", "default", "same"),
    store.getOrCreate("u1", "default", "same"),
  ]);
  assert.equal(a.instanceId, b.instanceId);
  assert.equal(b.instanceId, c.instanceId);
});

test("findByIdempotencyKey returns the reply that followed that request, not a later one", async () => {
  const store = await setupStore();
  const s = await store.getOrCreate("u1", "default", "s1");
  await store.appendMessages("u1", "s1", [msgWithKey("user", "first", "k1"), msg("assistant", "reply A")]);
  await store.appendMessages("u1", "s1", [msgWithKey("user", "second", "k2"), msg("assistant", "reply B")]);
  assert.equal((await store.findByIdempotencyKey(s, "k1"))?.content, "reply A");
  assert.equal((await store.findByIdempotencyKey(s, "k2"))?.content, "reply B");
});

test("session and message queries are scoped to one partition", async () => {
  const { store, db } = await setupStoreWithDb();
  const s = await store.getOrCreate("u1", "default", "s1");
  await store.appendMessages("u1", "s1", [msgWithKey("user", "q", "k"), msg("assistant", "a")]);
  const seen: Array<{ op: string; partitionKey?: string }> = [];
  for (const name of ["sessions", "session-messages-v2"]) {
    db.getCollection(name).beforeOperation(({ op, partitionKey }) => {
      if (op === "find" || op === "count") seen.push({ op, partitionKey });
    });
  }
  await store.list("u1");
  await store.getMessages("u1", "s1");
  await store.getAllMessages("u1", "s1");
  await store.findByRunId(s, "r");
  await store.findByIdempotencyKey(s, "k");
  await store.findLastChannel("u1");
  assert.ok(seen.length >= 6);
  assert.ok(seen.every((q) => typeof q.partitionKey === "string" && q.partitionKey.startsWith("u1")), JSON.stringify(seen));
});

test("findLastChannel skips sessions whose channel or chat is null or empty", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 1) });
  const { store, db } = await setupStoreWithDb();
  await store.getOrCreate("u1", "default", "good");
  await store.appendMessages("u1", "good", [msg("user", "hi")], undefined, { lastChannelName: "telegram", lastChatId: "42" });
  t.mock.timers.tick(1000);
  await store.getOrCreate("u1", "default", "empty-chat");
  await store.appendMessages("u1", "empty-chat", [msg("user", "x")], undefined, { lastChannelName: "telegram", lastChatId: "" });
  t.mock.timers.tick(1000);
  await store.getOrCreate("u1", "default", "empty-channel");
  await store.appendMessages("u1", "empty-channel", [msg("user", "x")], undefined, { lastChannelName: "", lastChatId: "9" });
  t.mock.timers.tick(1000);
  const sessions = db.getCollection<Session>("sessions");
  for (const [id, metadata] of [
    ["null-chat", { lastChannelName: "telegram", lastChatId: null }],
    ["null-channel", { lastChannelName: null, lastChatId: "9" }],
  ] as const) {
    const s = await store.getOrCreate("u1", "default", id);
    await sessions.upsert({ ...s, metadata: metadata as never, updatedAt: new Date(Date.now()).toISOString() });
  }
  assert.deepEqual(await store.findLastChannel("u1"), { channelName: "telegram", chatId: "42" });
});

test("list is capped at 200 sessions", async () => {
  const { store, db } = await setupStoreWithDb();
  const sessions = db.getCollection<Session>("sessions");
  const base = await store.getOrCreate("u1", "default", "s0");
  for (let i = 1; i <= 205; i++) await sessions.create({ ...base, id: `u1:s${i}`, sessionId: `s${i}` });
  assert.equal((await store.list("u1", undefined, { limit: 1000 })).length, 200);
});

test("lease and compaction updates retry past a concurrent write instead of giving up", async () => {
  const { store, db } = await setupStoreWithDb();
  const s = await store.getOrCreate("u1", "default", "s1");
  const sessions = db.getCollection<Session>("sessions");
  /** One concurrent write (a metadata note) just before the next replace. */
  const raceNextReplace = () => {
    let done = false;
    const remove = sessions.beforeOperation(async ({ op }) => {
      if (op === "replace" && !done) {
        done = true;
        const current = sessions.peek<Session>(s.id, "u1")!;
        await sessions.upsert({ ...current, metadata: { ...current.metadata, note: "concurrent" } });
      }
    });
    return remove;
  };
  const now = Date.now();
  let remove = raceNextReplace();
  assert.equal(await store.acquireRunLease("u1", "s1", "lease-1", now + 60_000, now), true);
  remove();
  remove = raceNextReplace();
  assert.equal(await store.renewRunLease("u1", "s1", "lease-1", now + 120_000), true);
  remove();
  remove = raceNextReplace();
  assert.equal(await store.updateCompaction("u1", "s1", "summary", 0, s.instanceId, 0), true);
  remove();
  const after = await store.get("u1", "s1");
  assert.equal(after?.activeRun?.expiresAtMs, now + 120_000);
  assert.equal(after?.compactionSummary, "summary");
  assert.equal(after?.metadata?.note, "concurrent");
});
