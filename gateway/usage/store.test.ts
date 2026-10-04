import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStorage } from "@agentforeach/storage";
import { UsageStore, aggregateRecords } from "./store.js";
import { resetUsageConfigCache, type UsageConfig } from "./config.js";
import type { UsageRecord } from "./types.js";

// ============================================================================
// Setup Helper
// ============================================================================

async function setup(overrides?: Partial<UsageConfig>): Promise<UsageStore> {
  resetUsageConfigCache();
  const db = new InMemoryStorage();
  const config: UsageConfig = {
    enabled: true,
    containerId: "usage-records",
    ttlSeconds: 7_776_000,
    pricing: {
      "gpt-5-mini": {
        inputPer1M: 0.30,
        outputPer1M: 1.20,
        cachedInputPer1M: 0.15,
      },
      "gpt-4o": {
        inputPer1M: 2.50,
        outputPer1M: 10.00,
        cachedInputPer1M: 1.25,
      },
    },
    fallbackPricing: { inputPer1M: 1.00, outputPer1M: 4.00 },
    ...overrides,
  };
  const store = new UsageStore(db, config);
  await store.initialize();
  return store;
}

// ============================================================================
// Record Params Helper
// ============================================================================

function makeRecordParams(
  overrides?: Partial<{
    userId: string;
    sessionId: string;
    agentId: string;
    runId: string;
    providerId: "openai" | "anthropic";
    model: string;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens?: number; reasoningTokens?: number };
    durationMs: number;
    timestamp: string;
  }>,
) {
  return {
    userId: "user-1",
    sessionId: "session-1",
    agentId: "default",
    runId: "run-" + Math.random().toString(36).slice(2, 8),
    providerId: "openai" as const,
    model: "gpt-5-mini",
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    durationMs: 1234,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

// ----------------------------------------------------------------------------
// UsageStore.record
// ----------------------------------------------------------------------------

test("UsageStore.record", async (t) => {
  await t.test("creates document with correct fields", async () => {
    const store = await setup();
    const params = makeRecordParams({
      userId: "user-1",
      sessionId: "sess-abc",
      agentId: "my-agent",
      runId: "run-xyz",
      providerId: "openai",
      model: "gpt-5-mini",
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
      durationMs: 2000,
      timestamp: "2026-01-15T10:00:00.000Z",
    });

    const doc = await store.record(params);

    assert.ok(doc, "should return a document");
    assert.equal(doc.id, "user-1:run-xyz");
    assert.equal(doc.userId, "user-1");
    assert.equal(doc.sessionId, "sess-abc");
    assert.equal(doc.agentId, "my-agent");
    assert.equal(doc.runId, "run-xyz");
    assert.equal(doc.providerId, "openai");
    assert.equal(doc.model, "gpt-5-mini");
    assert.equal(doc.inputTokens, 1000);
    assert.equal(doc.outputTokens, 500);
    assert.equal(doc.totalTokens, 1500);
    assert.equal(doc.timestamp, "2026-01-15T10:00:00.000Z");
    assert.equal(doc.durationMs, 2000);
    assert.equal(typeof doc.estimatedCostUsd, "number");
  });

  await t.test("calculates estimatedCostUsd from model pricing", async () => {
    const store = await setup();
    const params = makeRecordParams({
      model: "gpt-5-mini",
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });

    const doc = await store.record(params);
    assert.ok(doc);

    // gpt-5-mini pricing: inputPer1M=0.30, outputPer1M=1.20
    // cost = (1000 * 0.30 + 500 * 1.20) / 1_000_000
    //      = (300 + 600) / 1_000_000
    //      = 900 / 1_000_000
    //      = 0.0009
    const expected = (1000 * 0.30 + 500 * 1.20) / 1_000_000;
    assert.equal(doc.estimatedCostUsd, Math.round(expected * 1_000_000) / 1_000_000);
  });

  await t.test("no-ops when disabled", async () => {
    const store = await setup({ enabled: false });
    const params = makeRecordParams();

    const result = await store.record(params);
    assert.equal(result, null);
  });

  await t.test("uses fallback pricing for unknown model", async () => {
    const store = await setup();
    const params = makeRecordParams({
      model: "unknown-model",
      usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    });

    const doc = await store.record(params);
    assert.ok(doc);

    // fallback pricing: inputPer1M=1.00, outputPer1M=4.00
    // cost = (1000 * 1.00 + 500 * 4.00) / 1_000_000
    //      = (1000 + 2000) / 1_000_000
    //      = 3000 / 1_000_000
    //      = 0.003
    const expected = (1000 * 1.00 + 500 * 4.00) / 1_000_000;
    assert.equal(doc.estimatedCostUsd, Math.round(expected * 1_000_000) / 1_000_000);
  });
});

// ----------------------------------------------------------------------------
// UsageStore.recordCreditCharge
// ----------------------------------------------------------------------------

test("UsageStore.recordCreditCharge", async (t) => {
  await t.test("patches coin charge audit fields on an existing record", async () => {
    const store = await setup();
    await store.record(
      makeRecordParams({
        userId: "user-1",
        runId: "run-credit-1",
      }),
    );

    const doc = await store.recordCreditCharge({
      userId: "user-1",
      runId: "run-credit-1",
      coinsCharged: 3,
      currencyCode: "CRD",
      status: "deducted",
      balanceAfter: 97,
      costMultiplier: 100,
      minimumCharge: 1,
      chargedAt: "2026-04-29T10:00:00.000Z",
    });

    assert.ok(doc);
    assert.equal(doc.coinsCharged, 3);
    assert.equal(doc.coinCurrencyCode, "CRD");
    assert.equal(doc.coinChargeStatus, "deducted");
    assert.equal(doc.coinBalanceAfter, 97);
    assert.equal(doc.coinCostMultiplier, 100);
    assert.equal(doc.coinMinimumCharge, 1);
    assert.equal(doc.coinChargedAt, "2026-04-29T10:00:00.000Z");
  });

  await t.test("records skipped deductions with a failure reason", async () => {
    const store = await setup();
    await store.record(
      makeRecordParams({
        userId: "user-1",
        runId: "run-credit-skipped",
      }),
    );

    const doc = await store.recordCreditCharge({
      userId: "user-1",
      runId: "run-credit-skipped",
      coinsCharged: 0,
      currencyCode: "CRD",
      status: "skipped",
      failureReason: "consume_failed",
      costMultiplier: 100,
      minimumCharge: 1,
      chargedAt: "2026-04-29T10:05:00.000Z",
    });

    assert.ok(doc);
    assert.equal(doc.coinsCharged, 0);
    assert.equal(doc.coinChargeStatus, "skipped");
    assert.equal(doc.coinChargeFailureReason, "consume_failed");
  });

  await t.test("no-ops when usage tracking is disabled", async () => {
    const store = await setup({ enabled: false });

    const result = await store.recordCreditCharge({
      userId: "user-1",
      runId: "run-disabled",
      coinsCharged: 1,
      currencyCode: "CRD",
      status: "deducted",
      costMultiplier: 100,
      minimumCharge: 1,
    });

    assert.equal(result, null);
  });
});

// ----------------------------------------------------------------------------
// UsageStore.getRecords
// ----------------------------------------------------------------------------

test("UsageStore.getRecords", async (t) => {
  await t.test("returns records ordered by timestamp DESC", async () => {
    const store = await setup();

    await store.record(
      makeRecordParams({
        runId: "run-1",
        timestamp: "2026-01-01T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-2",
        timestamp: "2026-01-03T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-3",
        timestamp: "2026-01-02T10:00:00.000Z",
      }),
    );

    const records = await store.getRecords("user-1");

    assert.equal(records.length, 3);
    assert.equal(records[0].runId, "run-2"); // Jan 3 — newest
    assert.equal(records[1].runId, "run-3"); // Jan 2
    assert.equal(records[2].runId, "run-1"); // Jan 1 — oldest
  });

  await t.test("respects limit", async () => {
    const store = await setup();

    for (let i = 0; i < 5; i++) {
      await store.record(
        makeRecordParams({
          runId: `run-${i}`,
          timestamp: `2026-01-0${i + 1}T10:00:00.000Z`,
        }),
      );
    }

    const records = await store.getRecords("user-1", { limit: 2 });
    assert.equal(records.length, 2);
  });

  await t.test("filters by date range", async () => {
    const store = await setup();

    await store.record(
      makeRecordParams({
        runId: "run-early",
        timestamp: "2026-01-01T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-mid",
        timestamp: "2026-01-15T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-late",
        timestamp: "2026-01-30T10:00:00.000Z",
      }),
    );

    const records = await store.getRecords("user-1", {
      from: "2026-01-10T00:00:00.000Z",
      to: "2026-01-20T00:00:00.000Z",
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].runId, "run-mid");
  });

  await t.test("returns empty array when no records", async () => {
    const store = await setup();

    const records = await store.getRecords("user-nonexistent");
    assert.deepEqual(records, []);
  });

  await t.test("clamps limit to max 200", async () => {
    const store = await setup();

    // Create 3 records
    for (let i = 0; i < 3; i++) {
      await store.record(
        makeRecordParams({
          runId: `run-${i}`,
          timestamp: `2026-01-0${i + 1}T10:00:00.000Z`,
        }),
      );
    }

    // Request limit > 200 — should be clamped to 200 (all 3 returned since 3 < 200)
    const records = await store.getRecords("user-1", { limit: 999 });
    assert.equal(records.length, 3);
  });

  await t.test("clamps limit to min 1", async () => {
    const store = await setup();

    await store.record(
      makeRecordParams({
        runId: "run-only",
        timestamp: "2026-01-01T10:00:00.000Z",
      }),
    );

    // Request limit 0 or negative — should be clamped to 1
    const records = await store.getRecords("user-1", { limit: 0 });
    assert.equal(records.length, 1);

    const records2 = await store.getRecords("user-1", { limit: -5 });
    assert.equal(records2.length, 1);
  });
});

// ----------------------------------------------------------------------------
// UsageStore.getSummary
// ----------------------------------------------------------------------------

test("UsageStore.getSummary", async (t) => {
  await t.test("aggregates token counts and cost", async () => {
    const store = await setup();

    await store.record(
      makeRecordParams({
        runId: "run-a",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        timestamp: "2026-01-10T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-b",
        usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
        timestamp: "2026-01-11T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-c",
        usage: { inputTokens: 500, outputTokens: 250, totalTokens: 750 },
        timestamp: "2026-01-12T10:00:00.000Z",
      }),
    );

    const summary = await store.getSummary("user-1");

    assert.equal(summary.totalInputTokens, 3500);
    assert.equal(summary.totalOutputTokens, 1750);
    assert.equal(summary.totalTokens, 5250);
    assert.equal(summary.requestCount, 3);
    assert.equal(typeof summary.totalCostUsd, "number");
    assert.ok(summary.totalCostUsd > 0, "total cost should be positive");
  });

  await t.test("groups breakdown by provider:model", async () => {
    const store = await setup();

    await store.record(
      makeRecordParams({
        runId: "run-1",
        providerId: "openai",
        model: "gpt-5-mini",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        timestamp: "2026-01-10T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-2",
        providerId: "openai",
        model: "gpt-4o",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        timestamp: "2026-01-11T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-3",
        providerId: "openai",
        model: "gpt-5-mini",
        usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
        timestamp: "2026-01-12T10:00:00.000Z",
      }),
    );

    const summary = await store.getSummary("user-1");

    assert.equal(summary.breakdown.length, 2);

    const miniEntry = summary.breakdown.find((e) => e.model === "gpt-5-mini");
    const gpt4oEntry = summary.breakdown.find((e) => e.model === "gpt-4o");

    assert.ok(miniEntry, "should have gpt-5-mini breakdown entry");
    assert.ok(gpt4oEntry, "should have gpt-4o breakdown entry");

    assert.equal(miniEntry.providerId, "openai");
    assert.equal(miniEntry.inputTokens, 1500);
    assert.equal(miniEntry.outputTokens, 700);
    assert.equal(miniEntry.requestCount, 2);

    assert.equal(gpt4oEntry.providerId, "openai");
    assert.equal(gpt4oEntry.inputTokens, 1000);
    assert.equal(gpt4oEntry.outputTokens, 500);
    assert.equal(gpt4oEntry.requestCount, 1);
  });

  await t.test("filters by date range", async () => {
    const store = await setup();

    await store.record(
      makeRecordParams({
        runId: "run-jan",
        usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
        timestamp: "2026-01-05T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-feb",
        usage: { inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 },
        timestamp: "2026-02-15T10:00:00.000Z",
      }),
    );
    await store.record(
      makeRecordParams({
        runId: "run-mar",
        usage: { inputTokens: 500, outputTokens: 250, totalTokens: 750 },
        timestamp: "2026-03-20T10:00:00.000Z",
      }),
    );

    // Only Feb records
    const summary = await store.getSummary("user-1", {
      from: "2026-02-01T00:00:00.000Z",
      to: "2026-02-28T23:59:59.999Z",
    });

    assert.equal(summary.requestCount, 1);
    assert.equal(summary.totalInputTokens, 2000);
    assert.equal(summary.totalOutputTokens, 1000);
    assert.equal(summary.totalTokens, 3000);
    assert.equal(summary.period.from, "2026-02-01T00:00:00.000Z");
    assert.equal(summary.period.to, "2026-02-28T23:59:59.999Z");
  });

  await t.test("returns zero-value summary when no records", async () => {
    const store = await setup();

    const summary = await store.getSummary("user-nonexistent");

    assert.equal(summary.totalInputTokens, 0);
    assert.equal(summary.totalOutputTokens, 0);
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.totalCostUsd, 0);
    assert.equal(summary.requestCount, 0);
    assert.deepEqual(summary.breakdown, []);
  });
});

// ----------------------------------------------------------------------------
// aggregateRecords (pure function)
// ----------------------------------------------------------------------------

test("aggregateRecords", async (t) => {
  await t.test("aggregates correctly", async () => {
    const records: UsageRecord[] = [
      {
        id: "u1:r1",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r1",
        providerId: "openai",
        model: "gpt-5-mini",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        estimatedCostUsd: 0.0009,
        timestamp: "2026-01-10T10:00:00.000Z",
        durationMs: 1000,
      },
      {
        id: "u1:r2",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r2",
        providerId: "openai",
        model: "gpt-5-mini",
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
        estimatedCostUsd: 0.0018,
        timestamp: "2026-01-11T10:00:00.000Z",
        durationMs: 2000,
      },
      {
        id: "u1:r3",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r3",
        providerId: "anthropic",
        model: "claude-sonnet-4-20250514",
        inputTokens: 500,
        outputTokens: 200,
        totalTokens: 700,
        estimatedCostUsd: 0.0045,
        timestamp: "2026-01-12T10:00:00.000Z",
        durationMs: 1500,
      },
    ];

    const summary = aggregateRecords(records, {
      from: "2026-01-10T00:00:00.000Z",
      to: "2026-01-12T23:59:59.999Z",
    });

    assert.equal(summary.totalInputTokens, 3500);
    assert.equal(summary.totalOutputTokens, 1700);
    assert.equal(summary.totalTokens, 5200);
    assert.equal(
      summary.totalCostUsd,
      Math.round((0.0009 + 0.0018 + 0.0045) * 1_000_000) / 1_000_000,
    );
    assert.equal(summary.requestCount, 3);
    assert.equal(summary.period.from, "2026-01-10T00:00:00.000Z");
    assert.equal(summary.period.to, "2026-01-12T23:59:59.999Z");
    assert.equal(summary.breakdown.length, 2);

    const miniEntry = summary.breakdown.find((e) => e.model === "gpt-5-mini");
    const claudeEntry = summary.breakdown.find(
      (e) => e.model === "claude-sonnet-4-20250514",
    );

    assert.ok(miniEntry);
    assert.equal(miniEntry.inputTokens, 3000);
    assert.equal(miniEntry.outputTokens, 1500);
    assert.equal(miniEntry.totalTokens, 4500);
    assert.equal(miniEntry.requestCount, 2);

    assert.ok(claudeEntry);
    assert.equal(claudeEntry.inputTokens, 500);
    assert.equal(claudeEntry.outputTokens, 200);
    assert.equal(claudeEntry.totalTokens, 700);
    assert.equal(claudeEntry.requestCount, 1);
  });

  await t.test("rounds breakdown costUsd values", async () => {
    // Use costs that produce floating-point drift when summed
    const records: UsageRecord[] = [
      {
        id: "u1:r1",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r1",
        providerId: "openai",
        model: "gpt-5-mini",
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        estimatedCostUsd: 0.000001,
        timestamp: "2026-01-10T10:00:00.000Z",
        durationMs: 1000,
      },
      {
        id: "u1:r2",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r2",
        providerId: "openai",
        model: "gpt-5-mini",
        inputTokens: 2000,
        outputTokens: 1000,
        totalTokens: 3000,
        estimatedCostUsd: 0.000002,
        timestamp: "2026-01-11T10:00:00.000Z",
        durationMs: 2000,
      },
    ];

    const summary = aggregateRecords(records, {
      from: "2026-01-10T00:00:00.000Z",
      to: "2026-01-11T23:59:59.999Z",
    });

    assert.equal(summary.breakdown.length, 1);
    const entry = summary.breakdown[0];

    // costUsd should be rounded to 6 decimal places
    const parts = entry.costUsd.toString().split(".");
    const decimals = parts[1] ? parts[1].length : 0;
    assert.ok(
      decimals <= 6,
      `Expected breakdown costUsd to have at most 6 decimal places, got ${decimals}`,
    );
    assert.equal(entry.costUsd, 0.000003);
  });

  await t.test("sorts breakdown by cost descending", async () => {
    const records: UsageRecord[] = [
      {
        id: "u1:r1",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r1",
        providerId: "openai",
        model: "cheap-model",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.001,
        timestamp: "2026-01-10T10:00:00.000Z",
        durationMs: 500,
      },
      {
        id: "u1:r2",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r2",
        providerId: "openai",
        model: "expensive-model",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.05,
        timestamp: "2026-01-11T10:00:00.000Z",
        durationMs: 800,
      },
      {
        id: "u1:r3",
        userId: "user-1",
        sessionId: "s1",
        agentId: "default",
        runId: "r3",
        providerId: "anthropic",
        model: "mid-model",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.01,
        timestamp: "2026-01-12T10:00:00.000Z",
        durationMs: 600,
      },
    ];

    const summary = aggregateRecords(records, {
      from: "2026-01-10T00:00:00.000Z",
      to: "2026-01-12T23:59:59.999Z",
    });

    assert.equal(summary.breakdown.length, 3);
    assert.equal(summary.breakdown[0].model, "expensive-model");
    assert.equal(summary.breakdown[1].model, "mid-model");
    assert.equal(summary.breakdown[2].model, "cheap-model");

    // Verify descending cost ordering
    for (let i = 0; i < summary.breakdown.length - 1; i++) {
      assert.ok(
        summary.breakdown[i].costUsd >= summary.breakdown[i + 1].costUsd,
        `breakdown[${i}].costUsd (${summary.breakdown[i].costUsd}) should be >= breakdown[${i + 1}].costUsd (${summary.breakdown[i + 1].costUsd})`,
      );
    }
  });
});

// ----------------------------------------------------------------------------
// ensureInitialized guard
// ----------------------------------------------------------------------------

test("UsageStore — throws if not initialized", async () => {
  resetUsageConfigCache();
  const db = new InMemoryStorage();
  const config: UsageConfig = {
    enabled: true,
    containerId: "usage-records",
    ttlSeconds: 7_776_000,
    pricing: {},
    fallbackPricing: { inputPer1M: 1.00, outputPer1M: 4.00 },
  };
  const store = new UsageStore(db, config);

  // Do NOT call initialize()

  await assert.rejects(
    () => store.record(makeRecordParams()),
    { message: /not initialized/i },
  );

  await assert.rejects(
    () => store.getRecords("user-1"),
    { message: /not initialized/i },
  );

  await assert.rejects(
    () => store.getSummary("user-1"),
    { message: /not initialized/i },
  );
});
