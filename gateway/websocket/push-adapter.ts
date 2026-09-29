/**
 * AgentForEach Cron System — Web PubSub Delivery Adapter
 *
 * Delivers cron job results to connected clients via Azure Web PubSub.
 *
 * When a cron job completes:
 *   1. Executor calls dispatchDelivery() (executor.ts)
 *   2. dispatchDelivery() routes to deliverToChannel() (delivery.ts)
 *   3. deliverToChannel() resolves to this adapter (channelId = "push")
 *   4. This adapter sends an event frame to the user via Web PubSub
 *
 * The user's iOS/Android/Web app receives the event in real-time
 * through its WebSocket connection to Web PubSub.
 *
 * Registration: Import this module at startup (e.g., in cron/index.ts)
 * to register the adapter. It self-registers on import.
 */

import {
  registerDeliveryAdapter,
  type DeliveryAdapter,
  type DeliveryPayload,
  type DeliveryResult,
  type CronJob,
  type DeliveryTarget,
} from "../cron/index.js";
import { sendEventToUser } from "./emitter.js";
import { EVENTS, type CronEventPayload } from "./types.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// Push Delivery Adapter
// ============================================================================

const pushAdapter: DeliveryAdapter = {
  channelId: "push",
  displayName: "Push Notification (Web PubSub)",

  async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
    const { job, result, text } = payload;

    const cronEvent: CronEventPayload = {
      jobId: job.id,
      jobName: job.name,
      userId: job.userId,
      status: result.status,
      summary: text,
      error: result.error,
      durationMs: result.durationMs,
      model: result.model,
      ts: Date.now(),
    };

    try {
      console.log(
        `[push-adapter] Delivering cron event to user=${redactId(job.userId)}, job=${job.id} (${job.name})`,
      );
      await sendEventToUser(job.userId, EVENTS.CRON, cronEvent);
      console.log(`[push-adapter] Delivered successfully to user=${redactId(job.userId)}`);

      return {
        success: true,
        metadata: { channel: "push", userId: job.userId },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[push-adapter] Delivery failed for user=${redactId(job.userId)}: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  },

  async resolveTarget(job: CronJob): Promise<DeliveryTarget | undefined> {
    // For push delivery, the target is always the job owner.
    // The recipientId is the userId — Web PubSub routes by userId.
    return {
      channelId: "push",
      recipientId: job.userId,
      resolution: "from-profile",
    };
  },
};

// ============================================================================
// Self-Registration
// ============================================================================

/**
 * Register the push delivery adapter.
 *
 * This runs on import — importing this module is enough to enable
 * push delivery for cron jobs. Add `import "./realtime/push-adapter.js"`
 * to the cron module's barrel (or startup code).
 */
registerDeliveryAdapter(pushAdapter);

export { pushAdapter };
