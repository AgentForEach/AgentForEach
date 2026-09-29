/**
 * AgentForEach Gateway — Cron Scheduler Signal Helper
 *
 * Shared factory for the `onCronMutation` callback used by all handler
 * entry-points (HTTP API, WebSocket, channel webhooks).
 *
 * When cron tools create/update/delete jobs, the callback signals the
 * Durable Functions scheduler to wake up and re-evaluate its timer.
 * Without this, the scheduler only discovers new jobs on its next
 * natural cycle (up to 5 minutes).
 *
 * Extracted here to avoid duplicating the same closure across every
 * handler module.
 */

import * as df from "durable-functions";
import type { InvocationContext } from "@azure/functions";
import {
  JOBS_CHANGED_EVENT,
  getSchedulerInstanceId,
  getSchedulerShardCount,
  getSchedulerShardForUser,
} from "../cron/config.js";
import { redactId } from "../utils/redact.js";

/**
 * Create an `onCronMutation` callback bound to a specific Azure Functions
 * invocation context and user.
 *
 * The returned async function is safe to call multiple times and never
 * throws — scheduler signal failures are non-fatal.
 *
 * Strategy:
 *   1. Try `raiseEvent` to wake the scheduler immediately.
 *   2. If that fails (e.g. orchestrator not running — common in local dev
 *      with Azurite), fall back to starting the scheduler directly.
 *   3. If starting also fails (e.g. already running — 409 Conflict),
 *      the health-check timer will recover on the next cycle.
 *
 * @param context - Azure Functions invocation context (provides durable client).
 * @param userId - The user whose scheduler shard should be signaled.
 */
export function createCronMutationSignal(
  context: InvocationContext,
  userId: string,
): () => Promise<void> {
  return async () => {
    try {
      const durableClient = df.getClient(context);
      const shardCount = getSchedulerShardCount();
      const shardId = getSchedulerShardForUser(userId, shardCount);
      const instanceId = getSchedulerInstanceId(shardId, shardCount);

      // Check scheduler status first — raiseEvent silently succeeds even
      // when the orchestrator is in Failed/Terminated state, meaning the
      // event goes nowhere. Only raise if truly Running.
      const status = await durableClient.getStatus(instanceId);
      const runtimeStatus = status?.runtimeStatus;

      if (runtimeStatus === "Running" || runtimeStatus === "Pending") {
        await durableClient.raiseEvent(
          instanceId,
          JOBS_CHANGED_EVENT,
          { shardId, userId },
        );
        context.log(
          `[cron-signal] Signaled scheduler ${instanceId} (shard=${shardId}, user=${redactId(userId)})`,
        );
      } else {
        // Orchestrator is not running (Failed, Terminated, Completed, or absent).
        // Purge any stale state and start a fresh instance.
        context.warn(
          `[cron-signal] Scheduler ${instanceId} status=${runtimeStatus ?? "not-found"}. Starting fresh instance.`,
        );
        if (runtimeStatus) {
          // Purge the stale instance so startNew doesn't 409-conflict.
          try {
            await durableClient.purgeInstanceHistory(instanceId);
          } catch {
            // Best-effort — may fail if already purged or race condition.
          }
        }
        try {
          await durableClient.startNew("CronScheduler", {
            instanceId,
            input: { shardId },
          });
          context.log(
            `[cron-signal] Started scheduler ${instanceId} (shard=${shardId})`,
          );
        } catch {
          // 409 Conflict = instance started by another caller (expected race).
        }
      }
    } catch (err) {
      // Outer catch: df.getClient() or config resolution failed.
      context.warn(
        `[cron-signal] Failed to signal scheduler for user=${redactId(userId)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
