/**
 * AgentForEach Credits Module — Hook Registration
 *
 * Registers two hooks:
 *   1. Reserve available balance before `client.send()` (called by client.ts)
 *   2. Settle actual cost and refund the remainder on `run_completed`
 *
 * Cost formula:
 *   coins = max(minimumCharge, round(estimatedCostUsd × costMultiplier + Σ units × unitCoins))
 *
 * Reservation is fail-closed so paid usage cannot proceed without a ledger.
 */

import type { HookEmitter } from "../hooks/index.js";
import type { ProviderId, UsageStats } from "../llms/index.js";
import type { UsageStore } from "../usage/index.js";
import type { CreditsConfig, CreditProvider } from "./types.js";
import { getModelPricing, estimateCost } from "../usage/pricing.js";
import { loadUsageConfig } from "../usage/config.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// Hook registration
// ============================================================================

/**
 * Register the `run_completed` hook that deducts coins after each AI run.
 */
export function registerCreditsHooks(
  hooks: HookEmitter,
  provider: CreditProvider,
  config: CreditsConfig,
  usageStore?: UsageStore,
): void {
  const usageConfig = loadUsageConfig();

  hooks.on("run_completed", async (event) => {
    if (!event.userId) return;

    // Every terminal path MUST settle — a reservation left open holds the
    // user's balance hostage until the stale sweep runs, which surfaces as
    // a bogus "out of credits" on their next message.
    //
    // Deduct for LLM work with usage data. `awaiting_input` means the model
    // already spent tokens to produce a structured form request; an aborted
    // run is billed for the rounds it completed before the stop, like a
    // failed one. A turn that burned no tokens (a replay, a short-circuit)
    // settles at 0, which releases the reservation and refunds.
    const billable =
      ["completed", "awaiting_input", "aborted"].includes(event.response.status) &&
      event.response.usage !== undefined;

    const coins = billable
      ? computeCoins(
          event.response.usage!,
          event.response.model,
          config,
          usageConfig,
          event.units,
        )
      : 0;

    try {
      const settlement = await provider.settle(event.userId, event.runId, coins);
      // A 0-coin settle is a pure release — nothing was charged, so don't
      // write a ledger row for it.
      if (coins > 0) {
        await recordCreditCharge(usageStore, {
          userId: event.userId,
          runId: event.runId,
          coinsCharged: settlement.charged,
          currencyCode: config.currencyCode,
          status: "deducted",
          balanceAfter: settlement.balance,
          costMultiplier: config.costMultiplier,
          minimumCharge: config.minimumCharge,
        });
      }
      console.log(
        `[credits] Settled ${settlement.charged} coins for user=${redactId(event.userId)} ` +
          `runId=${event.runId} model=${event.response.model} ` +
          (event.units && Object.keys(event.units).length ? `units=${JSON.stringify(event.units)} ` : "") +
          `(refund=${settlement.refunded}, shortfall=${settlement.shortfall}) — balance=${settlement.balance}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (coins === 0) {
        // Pure release — nothing was owed, so a failure here is not a
        // billing event worth recording (it usually means there was no
        // reservation to release in the first place).
        console.warn(
          `[credits] Release failed for run=${event.runId}: ${reason}`,
        );
        return;
      }
      await recordCreditCharge(usageStore, {
        userId: event.userId,
        runId: event.runId,
        coinsCharged: 0,
        currencyCode: config.currencyCode,
        status: "skipped",
        failureReason: `settle_failed:${reason}`,
        costMultiplier: config.costMultiplier,
        minimumCharge: config.minimumCharge,
      });
    }
  });

  hooks.on("run_failed", async (event) => {
    if (!event.userId) return;
    // Rounds that completed before the failure spent real tokens; bill them
    // (a run that failed before any LLM call just releases its reservation).
    const coins =
      event.usage && event.model
        ? computeCoins(event.usage, event.model, config, usageConfig, event.units)
        : 0;
    try {
      const settlement = await provider.settle(event.userId, event.runId, coins);
      if (coins > 0) {
        await recordCreditCharge(usageStore, {
          userId: event.userId,
          runId: event.runId,
          coinsCharged: settlement.charged,
          currencyCode: config.currencyCode,
          status: "deducted",
          balanceAfter: settlement.balance,
          costMultiplier: config.costMultiplier,
          minimumCharge: config.minimumCharge,
        });
      }
    } catch (error) {
      console.error(
        `[credits] Failed to settle failed run=${event.runId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  });
}

async function recordCreditCharge(
  usageStore: UsageStore | undefined,
  params: Parameters<UsageStore["recordCreditCharge"]>[0],
): Promise<void> {
  if (!usageStore) return;
  try {
    await usageStore.recordCreditCharge(params);
  } catch (error) {
    console.warn(
      `[credits] Failed to record coin charge for user=${redactId(params.userId)} ` +
        `runId=${params.runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Pre-flight balance check. Call before `runAgentTurn()`.
 *
 * Returns the balance if sufficient, or throws with a user-friendly message
 * if insufficient. Returns `null` on API failure (fail-open).
 */
export async function checkCreditsBalance(
  userId: string,
  provider: CreditProvider,
  config: CreditsConfig,
): Promise<number | null> {
  if (!config.preFlightCheck) return null;

  const balance = await provider.getBalance(userId);

  // Fail-open: if we can't reach the credits API, allow the request.
  if (balance === null) return null;

  if (balance < config.minimumCharge) {
    const err = new Error(
      "You're out of credits. Purchase more to continue using AI features.",
    );
    (err as any).code = "INSUFFICIENT_CREDITS";
    (err as any).balance = balance;
    throw err;
  }

  return balance;
}

export async function reserveCredits(
  userId: string,
  runId: string,
  provider: CreditProvider,
): Promise<number> {
  const reservation = await provider.reserve(userId, runId);
  return reservation.reserved;
}

/**
 * Run `work` under a reservation. A run that ends normally is settled by the
 * run_completed / run_failed hooks; if `work` throws before the runner could
 * emit either (setup, prompt seeding, provider resolution), the reservation
 * is released here instead of holding the user's balance until the stale
 * sweep.
 */
export async function releaseReservationOnThrow<T>(
  provider: CreditProvider,
  userId: string,
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    await provider.settle(userId, runId, 0).catch((releaseErr: unknown) => {
      console.warn(
        `[credits] Release after a failed start failed for run=${runId}: ${
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
        }`,
      );
    });
    throw err;
  }
}

/**
 * Model work that runs outside a chat turn (a scheduled isolated job),
 * metered like a turn: credits are reserved first (so an empty balance
 * refuses it), usage is recorded, and the run is settled through the same
 * run_completed / run_failed hooks. Without a credit provider only usage is
 * recorded.
 */
export async function runMetered<
  T extends { text: string; model: string; providerId: ProviderId; usage?: UsageStats },
>(
  deps: {
    hooks: HookEmitter;
    usageStore?: Pick<UsageStore, "record">;
    creditProvider?: CreditProvider;
  },
  run: { userId: string; agentId: string; sessionId: string; runId: string; channelName?: string },
  work: () => Promise<T>,
): Promise<T> {
  if (deps.creditProvider) await reserveCredits(run.userId, run.runId, deps.creditProvider);

  const startedAt = Date.now();
  let result: T;
  try {
    result = await work();
  } catch (err) {
    await deps.hooks.emit("run_failed", {
      runId: run.runId,
      userId: run.userId,
      sessionId: run.sessionId,
      error: err instanceof Error ? err : new Error(String(err)),
    });
    throw err;
  }

  const durationMs = Date.now() - startedAt;
  if (result.usage && deps.usageStore) {
    await deps.usageStore
      .record({
        ...run,
        providerId: result.providerId,
        model: result.model,
        usage: result.usage,
        durationMs,
        timestamp: new Date().toISOString(),
      })
      .catch(() => {}); // Non-fatal
  }
  await deps.hooks.emit("run_completed", {
    runId: run.runId,
    userId: run.userId,
    response: {
      runId: run.runId,
      text: result.text,
      sessionId: run.sessionId,
      identity: { name: "Assistant" },
      providerId: result.providerId,
      model: result.model,
      usage: result.usage,
      memoriesRecalled: 0,
      memoryCaptured: false,
      durationMs,
      status: "completed",
    },
  });
  return result;
}

// ============================================================================
// Cost computation
// ============================================================================

/**
 * Compute how many coins to deduct from a usage record and the run's metered units.
 *
 * Formula: max(minimumCharge, round(estimatedCostUsd × costMultiplier + Σ units × unitCoins))
 */
export function computeCoins(
  usage: UsageStats,
  model: string,
  config: CreditsConfig,
  usageConfig: ReturnType<typeof loadUsageConfig>,
  units: Record<string, number> = {},
): number {
  const pricing = getModelPricing(model, usageConfig);
  const costUsd = estimateCost(usage, pricing);
  let unitCost = 0;
  for (const [unit, count] of Object.entries(units)) {
    unitCost += count * (config.unitCoins?.[unit] ?? 0);
  }
  const raw = Math.round(costUsd * config.costMultiplier + unitCost);
  return Math.max(config.minimumCharge, raw);
}
