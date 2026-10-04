import test from "node:test";
import assert from "node:assert/strict";

import { RateLimiter, rateLimitMessage, scopedRateLimitConfig, type RateLimitConfig } from "./index.js";
import { InMemoryStorage, type StorageAdapter } from "@agentforeach/storage";

/** Counters on the storage SDK's in-memory adapter (atomic incr, 404, 409). */
function counterDb() {
  return { db: new InMemoryStorage() };
}

const config = (over: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  enabled: true,
  perMinute: 3,
  perDay: 5,
  exemptChannels: ["cron"],
  containerId: "rate-limits",
  ...over,
});

test("the per-minute limit refuses the message after the limit, and resets next minute", async () => {
  const { db } = counterDb();
  const limiter = new RateLimiter(db, config());
  const t = Date.UTC(2026, 8, 29, 10, 0, 15);
  for (let i = 0; i < 3; i++) assert.equal((await limiter.check("u1", "push", t)).allowed, true);
  const refused = await limiter.check("u1", "push", t);
  assert.equal(refused.allowed, false);
  assert.equal(refused.allowed === false && refused.window, "minute");
  assert.equal(refused.allowed === false && refused.retryAfterSeconds, 45);
  assert.equal((await limiter.check("u2", "push", t)).allowed, true, "other users are unaffected");
  assert.equal((await limiter.check("u1", "push", t + 60_000)).allowed, true);
});

test("the daily limit applies across minutes", async () => {
  const { db } = counterDb();
  const limiter = new RateLimiter(db, config({ perMinute: 0 }));
  const t = Date.UTC(2026, 8, 29, 10, 0, 0);
  for (let i = 0; i < 5; i++) assert.equal((await limiter.check("u1", "push", t + i * 60_000)).allowed, true);
  const refused = await limiter.check("u1", "push", t + 10 * 60_000);
  assert.equal(refused.allowed === false && refused.window, "day");
  assert.match(rateLimitMessage(refused as never), /today's message limit/);
});

test("exempt channels and a disabled limiter never refuse; a store outage fails open", async () => {
  const { db } = counterDb();
  const limiter = new RateLimiter(db, config({ perMinute: 1 }));
  for (let i = 0; i < 5; i++) assert.equal((await limiter.check("u1", "cron")).allowed, true);
  const off = new RateLimiter(db, config({ enabled: false, perMinute: 1 }));
  for (let i = 0; i < 5; i++) assert.equal((await off.check("u1", "push")).allowed, true);

  const broken: StorageAdapter = {
    name: "broken",
    capabilities: { vectorSearch: false, hybridSearch: false },
    async initialize() {},
    async collection() {
      throw new Error("cosmos down");
    },
  };
  assert.equal((await new RateLimiter(broken, config()).check("u1", "push")).allowed, true);
});

test("scoped limiters count separately from chat messages", async () => {
  const { db } = counterDb();
  const chat = new RateLimiter(db, config({ perMinute: 1 }));
  const erase = new RateLimiter(db, config({ perMinute: 1, scope: "erase" }));
  const t = Date.UTC(2026, 8, 29, 10, 0, 0);
  assert.equal((await chat.check("u1", "push", t)).allowed, true);
  assert.equal((await erase.check("u1", "push", t)).allowed, true, "not refused by the chat count");
  assert.equal((await erase.check("u1", "push", t)).allowed, false);
});

test("scheduled runs and force-runs have their own limits, with no channel exemption", async () => {
  const scheduled = scopedRateLimitConfig("scheduled");
  const forceRun = scopedRateLimitConfig("forceRun");
  assert.deepEqual(scheduled.exemptChannels, [], "cron is exempt from the message limit, not from this one");
  assert.ok(scheduled.perMinute > 0 && scheduled.perDay > 0);
  assert.notEqual(scheduled.scope, forceRun.scope);

  const { db } = counterDb();
  const limiter = new RateLimiter(db, { ...forceRun, perMinute: 2 });
  const t = Date.UTC(2026, 8, 29, 10, 0, 0);
  assert.equal((await limiter.check("u1", "cron", t)).allowed, true);
  assert.equal((await limiter.check("u1", "cron", t)).allowed, true);
  assert.equal((await limiter.check("u1", "cron", t)).allowed, false, "a job loop is cut off");
});

test("browser actions have their own limit, apart from messages and scheduled runs", () => {
  const browser = scopedRateLimitConfig("browser");
  assert.equal(browser.scope, "browser");
  assert.deepEqual(browser.exemptChannels, []);
  assert.equal(browser.perMinute, 30);
  assert.equal(browser.perDay, 300);
  assert.notEqual(browser.scope, scopedRateLimitConfig("scheduled").scope);
});
