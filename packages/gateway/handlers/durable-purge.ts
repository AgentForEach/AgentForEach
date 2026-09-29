/**
 * AgentForEach Gateway — Durable Functions history retention
 *
 * Every background chat turn, channel turn and HITL request is an
 * orchestration whose history (in Azure Storage tables and blobs) holds its
 * input: the user's message and any attachments. Durable keeps that forever
 * unless purged, which would outlive the 7-day message TTL and grow storage
 * without bound. This timer purges finished instances an hour after they
 * were created (long-running ones — the cron schedulers — are never
 * "finished" and are left alone).
 */

import { app, type InvocationContext, type Timer } from "@azure/functions";
import * as df from "durable-functions";

/** Finished instances older than this are purged. */
const RETAIN_MS = 60 * 60 * 1000;
/** Look back this far each run (covers downtime of the timer). */
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

app.timer("DurableHistoryPurge", {
  schedule: "0 */15 * * * *",
  extraInputs: [df.input.durableClient()],
  handler: async (_timer: Timer, ctx: InvocationContext) => {
    const client = df.getClient(ctx);
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
});
