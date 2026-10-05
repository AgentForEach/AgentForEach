/**
 * Chat-run status records: idempotent accept, the conflict on a reused key,
 * the status transitions, and reconciling a stale record with its durable
 * job. On the storage SDK's in-memory adapter.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorage } from "@agentforeach/storage";
import {
  CHAT_RUN_COLLECTION,
  ChatRunConflictError,
  ChatRunStore,
  RECONCILE_GRACE_MS,
  chatRunFingerprint,
  chatRunView,
  reconcileChatRun,
  type ChatRunRecord,
} from "./chat-runs.js";

async function store(ttlSeconds = 604_800): Promise<{ runs: ChatRunStore; storage: InMemoryStorage }> {
  const storage = new InMemoryStorage();
  const runs = new ChatRunStore(storage, ttlSeconds);
  await runs.initialize();
  return { runs, storage };
}

const request = { message: "book a table for two", sessionId: "s-1" };

test("chat runs: the same key and request is a duplicate; the same key for another request is a conflict", async () => {
  const { runs } = await store();
  const fingerprint = chatRunFingerprint(request);
  const run = { runId: "r-1", userId: "u1", fingerprint, sessionId: "s-1", instanceId: "chat-1" };

  assert.deepEqual(await runs.prepare(run), { duplicate: false });
  assert.deepEqual(await runs.prepare(run), { duplicate: true });
  await assert.rejects(
    runs.prepare({ ...run, fingerprint: chatRunFingerprint({ ...request, message: "cancel it" }) }),
    ChatRunConflictError,
  );
  // A duplicate keeps the record as it was.
  await runs.begin("u1", "r-1");
  assert.deepEqual(await runs.prepare(run), { duplicate: true });
  assert.equal((await runs.get("u1", "r-1"))?.status, "running");
});

test("chat runs: the fingerprint covers the message, the session and the attachments' metadata", () => {
  const base = chatRunFingerprint(request);
  assert.equal(chatRunFingerprint({ ...request }), base);
  assert.notEqual(chatRunFingerprint({ ...request, message: "book a table for three" }), base);
  assert.notEqual(chatRunFingerprint({ ...request, sessionId: "s-2" }), base);
  const photo = { mimeType: "image/png", base64: "aGVsbG8=", fileName: "a.png" };
  const withPhoto = chatRunFingerprint({ ...request, attachments: [photo] });
  assert.notEqual(withPhoto, base);
  assert.notEqual(chatRunFingerprint({ ...request, attachments: [{ ...photo, fileName: "b.png" }] }), withPhoto);
  assert.notEqual(chatRunFingerprint({ ...request, attachments: [{ ...photo, base64: "aGVsbG8hIQ==" }] }), withPhoto);
});

test("chat runs: accepted, running, then how it ended; a retry of a finished run starts over", async () => {
  const { runs, storage } = await store(3600);
  const acceptedAtMs = Date.parse("2026-10-05T10:00:00.000Z");
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: chatRunFingerprint(request), acceptedAtMs, instanceId: "chat-1" });

  let run = await runs.get("u1", "r-1");
  assert.equal(run?.status, "accepted");
  assert.equal(run?.createdAt, "2026-10-05T10:00:00.000Z");
  assert.equal(run?.instanceId, "chat-1");

  await runs.begin("u1", "r-1");
  run = await runs.get("u1", "r-1");
  assert.equal(run?.status, "running");
  assert.ok(run?.startedAt);

  await runs.finish("u1", "r-1", { status: "failed", error: "rate_limited", retryable: true, sessionId: "s-new" });
  run = await runs.get("u1", "r-1");
  assert.deepEqual([run?.status, run?.error, run?.retryable, run?.sessionId], ["failed", "rate_limited", true, "s-new"]);
  assert.ok(run?.finishedAt);

  // The client resent it with the same key: it runs again.
  await runs.begin("u1", "r-1");
  run = await runs.get("u1", "r-1");
  assert.deepEqual([run?.status, run?.error, run?.retryable, run?.finishedAt], ["running", undefined, undefined, undefined]);
  await runs.finish("u1", "r-1", { status: "completed", sessionId: "s-other" });
  run = await runs.get("u1", "r-1");
  assert.equal(run?.status, "completed");
  assert.equal(run?.sessionId, "s-new", "the session it was recorded with stays");

  // Never the message text; a TTL on every write.
  const raw = (await (await storage.collection(CHAT_RUN_COLLECTION)).read("r-1", "u1"))!;
  assert.equal(JSON.stringify(raw).includes(request.message), false);
  assert.equal(raw.ttl, 3600);
});

test("chat runs: interrupted and aborted are recorded; a write for a run that has no record is no error", async () => {
  const { runs } = await store();
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f" });
  await runs.begin("u1", "r-1");
  await runs.finish("u1", "r-1", { status: "interrupted", error: "interrupted", retryable: true });
  assert.equal((await runs.get("u1", "r-1"))?.status, "interrupted");

  await runs.begin("u1", "nothing");
  await runs.finish("u1", "nothing", { status: "aborted" });
  assert.equal(await runs.get("u1", "nothing"), null);
});

test("chat runs: a user reads only their own runs", async () => {
  const { runs } = await store();
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f" });
  assert.ok(await runs.get("u1", "r-1"));
  assert.equal(await runs.get("u2", "r-1"), null);
  // The same key used by another user is another run, not a conflict.
  assert.deepEqual(await runs.prepare({ runId: "r-1", userId: "u2", fingerprint: "g" }), { duplicate: false });
});

test("chat runs: 0 keeps records forever", async () => {
  const { runs, storage } = await store(0);
  await runs.prepare({ runId: "r-1", userId: "u1", fingerprint: "f" });
  assert.equal((await (await storage.collection(CHAT_RUN_COLLECTION)).read("r-1", "u1"))?.ttl, -1);
});

test("reconcile: a run left accepted or running is reported from its durable job, after a grace period", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  const running: ChatRunRecord = {
    id: "r-1",
    userId: "u1",
    status: "running",
    fingerprint: "f",
    instanceId: "chat-1",
    createdAt: at(10 * 60_000),
    startedAt: at(5 * 60_000),
  };
  const opts = (durableStatus: Parameters<typeof reconcileChatRun>[1]["durableStatus"]) => ({
    durableStatus,
    inRequestLimitMs: 215_000,
    nowMs: now,
  });

  assert.equal(reconcileChatRun(running, opts("running")).status, "running");
  assert.equal(reconcileChatRun(running, opts("pending")).status, "running");
  assert.equal(reconcileChatRun(running, opts(undefined)).status, "running", "unknown: the record stands");
  assert.deepEqual(
    [reconcileChatRun(running, opts("failed")).status, reconcileChatRun(running, opts("failed")).error],
    ["failed", "execution_failed"],
  );
  assert.equal(reconcileChatRun(running, opts("terminated")).status, "aborted");
  assert.equal(reconcileChatRun(running, opts("completed")).status, "interrupted");
  assert.equal(reconcileChatRun(running, opts(null)).status, "interrupted", "the job is gone");
  assert.equal(reconcileChatRun(running, opts(null)).retryable, true);

  // Within the grace period nothing changes: the job may not be visible yet.
  const fresh = { ...running, status: "accepted" as const, createdAt: at(RECONCILE_GRACE_MS / 2), startedAt: undefined };
  assert.equal(reconcileChatRun(fresh, opts(null)).status, "accepted");
  // A finished run is never second-guessed.
  const done = { ...running, status: "completed" as const };
  assert.equal(reconcileChatRun(done, opts("failed")).status, "completed");

  // A turn run in an HTTP request can't outlive its deadline.
  const inRequest = { ...running, instanceId: undefined };
  assert.equal(reconcileChatRun(inRequest, opts(undefined)).status, "interrupted");
  assert.equal(reconcileChatRun({ ...inRequest, startedAt: at(120_000) }, opts(undefined)).status, "running");
});

test("the view: what the status route returns", () => {
  const view = chatRunView({
    id: "r-1",
    userId: "u1",
    status: "failed",
    fingerprint: "f",
    instanceId: "chat-1",
    sessionId: "s-1",
    createdAt: "2026-10-05T10:00:00.000Z",
    error: "queued_too_long",
    retryable: true,
  });
  assert.deepEqual(view, {
    runId: "r-1",
    status: "failed",
    sessionId: "s-1",
    createdAt: "2026-10-05T10:00:00.000Z",
    error: "queued_too_long",
    retryable: true,
  });
});
