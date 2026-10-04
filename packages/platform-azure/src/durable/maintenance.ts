/**
 * Durable Functions housekeeping the Azure pack adds to the gateway's
 * schedules: finished instances are purged from the task hub after an hour,
 * so its storage doesn't grow with every turn.
 */

import * as df from "durable-functions";
import type { ScheduleDef } from "@agentforeach/platform";
import { currentInvocationContext } from "../host.js";

/** Finished instances older than this are purged. */
const RETAIN_MS = 60 * 60 * 1000;
/** Look back this far each run (covers downtime of the timer). */
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export const durableHistoryPurge: ScheduleDef = {
  name: "DurableHistoryPurge",
  schedule: "0 */15 * * * *",
  durable: true,
  handler: async (ctx) => {
    const client = df.getClient(currentInvocationContext()!);
    const now = Date.now();
    try {
      const result = await client.purgeInstanceHistoryBy({
        createdTimeFrom: new Date(now - LOOKBACK_MS),
        createdTimeTo: new Date(now - RETAIN_MS),
        runtimeStatus: [
          df.OrchestrationRuntimeStatus.Completed,
          df.OrchestrationRuntimeStatus.Failed,
          df.OrchestrationRuntimeStatus.Terminated,
        ],
      });
      ctx.log(`[durable-purge] purged ${result.instancesDeleted} finished instances`);
    } catch (err) {
      ctx.warn(`[durable-purge] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/** The table with the Azure pack's own schedules added. */
export function withDurableMaintenance<T extends { schedules: readonly ScheduleDef[] }>(table: T): T {
  return { ...table, schedules: [...table.schedules, durableHistoryPurge] };
}
