/**
 * AgentForEach Gateway — Cron Scheduler Signal Helper
 *
 * Shared factory for the `onCronMutation` callback used by all handler
 * entry-points (HTTP API, WebSocket, channel webhooks).
 *
 * When cron tools create/update/delete jobs, the callback signals the
 * scheduler alarm to wake up and re-evaluate its next tick.
 * Without this, the scheduler only discovers new jobs on its next
 * natural cycle (up to 5 minutes).
 *
 * Extracted here to avoid duplicating the same closure across every
 * handler module.
 */

import type { HandlerContext } from "@agentforeach/platform";
import { wakeOrStartScheduler } from "../cron/orchestrator.js";
import {
  getSchedulerInstanceId,
  getSchedulerShardCount,
  getSchedulerShardForUser,
} from "../cron/config.js";
import { redactId } from "../utils/redact.js";

/**
 * Create an `onCronMutation` callback for a user, logging to `context`.
 *
 * The returned async function is safe to call multiple times and never
 * throws — scheduler signal failures are non-fatal.
 *
 * Strategy:
 *   1. Wake the user's scheduler shard, so it re-evaluates its next tick.
 *   2. If it isn't running (e.g. local development, or it stopped), start
 *      it; a start that loses a race to another caller is fine.
 *   3. If that fails too, the health check recovers it on its next cycle.
 */
export function createCronMutationSignal(
  context: HandlerContext,
  userId: string,
): () => Promise<void> {
  return async () => {
    try {
      const shardCount = getSchedulerShardCount();
      const shardId = getSchedulerShardForUser(userId, shardCount);
      const instanceId = getSchedulerInstanceId(shardId, shardCount);
      const result = await wakeOrStartScheduler(shardId, shardCount);
      if (result === "started") context.log(`[cron-signal] Started scheduler ${instanceId} (shard=${shardId})`);
      else context.log(`[cron-signal] Signaled scheduler ${instanceId} (shard=${shardId}, user=${redactId(userId)})`);
    } catch (err) {
      context.warn(
        `[cron-signal] Failed to signal scheduler for user=${redactId(userId)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
