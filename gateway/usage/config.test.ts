/**
 * AgentForEach Usage Module — Config Tests
 *
 * Tests for usage/config.ts default behavior.
 * Since agentforeach.json has no "usage" section, all values should resolve to defaults.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  loadUsageConfig,
  resetUsageConfigCache,
  isUsageEnabled,
  resolveUsageContainerId,
  DEFAULT_USAGE_CONTAINER_ID,
  DEFAULT_USAGE_TTL_SECONDS,
  DEFAULT_USAGE_ENABLED,
} from "./config.js";
import { DEFAULT_MODEL_PRICING, DEFAULT_FALLBACK_PRICING } from "./pricing.js";
import { resetConfigCache } from "../utils/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset both the utils config cache and the usage config cache for isolation. */
function resetAll(): void {
  resetConfigCache();
  resetUsageConfigCache();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("loadUsageConfig — returns defaults when no config section", async () => {
  resetAll();

  const cfg = loadUsageConfig();

  assert.equal(cfg.enabled, DEFAULT_USAGE_ENABLED);
  assert.equal(cfg.enabled, true);

  assert.equal(cfg.containerId, DEFAULT_USAGE_CONTAINER_ID);
  assert.equal(cfg.containerId, "usage-records");

  assert.equal(cfg.ttlSeconds, DEFAULT_USAGE_TTL_SECONDS);
  assert.equal(cfg.ttlSeconds, 7_776_000);

  // pricing should include every key from DEFAULT_MODEL_PRICING
  for (const model of Object.keys(DEFAULT_MODEL_PRICING)) {
    assert.ok(
      model in cfg.pricing,
      `Expected pricing to include model "${model}"`,
    );
    assert.deepStrictEqual(cfg.pricing[model], DEFAULT_MODEL_PRICING[model]);
  }

  // fallbackPricing should match DEFAULT_FALLBACK_PRICING
  assert.deepStrictEqual(cfg.fallbackPricing, DEFAULT_FALLBACK_PRICING);
});

test("loadUsageConfig — caches after first load", async () => {
  resetAll();

  const first = loadUsageConfig();
  const second = loadUsageConfig();

  assert.equal(first, second, "Expected the same cached object reference");
});

test("isUsageEnabled — returns true by default", async () => {
  resetAll();

  assert.equal(isUsageEnabled(), true);
});

test("resolveUsageContainerId — returns default container ID", async () => {
  resetAll();

  assert.equal(resolveUsageContainerId(), "usage-records");
});
