/**
 * Store behaviours the Phase 3 test review found untested: each test pins a
 * rule whose removal (a planted bug) no other test noticed. All run on the
 * storage SDK's in-memory adapter.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage } from "@agentforeach/storage";
import { AbortStore } from "../client/abort-store.js";
import { createCosmosTtlStore } from "../channels/whatsapp/kv-store.js";
import { DigestStore } from "../digests/store.js";
import { EpisodeStore, episodesCollection } from "../episodes/store.js";
import { resolveEmbeddingModel, vectorDimsForModel } from "../memory/config.js";
import { resetAllConfig } from "../utils/reset-all-config.js";
import type { EpisodeDocument } from "../episodes/types.js";
import { HitlStore } from "../hitl/store.js";
import type { HitlRunState } from "../hitl/types.js";
import { IdentityStore } from "../identity/store.js";
import type { IdentityConfig } from "../identity/config.js";
import { PromptDocumentStore } from "../prompt/store.js";
import { RateLimiter } from "../ratelimit/index.js";
import { UserSkillStore } from "../skills/store.js";
import type { SkillAuditEntry, UserSkillConfig } from "../skills/types.js";
import { UsageStore } from "../usage/store.js";

// -- WhatsApp TTL store: create is the dedupe arbiter --------------------------

test("whatsapp TTL store: of two adds of one key, exactly one wins (also concurrently)", async () => {
  const storage = new InMemoryStorage();
  const store = (await createCosmosTtlStore("whatsapp-dedupe", undefined, storage))!;
  assert.equal(await store.add("msg-1", "seen", 60), true);
  assert.equal(await store.add("msg-1", "seen", 60), false);
  const results = await Promise.all([store.add("msg-2", "x", 60), store.add("msg-2", "x", 60), store.add("msg-2", "x", 60)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await store.get("msg-2"), "x");
});

// -- Abort markers --------------------------------------------------------------

test("abort store: a marker older than the run is ignored and cleared; a newer one is consumed once", async () => {
  const store = new AbortStore(new InMemoryStorage());
  await store.initialize();
  await store.requestAbort("u1");
  assert.equal(await store.consumePendingAbort("u1", new Date(Date.now() + 60_000)), false, "older than the run");
  assert.equal(await store.consumePendingAbort("u1", new Date(0)), false, "and it was cleared");

  await store.requestAbort("u1");
  const since = new Date(Date.now() - 60_000);
  assert.equal(await store.consumePendingAbort("u1", since), true);
  assert.equal(await store.consumePendingAbort("u1", since), false, "exactly once");
});

// -- Skills: audit entries share the partition but aren't configs ---------------

test("skills store: getAllForUser returns configs only, ordered by skill id", async () => {
  const store = new UserSkillStore(new InMemoryStorage());
  await store.initialize();
  const config = (skillId: string) =>
    ({ id: UserSkillStore.buildId("u1", skillId), userId: "u1", skillId, enabled: true, credentials: {}, updatedAt: "" }) as unknown as UserSkillConfig;
  await store.upsert(config("weather"));
  await store.upsert(config("calendar"));
  await store.logAudit({ id: "audit:u1:weather:1", userId: "u1", skillId: "weather", action: "enable", timestamp: "" } as unknown as SkillAuditEntry);
  await store.upsert({ ...config("other"), userId: "u2", id: UserSkillStore.buildId("u2", "other") });
  assert.deepEqual((await store.getAllForUser("u1")).map((c) => c.skillId), ["calendar", "weather"]);
});

// -- Rate limits: a fresh window under concurrency ------------------------------

test("rate limiter: concurrent first messages in a new window are all counted", async () => {
  const limiter = new RateLimiter(new InMemoryStorage(), {
    enabled: true,
    perMinute: 5,
    perDay: 100,
    exemptChannels: [],
    containerId: "rate-limits",
  });
  const t = Date.UTC(2026, 9, 1, 12, 0, 10);
  const first = await Promise.all(Array.from({ length: 5 }, () => limiter.check("u1", "push", t)));
  assert.ok(first.every((d) => d.allowed));
  assert.equal((await limiter.check("u1", "push", t)).allowed, false, "the sixth is refused");
});

// -- Prompt patches ---------------------------------------------------------------

test("prompt patchData bumps the version once per patch and ignores nulls for absent keys", async () => {
  const store = new PromptDocumentStore(new InMemoryStorage());
  await store.initialize();
  const created = await store.patchData("u1", "default", "USER", { name: "Asha" } as never);
  const patched = await store.patchData("u1", "default", "USER", { timezone: "Asia/Kolkata", nickname: null } as never);
  assert.equal(patched.version, created.version + 1);
  assert.equal((patched.data as Record<string, unknown>).timezone, "Asia/Kolkata");
  assert.equal("nickname" in (patched.data as Record<string, unknown>), false);
  const removed = await store.patchData("u1", "default", "USER", { timezone: null } as never);
  assert.equal("timezone" in (removed.data as Record<string, unknown>), false);
  assert.equal(removed.version, created.version + 2);
});

// -- Identity: only live pairing codes count ---------------------------------------

test("identity: expired pairing codes don't count toward the active-code limit", async () => {
  const config: IdentityConfig = {
    enabled: true,
    containerId: "identity-links",
    pairingContainerId: "identity-pairing",
    channelIndexContainerId: "identity-channel-index",
    legacyLinkLookup: false,
    pairingCodeTtlSeconds: -1, // every code is created already expired
    pairingCodeLength: 6,
    pairingMaxFailedAttempts: 10,
    pairingAttemptWindowSeconds: 900,
    maxActivePairingCodes: 2,
    fallbackMode: "config-default",
  };
  const store = new IdentityStore(new InMemoryStorage(), config);
  await store.initialize();
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push(await store.createPairingCode("u1"));
  assert.equal(new Set(codes.map((c) => c.code)).size, 4, "four codes past a limit of two: expired ones don't count");
});

test("identity: a user's links are read from their own partition", async () => {
  const storage = new InMemoryStorage();
  const store = new IdentityStore(storage, {
    enabled: true, containerId: "identity-links", pairingContainerId: "identity-pairing",
    channelIndexContainerId: "identity-channel-index", legacyLinkLookup: false, pairingCodeTtlSeconds: 300,
    pairingCodeLength: 6, pairingMaxFailedAttempts: 10, pairingAttemptWindowSeconds: 900, maxActivePairingCodes: 5,
    fallbackMode: "config-default",
  });
  await store.initialize();
  await store.upsertLink({ id: "telegram:1", userId: "u1", channel: "telegram", channelUserId: "1", linkedVia: "admin", linkedAt: "" });
  const scopes: Array<string | undefined> = [];
  storage.getCollection("identity-links").beforeOperation(({ op, partitionKey }) => {
    if (op === "find") scopes.push(partitionKey);
  });
  assert.equal((await store.getLinksForUser("u1")).length, 1);
  assert.deepEqual(scopes, ["u1"]);
});

// -- Episodes ------------------------------------------------------------------------

function episode(id: string, updatedAt: string, cos: number): EpisodeDocument {
  const vector = new Array<number>(1536).fill(0);
  vector[0] = cos;
  vector[1] = Math.sqrt(1 - cos * cos);
  return {
    id, userId: "u1", theme: id, summary: "", vector, topics: [], highlights: [], status: "active",
    salience: 0.5, decisions: [], pending: [], createdAt: updatedAt, updatedAt,
  } as EpisodeDocument;
}

test("episodes: recent lists newest first; the vector size follows the embedding model", async () => {
  const store = new EpisodeStore(new InMemoryStorage());
  await store.initialize();
  await store.upsert(episode("older", new Date(Date.now() - 60_000).toISOString(), 0.5));
  await store.upsert(episode("newer", new Date().toISOString(), 0.5));
  assert.deepEqual((await store.getRecent("u1", 5, 14)).map((e) => e.id), ["newer", "older"]);
  assert.equal(episodesCollection().vector?.dimensions, vectorDimsForModel(resolveEmbeddingModel()));
  // With the large embedding model, episodes are sized like memories: 3072.
  const saved = process.env.EMBEDDING_MODEL;
  process.env.EMBEDDING_MODEL = "text-embedding-3-large";
  resetAllConfig();
  try {
    assert.equal(episodesCollection().vector?.dimensions, 3072);
  } finally {
    if (saved === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = saved;
    resetAllConfig();
  }
});

test("episodes: search and recent leave out episodes older than the window", async () => {
  const store = new EpisodeStore(new InMemoryStorage());
  await store.initialize();
  const now = new Date().toISOString();
  await store.upsert(episode("fresh", now, 0.5));
  await store.upsert(episode("stale", "2020-01-01T00:00:00.000Z", 0.99));
  const unit = episode("q", now, 1).vector;
  assert.deepEqual((await store.semanticSearch(unit, "u1", 5, 14)).map((r) => r.episode.id), ["fresh"]);
  assert.deepEqual((await store.getRecent("u1", 5, 14)).map((e) => e.id), ["fresh"]);
});

test("episodes: conditionalUpdate retries past a concurrent write and keeps it", async () => {
  const storage = new InMemoryStorage();
  const store = new EpisodeStore(storage);
  await store.initialize();
  await store.upsert(episode("ep", new Date().toISOString(), 0.5));
  const episodes = storage.getCollection<EpisodeDocument>("episodes");
  let raced = false;
  episodes.beforeOperation(async ({ op }) => {
    if (op === "replace" && !raced) {
      raced = true;
      const current = episodes.peek<EpisodeDocument>("ep", "u1")!;
      await episodes.upsert({ ...current, decisions: ["from the other session"] });
    }
  });
  const updated = await store.conditionalUpdate("u1", "ep", (e) => ({ ...e, pending: ["mine"] }));
  assert.deepEqual(updated?.decisions, ["from the other session"]);
  assert.deepEqual(updated?.pending, ["mine"]);
  assert.equal(await store.conditionalUpdate("u1", "missing", (e) => e), null);
});

// -- HITL ---------------------------------------------------------------------------

function hitlState(requestId: string, createdAt: number): HitlRunState {
  return {
    requestId, orchestrationId: `hitl-${requestId}`, originalRequest: { userId: "u1", message: "m" }, runId: requestId,
    sessionId: "s1", toolRound: 1, pendingToolCall: { callId: "c1", name: "t", arguments: {} },
    completedToolResults: [], independentToolCalls: [], createdAt, status: "pending",
  } as unknown as HitlRunState;
}

test("hitl: listPending returns only pending requests, newest first", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 1) });
  const store = new HitlStore(new InMemoryStorage());
  await store.initialize();
  for (const id of ["a", "b", "c"]) {
    t.mock.timers.tick(1000);
    await store.create(hitlState(id, Date.now()));
  }
  await store.updateStatus("b", "u1", "responded");
  assert.deepEqual((await store.listPending("u1")).map((s) => s.requestId), ["c", "a"]);
});

test("hitl: a fractional timeout is stored as a whole-second ttl", async () => {
  const storage = new InMemoryStorage();
  const store = new HitlStore(storage);
  await store.initialize();
  await store.create({ ...hitlState("frac", Date.now()), timeoutSeconds: 4321.4 } as HitlRunState);
  assert.equal(storage.getCollection("hitl-requests").peek<{ ttl: number }>("frac", "u1")?.ttl, 4922);
});

test("hitl: sibling results saved after the answer are not written", async () => {
  const store = new HitlStore(new InMemoryStorage());
  await store.initialize();
  await store.create(hitlState("r", Date.now()));
  await store.updateStatus("r", "u1", "responded");
  await store.setCompletedToolResults("r", "u1", [{ callId: "c2", name: "x", output: "late" }] as never);
  assert.deepEqual((await store.get("r", "u1"))?.completedToolResults, []);
});

// -- Partition scoping of the per-user reads -------------------------------------------

test("digest and usage reads are scoped to the user's partition", async () => {
  const storage = new InMemoryStorage();
  const digests = new DigestStore(storage);
  const usage = new UsageStore(storage, {
    enabled: true, containerId: "usage-records", ttlSeconds: 86400, pricing: {}, fallbackPricing: { inputPer1M: 1, outputPer1M: 1 },
  });
  await Promise.all([digests.initialize(), usage.initialize()]);
  const scopes: Array<string | undefined> = [];
  for (const name of ["session-digests", "usage-records"]) {
    storage.getCollection(name).beforeOperation(({ op, partitionKey }) => {
      if (op === "find") scopes.push(partitionKey);
    });
  }
  await digests.getRecent("u1");
  await digests.searchByKeyword("u1", "tea");
  await usage.getRecords("u1");
  await usage.getSummary("u1");
  assert.deepEqual(scopes, ["u1", "u1", "u1", "u1"]);
});
