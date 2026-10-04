import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorage } from "@agentforeach/storage";

import { loadWebConfig } from "./config.js";
import { WebToolHandler } from "./tools.js";
import { RateLimiter, loadRateLimitConfig } from "../ratelimit/index.js";
import { WEB_SEARCH_TOOL_NAME } from "./tools.js";

test("web_search's per-user daily limit is counted in storage, so it holds across instances", async () => {
  const base = loadWebConfig();
  const config = { ...base, rateLimit: { maxPerSession: 0, cooldownMs: 0, maxPerUserDaily: 2 } };
  // Two handlers stand for two instances (or Worker isolates) sharing one counter store.
  const storage = new InMemoryStorage();
  const counter = () =>
    new RateLimiter(storage, { ...loadRateLimitConfig(), enabled: true, perMinute: 0, perDay: 2, exemptChannels: [], scope: "search" });
  const first = new WebToolHandler(config, { dailyLimiter: counter() });
  const second = new WebToolHandler(config, { dailyLimiter: counter() });
  const search = (h: WebToolHandler, userId: string) => h.handle(WEB_SEARCH_TOOL_NAME, {}, userId);

  assert.doesNotMatch(await search(first, "alice"), /Rate limit/);
  assert.doesNotMatch(await search(second, "alice"), /Rate limit/);
  assert.equal(await search(first, "alice"), "Rate limit: maximum 2 searches per day reached.");
  assert.equal(await search(second, "alice"), "Rate limit: maximum 2 searches per day reached.");
  assert.doesNotMatch(await search(second, "bob"), /Rate limit/, "another user's count is their own");
});

test("web_search with no daily limit doesn't count", async () => {
  const config = { ...loadWebConfig(), rateLimit: { maxPerSession: 0, cooldownMs: 0, maxPerUserDaily: 0 } };
  const handler = new WebToolHandler(config);
  for (let i = 0; i < 5; i++) assert.doesNotMatch(await handler.handle(WEB_SEARCH_TOOL_NAME, {}, "alice"), /Rate limit/);
});
