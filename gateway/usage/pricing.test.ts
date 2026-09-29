import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateCost,
  getModelPricing,
  DEFAULT_MODEL_PRICING,
  DEFAULT_FALLBACK_PRICING,
} from "./pricing.js";
import type { UsageStats } from "../llms/index.js";
import type { ModelPricing } from "./types.js";
import type { UsageConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal UsageConfig for getModelPricing tests.
 */
const testConfig: UsageConfig = {
  enabled: true,
  containerId: "usage-records",
  ttlSeconds: 7_776_000,
  pricing: { ...DEFAULT_MODEL_PRICING },
  fallbackPricing: DEFAULT_FALLBACK_PRICING,
};

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

test("estimateCost", async (t) => {
  await t.test("basic input + output tokens (no caching/reasoning)", async () => {
    const usage: UsageStats = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    };
    const pricing: ModelPricing = {
      inputPer1M: 2.00,
      outputPer1M: 8.00,
    };

    // cost = (1M * 2.00) / 1M + (1M * 8.00) / 1M = 2.00 + 8.00 = 10.00
    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 10.0);
  });

  await t.test("with cached input tokens (uses cachedInputPer1M)", async () => {
    const usage: UsageStats = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      totalTokens: 1_500_000,
      cachedInputTokens: 400_000,
    };
    const pricing: ModelPricing = {
      inputPer1M: 3.00,
      outputPer1M: 15.00,
      cachedInputPer1M: 0.30,
    };

    // nonCachedInput = 1_000_000 - 400_000 = 600_000
    // cost = (600_000 * 3.00) / 1M + (400_000 * 0.30) / 1M + (500_000 * 15.00) / 1M
    //      = 1.80 + 0.12 + 7.50 = 9.42
    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 9.42);
  });

  await t.test("with reasoning tokens (uses reasoningPer1M)", async () => {
    const usage: UsageStats = {
      inputTokens: 500_000,
      outputTokens: 1_000_000,
      totalTokens: 1_500_000,
      reasoningTokens: 600_000,
    };
    const pricing: ModelPricing = {
      inputPer1M: 1.10,
      outputPer1M: 4.40,
      reasoningPer1M: 4.40,
    };

    // nonReasoningOutput = 1_000_000 - 600_000 = 400_000
    // cachedRate defaults to 1.10 * 0.5 = 0.55 (but no cached tokens, so irrelevant)
    // cost = (500_000 * 1.10) / 1M + (0 * 0.55) / 1M + (400_000 * 4.40) / 1M + (600_000 * 4.40) / 1M
    //      = 0.55 + 0 + 1.76 + 2.64 = 4.95
    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 4.95);
  });

  await t.test("with both cached + reasoning tokens", async () => {
    const usage: UsageStats = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      cachedInputTokens: 200_000,
      reasoningTokens: 300_000,
    };
    const pricing: ModelPricing = {
      inputPer1M: 1.10,
      outputPer1M: 4.40,
      cachedInputPer1M: 0.55,
      reasoningPer1M: 4.40,
    };

    // nonCachedInput = 1_000_000 - 200_000 = 800_000
    // nonReasoningOutput = 1_000_000 - 300_000 = 700_000
    // cost = (800_000 * 1.10) / 1M + (200_000 * 0.55) / 1M + (700_000 * 4.40) / 1M + (300_000 * 4.40) / 1M
    //      = 0.88 + 0.11 + 3.08 + 1.32 = 5.39
    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 5.39);
  });

  await t.test("defaults cachedInputPer1M to inputPer1M * 0.5 when not specified", async () => {
    const usage: UsageStats = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    };
    const pricing: ModelPricing = {
      inputPer1M: 4.00,
      outputPer1M: 10.00,
      // cachedInputPer1M intentionally omitted — should default to 4.00 * 0.5 = 2.00
    };

    // nonCachedInput = 1_000_000 - 1_000_000 = 0
    // cachedRate = 4.00 * 0.5 = 2.00
    // cost = (0 * 4.00) / 1M + (1_000_000 * 2.00) / 1M + (0 * 10.00) / 1M = 0 + 2.00 + 0 = 2.00
    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 2.0);
  });

  await t.test("defaults reasoningPer1M to outputPer1M when not specified", async () => {
    const usage: UsageStats = {
      inputTokens: 0,
      outputTokens: 1_000_000,
      totalTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    };
    const pricing: ModelPricing = {
      inputPer1M: 2.00,
      outputPer1M: 8.00,
      // reasoningPer1M intentionally omitted — should default to outputPer1M = 8.00
    };

    // nonReasoningOutput = 1_000_000 - 1_000_000 = 0
    // reasoningRate = 8.00 (defaults to outputPer1M)
    // cost = (0 * 2.00) / 1M + (0 * 8.00) / 1M + (1_000_000 * 8.00) / 1M = 0 + 0 + 8.00 = 8.00
    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 8.0);
  });

  await t.test("returns 0 for zero tokens", async () => {
    const usage: UsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const pricing: ModelPricing = {
      inputPer1M: 3.00,
      outputPer1M: 15.00,
    };

    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 0);
  });

  await t.test("guards against cachedInputTokens > inputTokens (no negative cost)", async () => {
    const usage: UsageStats = {
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      cachedInputTokens: 500, // more cached than total input — should not produce negative
    };
    const pricing: ModelPricing = {
      inputPer1M: 3.00,
      outputPer1M: 15.00,
      cachedInputPer1M: 0.30,
    };

    const cost = estimateCost(usage, pricing);
    assert.ok(cost >= 0, "cost should never be negative");
    // nonCachedInput = max(0, 100 - 500) = 0
    // cost = (0 * 3.00) / 1M + (500 * 0.30) / 1M + (200 * 15.00) / 1M
    //      = 0 + 0.00015 + 0.003 = 0.00315
    const expected = (500 * 0.30 + 200 * 15.00) / 1_000_000;
    assert.equal(cost, Math.round(expected * 1_000_000) / 1_000_000);
  });

  await t.test("guards against reasoningTokens > outputTokens (no negative cost)", async () => {
    const usage: UsageStats = {
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      reasoningTokens: 500, // more reasoning than total output — should not produce negative
    };
    const pricing: ModelPricing = {
      inputPer1M: 1.10,
      outputPer1M: 4.40,
      reasoningPer1M: 4.40,
    };

    const cost = estimateCost(usage, pricing);
    assert.ok(cost >= 0, "cost should never be negative");
    // nonReasoningOutput = max(0, 200 - 500) = 0
    // cost = (100 * 1.10) / 1M + (0 * 4.40) / 1M + (500 * 4.40) / 1M
    //      = 0.00011 + 0 + 0.0022 = 0.00231
    const expected = (100 * 1.10 + 500 * 4.40) / 1_000_000;
    assert.equal(cost, Math.round(expected * 1_000_000) / 1_000_000);
  });

  await t.test("rounds to 6 decimal places", async () => {
    const usage: UsageStats = {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    };
    const pricing: ModelPricing = {
      inputPer1M: 3.00,
      outputPer1M: 15.00,
    };

    // cost = (1 * 3.00) / 1M + (1 * 15.00) / 1M
    //      = 0.000003 + 0.000015 = 0.000018
    const cost = estimateCost(usage, pricing);
    assert.equal(cost, 0.000018);

    // Verify the result has at most 6 decimal places
    const parts = cost.toString().split(".");
    const decimals = parts[1] ? parts[1].length : 0;
    assert.ok(decimals <= 6, `Expected at most 6 decimal places, got ${decimals}`);
  });
});

// ---------------------------------------------------------------------------
// getModelPricing
// ---------------------------------------------------------------------------

test("getModelPricing", async (t) => {
  await t.test("returns exact match pricing", async () => {
    const pricing = getModelPricing("gpt-4o", testConfig);
    assert.deepEqual(pricing, {
      inputPer1M: 2.50,
      outputPer1M: 10.00,
      cachedInputPer1M: 1.25,
    });
  });

  await t.test("resolves configured gpt-5.4-mini-1 pricing", async () => {
    const pricing = getModelPricing("gpt-5.4-mini-1", testConfig);
    assert.deepEqual(pricing, {
      inputPer1M: 0.75,
      outputPer1M: 4.50,
      cachedInputPer1M: 0.075,
    });
  });

  await t.test("falls back to config.fallbackPricing for unknown model", async () => {
    const pricing = getModelPricing("unknown-model-xyz", testConfig);
    assert.deepEqual(pricing, DEFAULT_FALLBACK_PRICING);
    assert.deepEqual(pricing, {
      inputPer1M: 1.00,
      outputPer1M: 4.00,
    });
  });
});
