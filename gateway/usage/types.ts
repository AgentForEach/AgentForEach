/**
 * AgentForEach Usage Module — Types
 *
 * Core type definitions for usage tracking and cost analytics.
 *
 * One container:
 *   "usage-records" — per-run usage records, partition key: /userId
 *
 * Each LLM run produces one UsageRecord with aggregate token counts
 * and estimated cost based on model pricing.
 */

import type { ProviderId, UsageStats } from "../llms/index.js";

// ============================================================================
// Usage Record (stored document)
// ============================================================================

/**
 * A single usage record stored in the usage-records container.
 *
 * Container: "usage-records"
 * Partition key: /userId
 * Document ID: `{userId}:{runId}`
 */
export interface UsageRecord {
  /** Document ID: `{userId}:{runId}`. */
  id: string;

  /** Owner user. Partition key. */
  userId: string;

  /** Session this run belongs to. */
  sessionId: string;

  /** Agent that handled this run. */
  agentId: string;

  /** Unique run identifier (from runner). */
  runId: string;

  /** LLM provider used. */
  providerId: ProviderId;

  /** Model used. */
  model: string;

  /** Index signature for storage `Doc` compatibility. */
  [key: string]: unknown;

  // -- Token counts (mirrors UsageStats) --

  /** Total input tokens consumed. */
  inputTokens: number;

  /** Total output tokens produced. */
  outputTokens: number;

  /** Total tokens (input + output). */
  totalTokens: number;

  /** Cached input tokens (subset of inputTokens). */
  cachedInputTokens?: number;

  /** Reasoning tokens (subset of outputTokens, o-series models). */
  reasoningTokens?: number;

  // -- Cost --

  /** Estimated cost in USD based on model pricing. */
  estimatedCostUsd: number;

  // -- Credits --

  /** Actual credit amount deducted for this run. */
  coinsCharged?: number;

  /** Currency code for the deducted coins (for example, "CRD"). */
  coinCurrencyCode?: string;

  /** Whether the post-run credit deduction was applied or skipped. */
  coinChargeStatus?: "deducted" | "skipped";

  /** Reason a credit deduction was skipped. */
  coinChargeFailureReason?: string;

  /** Balance returned by the credit provider after deduction. */
  coinBalanceAfter?: number;

  /** Cost multiplier used to compute coins when the run was charged. */
  coinCostMultiplier?: number;

  /** Minimum charge configured when the run was charged. */
  coinMinimumCharge?: number;

  /** ISO-8601 timestamp when the credit charge was recorded. */
  coinChargedAt?: string;

  // -- Metadata --

  /** ISO-8601 timestamp of the run. */
  timestamp: string;

  /** Duration of the run in milliseconds. */
  durationMs: number;

  /** Channel the request originated from (e.g., "telegram"). */
  channelName?: string;
}

// ============================================================================
// Model Pricing
// ============================================================================

/** Pricing rates for a specific model (USD per 1M tokens). */
export interface ModelPricing {
  /** Cost per 1M input tokens. */
  inputPer1M: number;

  /** Cost per 1M output tokens. */
  outputPer1M: number;

  /** Cost per 1M cached input tokens. Defaults to inputPer1M * 0.5. */
  cachedInputPer1M?: number;

  /** Cost per 1M reasoning output tokens. Defaults to outputPer1M. */
  reasoningPer1M?: number;
}

// ============================================================================
// Usage Summary (aggregated response)
// ============================================================================

/** Aggregated usage summary returned by the API. */
export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  requestCount: number;
  period: { from: string; to: string };
  breakdown: UsageBreakdownEntry[];
  /** Per-channel breakdown. Present when records have channelName. */
  channelBreakdown?: UsageChannelBreakdownEntry[];
}

/** Per-provider/model breakdown entry within a UsageSummary. */
export interface UsageBreakdownEntry {
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

/** Per-channel breakdown entry within a UsageSummary. */
export interface UsageChannelBreakdownEntry {
  channelName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
}

// ============================================================================
// Usage Config (agentforeach.json "usage" section shape)
// ============================================================================

/**
 * Configuration shape as stored in agentforeach.json "usage" section.
 *
 * Model pricing is configured here so users can override built-in
 * defaults as model prices change.
 */
export interface UsageJsonConfig {
  /** Enable usage tracking. Default: true. */
  enabled?: boolean;

  /** Cosmos container name. Default: "usage-records". */
  containerId?: string;

  /** TTL for usage records in seconds. Default: 7776000 (90 days). */
  ttlSeconds?: number;

  /** Per-model pricing overrides (USD per 1M tokens). */
  pricing?: Record<string, ModelPricing>;

  /** Fallback pricing for unknown models. */
  fallbackPricing?: ModelPricing;
}
