/**
 * The durable sweep: reconciles active instance rows with Lambda, for what
 * no execution is left to do. The host's `schedule` handler runs it every
 * minute (`durableSweepSchedule`).
 *
 * For each active row, oldest-swept first:
 * - no execution ARN a minute after it was claimed (the invoke failed or its
 *   answer was lost): start the same execution name again, which Lambda
 *   deduplicates;
 * - the execution is RUNNING: send again a callback whose event (or wake)
 *   is in the row, in case the first send was lost;
 * - it TIMED_OUT or was STOPPED while the row was still active: start a
 *   fresh execution for the row, whose handler runs with `attempt > 1` if it
 *   had started (the port's interrupted-run model), up to `maxRuns` times;
 * - it SUCCEEDED or FAILED, or Lambda no longer knows it, with the row still
 *   active (it couldn't record its end): fail the row.
 *
 * Every write is guarded on the execution the sweep saw, so a row an
 * execution moved on meanwhile is left alone.
 */

import { isActive, type ScheduleDef } from "@agentforeach/platform";
import {
  dispatch,
  finished,
  resolvePack,
  type InstanceRow,
  type LambdaDurableOptions,
  type Pack,
} from "./instances.js";

export interface DurableSweepOptions extends LambdaDurableOptions {
  /** Rows looked at per run. Default 100. */
  limit?: number;
  /** How long a claimed row may wait for its execution's ARN before the sweep starts it. Default 1 minute. */
  dispatchGraceMs?: number;
}

export interface DurableSweepReport {
  checked: number;
  /** Executions started again under the same name. */
  dispatched: number;
  /** Fresh executions for rows whose execution closed early. */
  redispatched: number;
  /** Callbacks sent again. */
  woken: number;
  /** Rows failed because their execution ended without recording it. */
  failed: number;
  /** Rows that couldn't be reconciled this time (logged). */
  errors: number;
}

export function durableSweep(options: DurableSweepOptions): Promise<DurableSweepReport> {
  return sweep(resolvePack(options), options);
}

async function sweep(pack: Pack, options: DurableSweepOptions): Promise<DurableSweepReport> {
  const grace = options.dispatchGraceMs ?? 60_000;
  const report = emptyReport();
  for (const row of await pack.table.active(options.limit ?? 100)) {
    report.checked++;
    try {
      await reconcile(pack, row, grace, report);
    } catch (err) {
      report.errors++;
      pack.logger.warn(`[durable] sweep could not reconcile ${row.instanceId}:`, err);
    }
    // Look at others first next time, whatever happened here.
    await pack.table.touch(row.instanceId, (now) => ({ ...now, sweptAt: Date.now() })).catch(() => undefined);
  }
  return report;
}

/** An empty report, for callers that reconcile one row. */
export function emptyReport(): DurableSweepReport {
  return { checked: 0, dispatched: 0, redispatched: 0, woken: 0, failed: 0, errors: 0 };
}

/** Reconcile one active row with its execution (see the module comment). */
export async function reconcile(pack: Pack, row: InstanceRow, graceMs: number, report: DurableSweepReport): Promise<void> {
  const same = (now: InstanceRow) => now.execution === row.execution && isActive(now.status);
  if (!row.executionArn) {
    if (Date.now() - row.updatedAt < graceMs) return;
    await dispatch(pack, row);
    report.dispatched++;
    return;
  }
  const status = await pack.control.status(row.executionArn);
  if (status === "RUNNING") {
    const owed = row.type === "wait" ? !!row.event && !row.outcome : row.type === "alarm" && !!row.wake;
    if (owed && row.callbackId) {
      await pack.control.sendCallback(row.callbackId).catch(() => undefined);
      report.woken++;
    }
    return;
  }
  if (status === "TIMED_OUT" || status === "STOPPED") {
    if ((row.redispatches ?? 0) >= pack.maxRuns) {
      if (await pack.table.update(row.instanceId, (now) => (same(now) ? finished(pack, now, "failed") : undefined))) {
        pack.logger.error(`[durable] ${row.type} ${row.kind} ${row.instanceId}: its executions kept closing early; failed it`);
        report.failed++;
      }
      return;
    }
    const execution = pack.executionName(row.instanceId);
    const next = await pack.table.update(row.instanceId, (now) =>
      same(now)
        ? {
            ...now,
            execution,
            executionArn: undefined,
            callbackId: undefined,
            ticking: undefined,
            redispatches: (now.redispatches ?? 0) + 1,
          }
        : undefined,
    );
    if (!next) return;
    pack.logger.warn(`[durable] ${row.type} ${row.kind} ${row.instanceId}: execution ${status}; starting it again`);
    await dispatch(pack, next);
    report.redispatched++;
    return;
  }
  // SUCCEEDED, FAILED or unknown, with the row still active.
  if (await pack.table.update(row.instanceId, (now) => (same(now) ? finished(pack, now, "failed") : undefined))) {
    pack.logger.error(`[durable] ${row.type} ${row.kind} ${row.instanceId}: execution ${status ?? "not found"} left it active; failed it`);
    report.failed++;
  }
}

/** The sweep as a schedule, every minute, for the Lambda host's `schedule` handler. */
export function durableSweepSchedule(options: DurableSweepOptions): ScheduleDef {
  let pack: Pack | undefined;
  return {
    name: "DurableSweep",
    schedule: "0 * * * * *",
    handler: async (context) => {
      pack ??= resolvePack(options);
      const report = await sweep(pack, options);
      if (report.dispatched || report.redispatched || report.woken || report.failed || report.errors) {
        context.log(`[durable] sweep: ${JSON.stringify(report)}`);
      }
    },
  };
}
