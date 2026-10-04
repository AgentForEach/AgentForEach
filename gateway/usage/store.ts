/**
 * AgentForEach Usage Module — Usage Store
 *
 * Per-run usage tracking and cost analytics.
 *
 * Container: "usage-records" (configurable via agentforeach.json)
 *   - Partition key: /userId
 *   - Default TTL: 90 days
 *   - Document ID: `{userId}:{runId}`
 *
 * Each LLM run produces one UsageRecord with aggregate token counts
 * and estimated cost. Records are created fire-and-forget by the runner.
 *
 * Query capabilities:
 *   - Per-user record listing (with date filtering and limit)
 *   - Per-user aggregated summary (with date filtering)
 */

import {
  and,
  eq,
  gte,
  lte,
  type Collection,
  type CollectionSpec,
  type Filter,
  type PatchOperation,
  type StorageAdapter,
} from "@agentforeach/storage";
import type { ProviderId, UsageStats } from "../llms/index.js";
import type {
  UsageRecord,
  UsageSummary,
  UsageBreakdownEntry,
  UsageChannelBreakdownEntry,
} from "./types.js";
import { loadUsageConfig, type UsageConfig } from "./config.js";
import { getModelPricing, estimateCost } from "./pricing.js";

// ============================================================================
// Usage Store
// ============================================================================

/** A user's records, optionally bounded by ISO timestamps. */
function recordsInRange(userId: string, opts?: { from?: string; to?: string }): Filter {
  return and(eq("userId", userId), opts?.from && gte("timestamp", opts.from), opts?.to && lte("timestamp", opts.to));
}

/** The usage-records collection, with the configured id and retention. */
export function usageCollection(config: UsageConfig): CollectionSpec {
  return { name: config.containerId, partitionKey: "userId", defaultTtl: config.ttlSeconds };
}

export class UsageStore {
  private storage: StorageAdapter;
  private container!: Collection<UsageRecord>;
  private initialized = false;
  private config: UsageConfig;

  constructor(storage: StorageAdapter, config?: UsageConfig) {
    this.storage = storage;
    this.config = config ?? loadUsageConfig();
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.container = await this.storage.collection<UsageRecord>(usageCollection(this.config));

    this.initialized = true;
  }

  // --------------------------------------------------------------------------
  // Write
  // --------------------------------------------------------------------------

  /**
   * Record a usage entry. No-ops if usage tracking is disabled.
   *
   * Called fire-and-forget from the runner after each LLM run.
   * The cost is estimated from the model pricing at write time.
   */
  async record(params: {
    userId: string;
    sessionId: string;
    agentId: string;
    runId: string;
    providerId: ProviderId;
    model: string;
    usage: UsageStats;
    durationMs: number;
    timestamp: string;
    channelName?: string;
  }): Promise<UsageRecord | null> {
    if (!this.config.enabled) return null;
    this.ensureInitialized();

    const pricing = getModelPricing(params.model, this.config);
    const cost = estimateCost(params.usage, pricing);

    const doc: UsageRecord = {
      id: `${params.userId}:${params.runId}`,
      userId: params.userId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      runId: params.runId,
      providerId: params.providerId,
      model: params.model,
      inputTokens: params.usage.inputTokens,
      outputTokens: params.usage.outputTokens,
      totalTokens: params.usage.totalTokens,
      cachedInputTokens: params.usage.cachedInputTokens,
      reasoningTokens: params.usage.reasoningTokens,
      estimatedCostUsd: cost,
      timestamp: params.timestamp,
      durationMs: params.durationMs,
      channelName: params.channelName,
    };

    return this.container.create(doc);
  }

  /**
   * Attach the post-run coin charge outcome to an existing usage record.
   * This keeps token/cost records reconcilable with the external credits ledger.
   */
  async recordCreditCharge(params: {
    userId: string;
    runId: string;
    coinsCharged: number;
    currencyCode: string;
    status: "deducted" | "skipped";
    balanceAfter?: number | null;
    failureReason?: string;
    costMultiplier: number;
    minimumCharge: number;
    chargedAt?: string;
  }): Promise<UsageRecord | null> {
    if (!this.config.enabled) return null;
    this.ensureInitialized();

    const operations: PatchOperation[] = [
      { op: "set" as const, path: "/coinsCharged", value: params.coinsCharged },
      { op: "set" as const, path: "/coinCurrencyCode", value: params.currencyCode },
      { op: "set" as const, path: "/coinChargeStatus", value: params.status },
      { op: "set" as const, path: "/coinCostMultiplier", value: params.costMultiplier },
      { op: "set" as const, path: "/coinMinimumCharge", value: params.minimumCharge },
      { op: "set" as const, path: "/coinChargedAt", value: params.chargedAt ?? new Date().toISOString() },
    ];

    if (params.balanceAfter !== undefined && params.balanceAfter !== null) {
      operations.push({
        op: "set" as const,
        path: "/coinBalanceAfter",
        value: params.balanceAfter,
      });
    }

    if (params.failureReason) {
      operations.push({
        op: "set" as const,
        path: "/coinChargeFailureReason",
        value: params.failureReason,
      });
    }

    return this.container.patch(
      `${params.userId}:${params.runId}`,
      params.userId,
      operations,
    );
  }

  // --------------------------------------------------------------------------
  // Read
  // --------------------------------------------------------------------------

  /**
   * Get usage records for a user, ordered by timestamp DESC.
   *
   * Supports date range filtering via ISO-8601 `from` and `to` strings
   * and a `limit` (default 50, max 200).
   */
  async getRecords(
    userId: string,
    opts?: {
      from?: string;
      to?: string;
      limit?: number;
    },
  ): Promise<UsageRecord[]> {
    this.ensureInitialized();

    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    return this.container.find<UsageRecord>({
      partitionKey: userId,
      where: recordsInRange(userId, opts),
      orderBy: { field: "timestamp", direction: "desc" },
      limit,
    });
  }

  /**
   * Get an aggregated usage summary for a user.
   *
   * Loads all records in the date range and aggregates in-memory.
   * For a personal assistant the record volume per-user is moderate,
   * so in-memory aggregation is simpler and more flexible than
   * Cosmos GROUP BY queries.
   */
  async getSummary(
    userId: string,
    opts?: {
      from?: string;
      to?: string;
    },
  ): Promise<UsageSummary> {
    this.ensureInitialized();

    const records = await this.container.find<UsageRecord>({
      partitionKey: userId,
      where: recordsInRange(userId, opts),
      orderBy: { field: "timestamp", direction: "desc" },
    });

    const now = new Date().toISOString();
    return aggregateRecords(records, {
      from:
        opts?.from ??
        (records.length > 0 ? records[records.length - 1].timestamp : now),
      to: opts?.to ?? (records.length > 0 ? records[0].timestamp : now),
    });
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  /** Get the resolved usage config. */
  getConfig(): UsageConfig {
    return this.config;
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("UsageStore: not initialized. Call initialize() first.");
    }
  }
}

// ============================================================================
// Aggregation (pure function)
// ============================================================================

/**
 * Aggregate an array of UsageRecords into a UsageSummary.
 *
 * Pure function — no DB access, easy to test.
 * Breakdown is sorted by cost descending (highest cost first).
 */
export function aggregateRecords(
  records: UsageRecord[],
  period: { from: string; to: string },
): UsageSummary {
  const byKey = new Map<string, UsageBreakdownEntry>();
  const byChannel = new Map<string, UsageChannelBreakdownEntry>();

  let totalInput = 0;
  let totalOutput = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const r of records) {
    totalInput += r.inputTokens;
    totalOutput += r.outputTokens;
    totalTokens += r.totalTokens;
    totalCost += r.estimatedCostUsd;

    const key = `${r.providerId}:${r.model}`;
    const entry = byKey.get(key) ?? {
      providerId: r.providerId,
      model: r.model,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      requestCount: 0,
    };
    entry.inputTokens += r.inputTokens;
    entry.outputTokens += r.outputTokens;
    entry.totalTokens += r.totalTokens;
    entry.costUsd += r.estimatedCostUsd;
    entry.requestCount += 1;
    byKey.set(key, entry);

    // Per-channel aggregation
    if (r.channelName) {
      const channelEntry = byChannel.get(r.channelName) ?? {
        channelName: r.channelName,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        requestCount: 0,
      };
      channelEntry.inputTokens += r.inputTokens;
      channelEntry.outputTokens += r.outputTokens;
      channelEntry.totalTokens += r.totalTokens;
      channelEntry.costUsd += r.estimatedCostUsd;
      channelEntry.requestCount += 1;
      byChannel.set(r.channelName, channelEntry);
    }
  }

  const breakdown = [...byKey.values()].map((entry) => ({
    ...entry,
    costUsd: Math.round(entry.costUsd * 1_000_000) / 1_000_000,
  }));

  const channelBreakdown = byChannel.size > 0
    ? [...byChannel.values()]
        .map((e) => ({ ...e, costUsd: Math.round(e.costUsd * 1_000_000) / 1_000_000 }))
        .sort((a, b) => b.costUsd - a.costUsd)
    : undefined;

  return {
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalTokens,
    totalCostUsd: Math.round(totalCost * 1_000_000) / 1_000_000,
    requestCount: records.length,
    period,
    breakdown: breakdown.sort((a, b) => b.costUsd - a.costUsd),
    channelBreakdown,
  };
}
