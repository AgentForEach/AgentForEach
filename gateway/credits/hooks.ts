/**
 * AgentForEach Credits Module — Hook Registration
 *
 * Registers two hooks:
 *   1. Reserve available balance before `client.send()` (called by client.ts)
 *   2. Settle actual cost and refund the remainder on `run_completed`
 *
 * Cost formula:
 *   coins = max(minimumCharge, round(estimatedCostUsd × costMultiplier))
 *
 * Reservation is fail-closed so paid usage cannot proceed without a ledger.
 */

import type { HookEmitter } from "../hooks/index.js";
import type { UsageStats } from "../llms/index.js";
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
    // Deduct for successful LLM work with usage data. `awaiting_input` means
    // the model already spent tokens to produce a structured form request.
    // Anything else (aborted, or a replayed/short-circuited turn that burned
    // no tokens) settles at 0, which releases the reservation and refunds.
    const billable =
      ["completed", "awaiting_input"].includes(event.response.status) &&
      event.response.usage !== undefined;

    const coins = billable
      ? computeCoins(
          event.response.usage!,
          event.response.model,
          config,
          usageConfig,
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
        ? computeCoins(event.usage, event.model, config, usageConfig)
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

// ============================================================================
// Cost computation
// ============================================================================

/**
 * Compute how many coins to deduct from a usage record.
 *
 * Formula: max(minimumCharge, round(estimatedCostUsd × costMultiplier))
 */
export function computeCoins(
  usage: UsageStats,
  model: string,
  config: CreditsConfig,
  usageConfig: ReturnType<typeof loadUsageConfig>,
): number {
  const pricing = getModelPricing(model, usageConfig);
  const costUsd = estimateCost(usage, pricing);
  const raw = Math.round(costUsd * config.costMultiplier);
  return Math.max(config.minimumCharge, raw);
}
