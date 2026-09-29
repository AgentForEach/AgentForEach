/**
 * AgentForEach — per-user message rate limit
 *
 * Fixed-window counters in Cosmos (one doc per user per window, removed by
 * TTL), incremented with an atomic patch, so every instance sees the same
 * count. Checked once per inbound message, before any credit reservation or
 * LLM call. Scheduled runs (cron jobs, heartbeats) don't count against the
 * message limit; they have their own (`rateLimit.scheduled`), checked by the
 * cron executor, and force-runs a tighter one (`rateLimit.forceRun`).
 *
 * Fails open: if the counter store is down, messages go through (logged) —
 * a rate limiter outage shouldn't take chat down with it.
 */

import { PartitionKeyKind } from "@azure/cosmos";
import { getSharedDatabase, type ContainerHandle, type DatabaseProvider } from "../database/index.js";
import { loadConfigSection } from "../utils/index.js";
import { redactId } from "../utils/redact.js";

export type RateLimitConfig = {
  enabled: boolean;
  /** Messages per user per minute. 0 = no limit. */
  perMinute: number;
  /** Messages per user per day (UTC). 0 = no limit. */
  perDay: number;
  /** Channel names that are never limited. */
  exemptChannels: string[];
  containerId: string;
  /** Counter namespace, so limits for different actions don't share counts. */
  scope?: string;
};

const DEFAULTS: RateLimitConfig = {
  enabled: true,
  perMinute: 20,
  perDay: 1000,
  exemptChannels: ["cron", "heartbeat"],
  containerId: "rate-limits",
};

export function loadRateLimitConfig(): RateLimitConfig {
  const json = loadConfigSection<Partial<RateLimitConfig>>("rateLimit") ?? {};
  return { ...DEFAULTS, ...json };
}

/** A limit for one kind of action, in its own counter namespace. */
export type ScopedLimit = { perMinute: number; perDay: number };

const SCOPED_DEFAULTS: Record<"scheduled" | "forceRun", ScopedLimit> = {
  // Every model run a user's jobs and heartbeats cause.
  scheduled: { perMinute: 6, perDay: 300 },
  // POST /cron/jobs/{id}/run.
  forceRun: { perMinute: 2, perDay: 30 },
};

/** Limiter config for `rateLimit.scheduled` or `rateLimit.forceRun`. */
export function scopedRateLimitConfig(kind: "scheduled" | "forceRun"): RateLimitConfig {
  const base = loadRateLimitConfig();
  const json = (base as unknown as Record<string, Partial<ScopedLimit> | undefined>)[kind] ?? {};
  return {
    enabled: base.enabled,
    perMinute: json.perMinute ?? SCOPED_DEFAULTS[kind].perMinute,
    perDay: json.perDay ?? SCOPED_DEFAULTS[kind].perDay,
    exemptChannels: [],
    containerId: base.containerId,
    scope: kind === "scheduled" ? "sched" : "force",
  };
}

const scopedShared = new Map<string, RateLimiter>();

/** The process-wide limiter for scheduled runs or force-runs. */
export function getScopedRateLimiter(kind: "scheduled" | "forceRun"): RateLimiter {
  let limiter = scopedShared.get(kind);
  if (!limiter) scopedShared.set(kind, (limiter = new RateLimiter(getSharedDatabase(), scopedRateLimitConfig(kind))));
  return limiter;
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; window: "minute" | "day" };

type CounterDoc = { id: string; count: number; ttl: number };

export class RateLimiter {
  private container?: ContainerHandle<CounterDoc>;

  constructor(
    private readonly db: DatabaseProvider,
    private readonly config: RateLimitConfig = loadRateLimitConfig(),
  ) {}

  async initialize(): Promise<void> {
    if (this.container) return;
    this.container = await this.db.getOrCreateContainer<CounterDoc>({
      id: this.config.containerId,
      partitionKey: { paths: ["/id"], kind: PartitionKeyKind.Hash, version: 2 },
      defaultTtl: -1,
    });
  }

  /** Count one message for `userId` and say whether it may proceed. */
  async check(userId: string, channelName?: string, nowMs = Date.now()): Promise<RateLimitDecision> {
    const { enabled, perMinute, perDay, exemptChannels } = this.config;
    if (!enabled || (channelName && exemptChannels.includes(channelName))) return { allowed: true };
    try {
      await this.initialize();
      const minute = Math.floor(nowMs / 60_000);
      const day = Math.floor(nowMs / 86_400_000);
      const key = this.config.scope ? `${this.config.scope}:${userId}` : userId;
      const [minuteCount, dayCount] = await Promise.all([
        perMinute > 0 ? this.increment(`${key}:m:${minute}`, 120) : 0,
        perDay > 0 ? this.increment(`${key}:d:${day}`, 2 * 86_400) : 0,
      ]);
      const refused: RateLimitDecision | undefined =
        perMinute > 0 && minuteCount > perMinute
          ? { allowed: false, window: "minute", retryAfterSeconds: 60 - Math.floor((nowMs % 60_000) / 1000) }
          : perDay > 0 && dayCount > perDay
            ? { allowed: false, window: "day", retryAfterSeconds: Math.ceil((86_400_000 - (nowMs % 86_400_000)) / 1000) }
            : undefined;
      if (refused) {
        // The "rate-limited" alert counts these lines.
        console.warn(`[ratelimit] refused user=${redactId(userId)} window=${refused.window}`);
        return refused;
      }
      return { allowed: true };
    } catch (err) {
      console.warn(
        `[ratelimit] counter unavailable, allowing user=${redactId(userId)}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { allowed: true };
    }
  }

  /** Atomic increment; creates the window's doc on first use. */
  private async increment(id: string, ttl: number): Promise<number> {
    const container = this.container!;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await container.patch(id, id, [{ op: "incr", path: "/count", value: 1 }]);
        return doc.count;
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }
      try {
        await container.create({ id, count: 1, ttl });
        return 1;
      } catch (err) {
        if (statusOf(err) !== 409) throw err; // another instance created it: patch again
      }
    }
    throw new Error("rate limit counter contention");
  }
}

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: unknown; statusCode?: unknown };
  const v = e?.statusCode ?? e?.code;
  return typeof v === "number" ? v : undefined;
}

/** The user-facing text for a refused message. */
export function rateLimitMessage(decision: Extract<RateLimitDecision, { allowed: false }>): string {
  return decision.window === "minute"
    ? `You're sending messages faster than I can keep up with. Try again in ${decision.retryAfterSeconds} seconds.`
    : "You've reached today's message limit. It resets at midnight UTC.";
}

let shared: RateLimiter | undefined;

/** The process-wide limiter (shared database), for the HTTP handlers. */
export function getSharedRateLimiter(): RateLimiter {
  return (shared ??= new RateLimiter(getSharedDatabase()));
}
