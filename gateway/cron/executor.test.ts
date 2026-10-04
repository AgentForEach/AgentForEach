import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage } from "@agentforeach/storage";
import { IdentityStore } from "../identity/index.js";
import type { IdentityConfig } from "../identity/config.js";
import { resetIdentityStore, setIdentityStore } from "../channels/router.js";
import { registerDeliveryAdapter, type DeliveryAdapter, type DeliveryPayload } from "./delivery.js";
import { CREDITS_UNAVAILABLE_RETRY_MS, executeJob, executionFailure, reachedUser } from "./executor.js";
import { CronStore } from "./store.js";
import { getSchedulerShardForUser } from "./config.js";
import type { CronDelivery, CronJob } from "./types.js";

// Delivery resolves channel owners through channels/index.js, whose import
// registers the real push adapter. Load it now so the fakes below win.
await import("../channels/index.js");

// ============================================================================
// Fakes: channel adapters that record instead of sending, and an identity
// store (the real one, on the in-memory database) where alice owns Telegram
// account 111. No LLM or network is reachable from these tests: the jobs
// either stop at the pre-flight check or are "noop" heartbeats, which the
// executor answers without a model call.
// ============================================================================

function recordingAdapter(channelId: string) {
  const sent: DeliveryPayload[] = [];
  const adapter: DeliveryAdapter = {
    channelId,
    displayName: channelId,
    async deliver(payload) {
      sent.push(payload);
      return { success: true };
    },
  };
  registerDeliveryAdapter(adapter);
  return sent;
}

const telegramSent = recordingAdapter("telegram");
const pushSent = recordingAdapter("push");

const identityConfig: IdentityConfig = {
  enabled: true,
  containerId: "identity-links",
  pairingContainerId: "identity-pairing",
  channelIndexContainerId: "identity-channel-index",
  legacyLinkLookup: false,
  pairingCodeTtlSeconds: 300,
  pairingCodeLength: 6,
  pairingMaxFailedAttempts: 10,
  pairingAttemptWindowSeconds: 900,
  maxActivePairingCodes: 5,
  fallbackMode: "config-default",
};

const identity = new IdentityStore(new InMemoryStorage(), identityConfig);
await identity.initialize();
await identity.upsertLink({
  id: IdentityStore.buildLinkId("telegram", "111"),
  userId: "alice",
  channel: "telegram",
  channelUserId: "111",
  linkedVia: "admin",
  linkedAt: new Date().toISOString(),
});
setIdentityStore(identity);
test.after(() => resetIdentityStore());

test.beforeEach(() => {
  telegramSent.length = 0;
  pushSent.length = 0;
});

async function createJob(store: CronStore, delivery: CronDelivery, message = "noop"): Promise<CronJob> {
  return store.createJob({
    userId: "alice",
    name: "daily digest",
    enabled: true,
    schedule: { kind: "every", everyMs: 60 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message },
    delivery,
  });
}

const config = { defaultTimeoutMs: 5_000 };

// ============================================================================
// Tests
// ============================================================================

test("a job delivering to someone else's chat is refused before it runs, and its owner is told", async () => {
  const store = new CronStore(new InMemoryStorage());
  const job = await createJob(store, { mode: "channel", channelId: "telegram", recipientId: "999" });

  const result = await executeJob(job, config);

  assert.equal(result.status, "error");
  assert.equal(result.disableJob, true);
  assert.match(result.error ?? "", /Delivery refused: the telegram recipient isn't linked to this user/);
  // Phase 1 never ran: a noop job that runs answers "HEARTBEAT_OK".
  assert.equal(result.summary, undefined);
  assert.equal(telegramSent.length, 0);

  // The owner gets an in-app notice, addressed to them.
  assert.equal(pushSent.length, 1);
  assert.equal(pushSent[0].target.recipientId, "alice");
  assert.match(pushSent[0].text, /"daily digest" was turned off: Delivery refused/);
});

test("the refused result disables the job through the store", async () => {
  const store = new CronStore(new InMemoryStorage());
  const job = await createJob(store, { mode: "channel", channelId: "telegram", recipientId: "999" });
  const now = job.state.nextRunAtMs!;
  const [claimed] = await store.getDueJobs(now, getSchedulerShardForUser("alice"));
  assert.equal(claimed?.id, job.id);

  const result = await executeJob(claimed, config);
  const { action } = await store.applyResult(claimed, result, { runningToken: claimed.state.runningToken });

  assert.equal(action, "disabled");
  const stored = (await store.getJob(job.id, "alice"))!;
  assert.equal(stored.enabled, false);
  assert.match(stored.state.lastError ?? "", /Delivery refused/);
  assert.deepEqual(await store.getDueJobs(now + 60 * 60_000, getSchedulerShardForUser("alice")), []);
});

test("a job delivering to its owner's linked account passes the pre-flight check", async () => {
  const store = new CronStore(new InMemoryStorage());
  const job = await createJob(store, { mode: "channel", channelId: "telegram", recipientId: "111" });

  const result = await executeJob(job, config);

  assert.equal(result.status, "ok");
  assert.equal(result.disableJob, undefined);
  assert.equal(result.summary, "HEARTBEAT_OK");
  // Ack-only output isn't delivered, and nobody is told the job was disabled.
  assert.equal(result.delivered, false);
  assert.equal(telegramSent.length, 0);
  assert.equal(pushSent.length, 0);
});

test("the chat a job was created from passes the pre-flight check through its binding", async () => {
  const store = new CronStore(new InMemoryStorage());
  const job = await createJob(store, {
    mode: "channel",
    channelId: "telegram",
    recipientId: "-100123",
    channelBinding: { channelId: "telegram", chatId: "-100123" },
  });

  const result = await executeJob(job, config);
  assert.equal(result.status, "ok");
  assert.equal(result.disableJob, undefined);
});

test("a delivery that can't be resolved (no adapter) isn't treated as a refusal", async () => {
  const store = new CronStore(new InMemoryStorage());
  const job = await createJob(store, { mode: "channel", channelId: "carrier-pigeon", recipientId: "1" });

  const result = await executeJob(job, config);
  // Not permanent: the job runs (noop) and is not disabled.
  assert.equal(result.status, "ok");
  assert.equal(result.disableJob, undefined);
  assert.equal(pushSent.length, 0);
});

test("a reminder turn that asked the user something, or that they stopped, isn't sent again", () => {
  assert.equal(reachedUser("completed"), true);
  assert.equal(reachedUser("awaiting_input"), true);
  assert.equal(reachedUser("aborted"), true);
  assert.equal(reachedUser("failed"), false);
});

test("a credits-service outage defers a scheduled run instead of failing it", () => {
  const outage = executionFailure(Object.assign(new Error("reserve URL is unavailable"), { code: "CREDITS_UNAVAILABLE" }), Date.now());
  assert.equal(outage.retryAfterMs, CREDITS_UNAVAILABLE_RETRY_MS);
  const broke = executionFailure(Object.assign(new Error("Out of credits"), { code: "INSUFFICIENT_CREDITS" }), Date.now());
  assert.equal(broke.status, "error");
  assert.equal(broke.retryAfterMs, undefined);
});
