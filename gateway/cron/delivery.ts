/**
 * AgentForEach Cron System — Delivery Adapter Interface
 *
 * This is the abstraction boundary between the cron system and
 * channel-specific delivery implementations.
 *
 * Architecture:
 *   - Cron system defines the interface (this file)
 *   - Channel plugins register concrete adapters
 *   - Executor dispatches through the registry at runtime
 *   - Cron system never imports any channel-specific code
 *
 * To add a new delivery channel:
 *   1. Implement DeliveryAdapter for your channel
 *   2. Call registerDeliveryAdapter("your-channel", adapter)
 *   3. Users can now set delivery.mode = "channel", delivery.channelId = "your-channel"
 *
 */

import type { CronJob, DeliveryTarget, JobResult, ChannelId } from "./types.js";
import { isRecipientOwned } from "./recipient-policy.js";
import { describeText, redactId } from "../utils/redact.js";

// ============================================================================
// Delivery Adapter Interface
// ============================================================================

/**
 * Payload passed to a delivery adapter when delivering a cron job result.
 */
export type DeliveryPayload = {
  /** The job that was executed. */
  job: CronJob;
  /** The execution result. */
  result: JobResult;
  /** The resolved delivery target. */
  target: DeliveryTarget;
  /** The text content to deliver (result.summary or full output). */
  text: string;
};

/**
 * Result returned by a delivery adapter after attempting delivery.
 */
export type DeliveryResult = {
  /** Whether delivery succeeded. */
  success: boolean;
  /** Error message if delivery failed. */
  error?: string;
  /** Optional adapter-specific metadata (message ID, etc.). */
  metadata?: Record<string, unknown>;
};

/**
 * Interface that channel-specific delivery plugins must implement.
 *
 * Each channel (Telegram, WhatsApp, push notifications, email, etc.)
 * provides a concrete adapter. The cron executor dispatches to the
 * registered adapter based on the job's delivery.channelId.
 *
 * @example
 * ```typescript
 * // In a future telegram-delivery plugin:
 * import { registerDeliveryAdapter, type DeliveryAdapter } from "../cron/delivery.js";
 *
 * const telegramAdapter: DeliveryAdapter = {
 *   channelId: "telegram",
 *   displayName: "Telegram",
 *
 *   async deliver(payload) {
 *     const { target, text } = payload;
 *     await telegramBot.sendMessage(target.recipientId, text);
 *     return { success: true };
 *   },
 *
 *   async resolveTarget(job) {
 *     // Look up user's Telegram chat ID from profile
 *     const chatId = await getUserTelegramChatId(job.userId);
 *     if (!chatId) return undefined;
 *     return { channelId: "telegram", recipientId: chatId, resolution: "from-profile" };
 *   },
 * };
 *
 * registerDeliveryAdapter(telegramAdapter);
 * ```
 */
export interface DeliveryAdapter {
  /** The channel this adapter handles. */
  readonly channelId: ChannelId;

  /** Human-readable display name. */
  readonly displayName: string;

  /**
   * Deliver a cron job result to the target recipient.
   *
   * @param payload - The delivery payload (job, result, resolved target, text).
   * @returns Delivery result indicating success/failure.
   */
  deliver(payload: DeliveryPayload): Promise<DeliveryResult>;

  /**
   * Resolve the delivery target for a job when the job's delivery config
   * doesn't specify an explicit recipientId.
   *
   * This is called when:
   *   - delivery.recipientId is missing
   *   - delivery.channelId is "last" (resolve to last-used channel)
   *
   * The adapter should look up the user's profile, session history, or
   * channel-specific configuration to determine where to send.
   *
   * @param job - The job being executed.
   * @returns Resolved target, or undefined if the adapter can't resolve.
   */
  resolveTarget?(job: CronJob): Promise<DeliveryTarget | undefined>;
}

// ============================================================================
// Delivery Target Resolver
// ============================================================================

/**
 * A pluggable function that resolves the "last" channel for a user.
 *
 * Checks the session store for the user's last-active channel. Register
 * this when you have a session/profile system.
 */
export type LastChannelResolver = (
  userId: string,
) => Promise<DeliveryTarget | undefined>;

let _lastChannelResolver: LastChannelResolver | undefined;

/**
 * Register a function that resolves the user's last-active channel.
 * Used when delivery.channelId is "last".
 */
export function setLastChannelResolver(resolver: LastChannelResolver): void {
  _lastChannelResolver = resolver;
}

export function getLastChannelResolver(): LastChannelResolver | undefined {
  return _lastChannelResolver;
}

// ============================================================================
// Adapter Registry
// ============================================================================

const _adapters = new Map<string, DeliveryAdapter>();

/**
 * Register a delivery adapter for a channel.
 *
 * Call this at startup from your channel plugin initialization code.
 * After registration, cron jobs with delivery.channelId matching this
 * adapter's channelId will be dispatched to it.
 */
export function registerDeliveryAdapter(adapter: DeliveryAdapter): void {
  _adapters.set(adapter.channelId, adapter);
}

/**
 * Get the delivery adapter for a channel, if registered.
 */
export function getDeliveryAdapter(
  channelId: string,
): DeliveryAdapter | undefined {
  return _adapters.get(channelId);
}

/**
 * Get all registered delivery adapters.
 */
export function getRegisteredAdapters(): ReadonlyMap<string, DeliveryAdapter> {
  return _adapters;
}

/**
 * Check if any delivery adapters are registered.
 */
export function hasDeliveryAdapters(): boolean {
  return _adapters.size > 0;
}

// ============================================================================
// Delivery Dispatcher
// ============================================================================

/** Owner of a channel account via the identity store (dynamic import: channels import cron). */
async function lookupChannelOwner(channelId: string, channelUserId: string): Promise<string | null> {
  const { ensureIdentityStore, getIdentityStore } = await import("../channels/index.js");
  await ensureIdentityStore();
  const store = getIdentityStore();
  if (!store) return null;
  try {
    return (await store.resolveByChannel(channelId, channelUserId))?.userId ?? null;
  } catch {
    return null; // conflicting links: don't deliver
  }
}

type ResolvedDelivery =
  | { ok: true; adapter: DeliveryAdapter; target: DeliveryTarget }
  | {
      ok: false;
      error: string;
      /** The recipient isn't the owner's: retrying can never succeed. */
      refused?: boolean;
    };

/**
 * Resolve where a job's result would go, and check the recipient belongs to
 * the job's owner (recipient-policy.ts). Shared by delivery and by the
 * executor's pre-flight check, so a job that can never deliver is caught
 * before it spends an LLM call.
 */
export async function resolveDelivery(job: CronJob): Promise<ResolvedDelivery> {
  const delivery = job.delivery;
  // "announce" is shorthand for in-app push delivery.
  const channelId =
    delivery?.mode === "announce" && !delivery.channelId ? "push" : delivery?.channelId;

  if (!channelId || channelId === "last") {
    return {
      ok: false,
      error:
        "Cannot resolve delivery channel: explicit channelId is required for delivery. The 'last' heuristic is no longer supported.",
    };
  }

  const adapter = getDeliveryAdapter(channelId);
  if (!adapter) {
    console.warn(
      `[cron-delivery] No adapter registered for channel "${channelId}". ` +
        `Registered adapters: [${[...getRegisteredAdapters().keys()].join(", ")}]`,
    );
    return { ok: false, error: `No delivery adapter registered for channel "${channelId}"` };
  }

  const target: DeliveryTarget | undefined = delivery?.recipientId
    ? {
        channelId,
        recipientId: delivery.recipientId,
        threadId: delivery.threadId,
        accountId: delivery.accountId,
        resolution: "explicit",
      }
    : await adapter.resolveTarget?.(job);

  if (!target) {
    console.warn(
      `[cron-delivery] Cannot resolve target for channel="${channelId}", job=${job.id}. ` +
        `recipientId=${redactId(delivery?.recipientId)}, adapter.resolveTarget=${adapter.resolveTarget ? "yes" : "no"}`,
    );
    return {
      ok: false,
      error: `Cannot resolve delivery target for channel "${channelId}". Explicit recipientId is required.`,
    };
  }

  if (!(await isRecipientOwned(job, target, lookupChannelOwner))) {
    console.warn(
      `[cron-delivery] Refused: recipient on "${target.channelId}" is not linked to the job's owner (job=${job.id})`,
    );
    return {
      ok: false,
      refused: true,
      error:
        `Delivery refused: the ${target.channelId} recipient isn't linked to this user. ` +
        "Link the account by pairing, or create the job from that chat.",
    };
  }

  return { ok: true, adapter, target };
}

/**
 * Deliver a cron job result through the appropriate channel.
 *
 * Resolution (see resolveDelivery): explicit channelId (no "last"), the
 * adapter for it, an explicit recipient or the adapter's resolveTarget, and
 * the recipient-ownership check; then adapter.deliver().
 *
 * @returns DeliveryResult, or undefined if no channel delivery was requested.
 */
export async function deliverToChannel(
  job: CronJob,
  result: JobResult,
): Promise<DeliveryResult | undefined> {
  const delivery = job.delivery;
  if (!delivery || (delivery.mode !== "channel" && delivery.mode !== "announce")) {
    console.log(
      `[cron-delivery] deliverToChannel skipped: job=${job.id}, mode=${delivery?.mode ?? "undefined"}`,
    );
    return undefined;
  }

  const text = result.summary ?? "(no output)";
  console.log(
    `[cron-delivery] deliverToChannel: job=${job.id} (${job.name}), mode=${delivery.mode}, ` +
      `channelId=${delivery.channelId ?? "none"}, recipientId=${redactId(delivery.recipientId)}, ` +
      `text=${describeText(text)}`,
  );

  const resolved = await resolveDelivery(job);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const { adapter, target } = resolved;
  console.log(
    `[cron-delivery] Resolved target: channelId=${target.channelId}, ` +
      `recipientId=${redactId(target.recipientId)}, resolution=${target.resolution ?? "unknown"}`,
  );

  // 4. Deliver
  try {
    const deliveryResult = await adapter.deliver({ job, result, target, text });
    console.log(
      `[cron-delivery] Delivery result: success=${deliveryResult.success}` +
        (deliveryResult.error ? `, error=${deliveryResult.error}` : ""),
    );
    return deliveryResult;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[cron-delivery] Delivery threw: ${errorMsg}`);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

// ============================================================================
// Framework-Level Target Resolution (Removed)
// ============================================================================
// resolveTargetFromSessionMetadata was removed to enforce explicit targeting.

