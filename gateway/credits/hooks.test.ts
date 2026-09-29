import test from "node:test";
import assert from "node:assert/strict";

import { HookEmitter } from "../hooks/index.js";
import { registerCreditsHooks, releaseReservationOnThrow } from "./hooks.js";
import type { CreditProvider, CreditsConfig } from "./types.js";
import type { UsageStore } from "../usage/index.js";

const config: CreditsConfig = {
  enabled: true,
  balanceUrl: "https://example.com/balance",
  consumeUrl: "https://example.com/consume",
  reserveUrl: "https://example.com/reserve",
  settleUrl: "https://example.com/settle",
  currencyCode: "CRD",
  costMultiplier: 100,
  minimumCharge: 1,
  serviceKey: "test",
  preFlightCheck: true,
};

function createProvider(): CreditProvider & {
  charges: Array<{ userId: string; runId: string; amount: number }>;
} {
  const charges: Array<{ userId: string; runId: string; amount: number }> = [];
  return {
    charges,
    async getBalance() {
      return 100;
    },
    async reserve(_userId, runId) {
      return { runId, reserved: 100, balance: 0 };
    },
    async settle(userId, runId, amount) {
      charges.push({ userId, runId, amount });
      return {
        runId,
        reserved: 100,
        charged: amount,
        refunded: 100 - amount,
        shortfall: 0,
        balance: 100 - amount,
        status: amount === 0 ? "released" : "settled",
      };
    },
  };
}

function createFailingProvider(): CreditProvider {
  return {
    async getBalance() {
      return 100;
    },
    async reserve(_userId, runId) {
      return { runId, reserved: 100, balance: 0 };
    },
    async settle() {
      throw new Error("settlement unavailable");
    },
  };
}

function createUsageStore() {
  const charges: Array<Parameters<UsageStore["recordCreditCharge"]>[0]> = [];
  return {
    charges,
    async recordCreditCharge(params: Parameters<UsageStore["recordCreditCharge"]>[0]) {
      charges.push(params);
      return null;
    },
  };
}

function response(status: "completed" | "awaiting_input" | "failed") {
  return {
    runId: `run-${status}`,
    text: "ok",
    sessionId: "session-1",
    identity: { name: "Assistant" },
    providerId: "openai",
    model: "gpt-5.4-mini",
    memoriesRecalled: 0,
    memoryCaptured: false,
    durationMs: 100,
    status,
    usage: {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    },
  } as const;
}

test("credits deduct for completed runs with usage", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  const usageStore = createUsageStore();
  registerCreditsHooks(hooks, provider, config, usageStore as unknown as UsageStore);

  await hooks.emit("run_completed", {
    runId: "run-completed",
    userId: "user-1",
    response: response("completed"),
  });

  assert.equal(provider.charges.length, 1);
  assert.equal(provider.charges[0].userId, "user-1");
  assert.equal(provider.charges[0].runId, "run-completed");
  assert.ok(provider.charges[0].amount >= config.minimumCharge);
  assert.equal(usageStore.charges.length, 1);
  assert.equal(usageStore.charges[0].runId, "run-completed");
  assert.equal(usageStore.charges[0].coinsCharged, provider.charges[0].amount);
  assert.equal(usageStore.charges[0].currencyCode, "CRD");
  assert.equal(usageStore.charges[0].status, "deducted");
  assert.equal(usageStore.charges[0].balanceAfter, 100 - provider.charges[0].amount);
});

test("credits deduct for awaiting_input runs with usage", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, config);

  await hooks.emit("run_completed", {
    runId: "run-awaiting-input",
    userId: "user-1",
    response: response("awaiting_input"),
  });

  assert.equal(provider.charges.length, 1);
  assert.equal(provider.charges[0].userId, "user-1");
  assert.ok(provider.charges[0].amount >= config.minimumCharge);
});

test("credits release reservations for failed runs", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, config);

  await hooks.emit("run_failed", {
    runId: "run-failed",
    userId: "user-1",
    error: new Error("model failed"),
  });

  assert.equal(provider.charges.length, 1);
  assert.equal(provider.charges[0].amount, 0);
  assert.equal(provider.charges[0].runId, "run-failed");
});

test("credits bill a failed run for the rounds it completed", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, config);

  await hooks.emit("run_failed", {
    runId: "run-failed-late",
    userId: "user-1",
    error: new Error("second round failed"),
    usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
    model: "gpt-5.4-mini",
  });

  await hooks.emit("run_completed", {
    runId: "run-completed",
    userId: "user-1",
    response: response("completed"),
  });
  assert.equal(provider.charges.length, 2);
  assert.ok(provider.charges[0].amount > 0);
  assert.equal(provider.charges[0].amount, provider.charges[1].amount, "same tokens, same price");
});

test("credits release reservations for runs that report no usage", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  const usageStore = createUsageStore();
  registerCreditsHooks(hooks, provider, config, usageStore as unknown as UsageStore);

  // A suspended/replayed turn reports no usage. It must still settle, or the
  // reservation holds the user's whole balance until the stale sweep runs.
  const { usage: _usage, ...withoutUsage } = response("awaiting_input");

  await hooks.emit("run_completed", {
    runId: "run-no-usage",
    userId: "user-1",
    response: withoutUsage,
  });

  assert.equal(provider.charges.length, 1);
  assert.equal(provider.charges[0].runId, "run-no-usage");
  assert.equal(provider.charges[0].amount, 0);
  // A pure release is not a billing event — no ledger row.
  assert.equal(usageStore.charges.length, 0);
});

test("credits release reservations for aborted runs", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, config);

  await hooks.emit("run_completed", {
    runId: "run-aborted",
    userId: "user-1",
    response: { ...response("completed"), status: "aborted" as const },
  });

  assert.equal(provider.charges.length, 1);
  assert.equal(provider.charges[0].runId, "run-aborted");
  assert.equal(provider.charges[0].amount, 0);
});

test("credits record skipped charge when settlement fails", async () => {
  const hooks = new HookEmitter();
  const provider = createFailingProvider();
  const usageStore = createUsageStore();
  registerCreditsHooks(hooks, provider, config, usageStore as unknown as UsageStore);

  await hooks.emit("run_completed", {
    runId: "run-consume-failed",
    userId: "user-1",
    response: response("completed"),
  });

  assert.equal(usageStore.charges.length, 1);
  assert.equal(usageStore.charges[0].runId, "run-consume-failed");
  assert.equal(usageStore.charges[0].coinsCharged, 0);
  assert.equal(usageStore.charges[0].status, "skipped");
  assert.match(usageStore.charges[0].failureReason ?? "", /settle_failed/);
});

test("a run that throws before starting releases its reservation", async () => {
  const provider = createProvider();
  await assert.rejects(
    releaseReservationOnThrow(provider, "user-1", "run-early", async () => {
      throw new Error('Provider "x" is not configured');
    }),
    /not configured/,
  );
  assert.deepEqual(
    provider.charges.map((c) => [c.runId, c.amount]),
    [["run-early", 0]],
  );

  // A run that returns is left to the run_completed/run_failed hooks.
  assert.equal(await releaseReservationOnThrow(provider, "user-1", "run-ok", async () => "done"), "done");
  assert.equal(provider.charges.length, 1);
});
