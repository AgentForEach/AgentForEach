import test from "node:test";
import assert from "node:assert/strict";

import { HookEmitter } from "../hooks/index.js";
import { computeCoins, registerCreditsHooks, releaseReservationOnThrow, runMetered } from "./hooks.js";
import { loadUsageConfig } from "../usage/config.js";
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

test("credits bill an aborted run for the rounds it completed", async () => {
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
  assert.ok(provider.charges[0].amount >= config.minimumCharge);
});

test("credits release reservations for runs aborted before any model output", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, config);

  await hooks.emit("run_completed", {
    runId: "run-aborted-early",
    userId: "user-1",
    response: { ...response("completed"), status: "aborted" as const, usage: undefined },
  });

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

const RUN = { userId: "user-1", agentId: "default", sessionId: "cron:job-1", runId: "run-cron", channelName: "cron" };
const modelReply = () => ({
  text: "done",
  model: "gpt-5.4-mini",
  providerId: "openai" as const,
  usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
});

test("a metered run outside a turn is reserved, billed and recorded", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, config);
  const recorded: unknown[] = [];
  const usageStore = { async record(r: unknown) { recorded.push(r); return null; } };

  const result = await runMetered({ hooks, usageStore: usageStore as never, creditProvider: provider }, RUN, async () => modelReply());

  assert.equal(result.text, "done");
  assert.equal(provider.charges.length, 1);
  assert.equal(provider.charges[0].runId, "run-cron");
  assert.ok(provider.charges[0].amount >= config.minimumCharge);
  assert.equal(recorded.length, 1);
});

test("a metered run with no balance never calls the model", async () => {
  const hooks = new HookEmitter();
  const broke: CreditProvider = {
    ...createProvider(),
    async reserve() {
      throw Object.assign(new Error("Out of credits"), { code: "INSUFFICIENT_CREDITS" });
    },
  };
  let called = false;
  await assert.rejects(
    runMetered({ hooks, creditProvider: broke }, RUN, async () => {
      called = true;
      return modelReply();
    }),
    /Out of credits/,
  );
  assert.equal(called, false);
});

test("a metered run that fails releases its reservation", async () => {
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, config);
  await assert.rejects(
    runMetered({ hooks, creditProvider: provider }, RUN, async () => {
      throw new Error("model down");
    }),
    /model down/,
  );
  assert.deepEqual(provider.charges.map((c) => c.amount), [0]);
});

test("credits charge metered units at credits.unitCoins, on top of tokens", async () => {
  // No minimum, so the difference between the two runs is exactly the units' price.
  const priced = { ...config, unitCoins: { browserAction: 2 }, minimumCharge: 0 };
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, priced);

  await hooks.emit("run_completed", { runId: "tokens-only", userId: "user-1", response: response("completed") });
  await hooks.emit("run_completed", {
    runId: "with-browser",
    userId: "user-1",
    response: response("completed"),
    units: { browserAction: 5, somethingUnpriced: 100 },
  });

  const [tokensOnly, withBrowser] = provider.charges;
  assert.equal(withBrowser.amount, tokensOnly.amount + 10, "5 actions × 2 coins; unpriced units are free");
});

test("computeCoins adds units at their price and ignores unpriced ones", () => {
  const priced = { ...config, unitCoins: { browserAction: 2 }, minimumCharge: 0 };
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const usageConfig = loadUsageConfig();
  assert.equal(computeCoins(usage, "gpt-5.4-mini", priced, usageConfig), 0);
  assert.equal(computeCoins(usage, "gpt-5.4-mini", priced, usageConfig, { browserAction: 3 }), 6);
  assert.equal(computeCoins(usage, "gpt-5.4-mini", priced, usageConfig, { unpriced: 9 }), 0);
  assert.equal(computeCoins(usage, "gpt-5.4-mini", config, usageConfig, { browserAction: 3 }), 1, "no unitCoins: only the minimum");
});

test("credits bill a failed run's metered units too", async () => {
  const priced = { ...config, unitCoins: { browserAction: 3 }, minimumCharge: 0 };
  const hooks = new HookEmitter();
  const provider = createProvider();
  registerCreditsHooks(hooks, provider, priced);
  await hooks.emit("run_failed", {
    runId: "failed-after-browsing",
    userId: "user-1",
    error: new Error("boom"),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    model: "gpt-5.4-mini",
    units: { browserAction: 4 },
  });
  assert.equal(provider.charges[0].amount, 12);
});

test("credits config keeps only valid unit prices", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadCreditsConfig, resetCreditsConfig } = await import("./config.js");
  const { resetConfigCache } = await import("../utils/index.js");
  const saved = process.env.CONFIG_FILE_JSON;
  const file = join(mkdtempSync(join(tmpdir(), "afe-credits-")), "c.json");
  writeFileSync(file, JSON.stringify({ credits: {
    enabled: true, balanceUrl: "https://c.test/b", consumeUrl: "https://c.test/c", reserveUrl: "https://c.test/r",
    settleUrl: "https://c.test/s", serviceKey: "k",
    unitCoins: { browserAction: 2, typo: "abc", refund: -5, free: 0, inf: 1e400 },
  } }));
  process.env.CONFIG_FILE_JSON = file;
  resetConfigCache();
  resetCreditsConfig();
  try {
    assert.deepEqual(loadCreditsConfig().unitCoins, { browserAction: 2, free: 0 });
  } finally {
    if (saved === undefined) delete process.env.CONFIG_FILE_JSON;
    else process.env.CONFIG_FILE_JSON = saved;
    resetConfigCache();
    resetCreditsConfig();
  }
});
