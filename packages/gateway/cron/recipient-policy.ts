/**
 * AgentForEach Cron — may this job deliver to this recipient?
 *
 * Recipients come from LLM tool arguments, API bodies, or are derived from
 * a job's sessionId, so none of them can be trusted on their own. A job may
 * only deliver to:
 *   - in-app push for its owner;
 *   - the chat it was created from (server-recorded channelBinding);
 *   - a channel account linked to its owner (identity link).
 * Checked at delivery time, so every creation path and old jobs are covered.
 */

import type { CronDelivery, CronJob, DeliveryTarget } from "./types.js";

/** Returns the AgentForEach user who owns a channel account, or null. */
export type ChannelOwnerLookup = (
  channelId: string,
  channelUserId: string,
) => Promise<string | null>;

export async function isRecipientOwned(
  job: Pick<CronJob, "userId" | "delivery">,
  target: Pick<DeliveryTarget, "channelId" | "recipientId">,
  lookupOwner: ChannelOwnerLookup,
): Promise<boolean> {
  // The push adapter always delivers to job.userId, whatever the recipient says.
  if (target.channelId === "push") return true;

  const binding = job.delivery?.channelBinding;
  if (binding && binding.channelId === target.channelId && binding.chatId === target.recipientId) {
    return true;
  }
  return (await lookupOwner(target.channelId, target.recipientId)) === job.userId;
}

/**
 * Record the chat a job was created from when it delivers back there. Only
 * call with server-derived channel context (never tool or API arguments).
 */
export function withChannelBinding<T extends Partial<CronDelivery> | undefined>(
  delivery: T,
  context: { channelName?: string; channelChatId?: string },
): T {
  if (!delivery || !context.channelName || !context.channelChatId) return delivery;
  if (delivery.channelId !== context.channelName || delivery.recipientId !== context.channelChatId) {
    return delivery;
  }
  return {
    ...delivery,
    channelBinding: { channelId: context.channelName, chatId: context.channelChatId },
  };
}

/** Drop server-only fields from a delivery object supplied by a client. */
export function stripServerOnlyDeliveryFields<T>(delivery: T): T {
  if (!delivery || typeof delivery !== "object") return delivery;
  const { channelBinding: _ignored, ...rest } = delivery as Record<string, unknown>;
  return rest as T;
}
