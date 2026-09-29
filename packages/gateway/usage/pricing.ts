/**
 * AgentForEach Usage Module — Pricing
 *
 * Model pricing defaults and cost estimation.
 *
 * Built-in pricing for common OpenAI and Anthropic models.
 * Users can override via agentforeach.json "usage.pricing" section.
 *
 * Cost calculation accounts for:
 *   - Regular input tokens vs cached input tokens (cheaper)
 *   - Regular output tokens vs reasoning tokens (may differ)
 */

import type { UsageStats } from "../llms/index.js";
import type { ModelPricing } from "./types.js";
import type { UsageConfig } from "./config.js";

// ============================================================================
// Default Model Pricing (USD per 1M tokens)
// ============================================================================

/**
 * Built-in pricing for known models.
 * Users can override individual models in agentforeach.json "usage.pricing".
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-5-mini": { inputPer1M: 0.30, outputPer1M: 1.20, cachedInputPer1M: 0.15 },
  "gpt-5.6-luna": { inputPer1M: 0.20, outputPer1M: 1.20, cachedInputPer1M: 0.02 },
  "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.50, cachedInputPer1M: 0.075 },
  "gpt-5.4-mini-1": { inputPer1M: 0.75, outputPer1M: 4.50, cachedInputPer1M: 0.075 },
  "gpt-5.2": { inputPer1M: 2.00, outputPer1M: 8.00, cachedInputPer1M: 1.00 },
  "gpt-4o": { inputPer1M: 2.50, outputPer1M: 10.00, cachedInputPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.60, cachedInputPer1M: 0.075 },
  "o3-mini": {
    inputPer1M: 1.10,
    outputPer1M: 4.40,
    cachedInputPer1M: 0.55,
    reasoningPer1M: 4.40,
  },

  // Anthropic
  "claude-sonnet-4-20250514": {
    inputPer1M: 3.00,
    outputPer1M: 15.00,
    cachedInputPer1M: 0.30,
  },
  "claude-haiku-4-5-20251001": {
    inputPer1M: 0.80,
    outputPer1M: 4.00,
    cachedInputPer1M: 0.08,
  },
};

/** Fallback pricing when a model is not found in the pricing map. */
export const DEFAULT_FALLBACK_PRICING: ModelPricing = {
  inputPer1M: 1.00,
  outputPer1M: 4.00,
};

// ============================================================================
// Pricing Resolution
// ============================================================================

/**
 * Resolve pricing for a model. Tries exact match in config.pricing,
 * then falls back to config.fallbackPricing.
 */
export function getModelPricing(model: string, config: UsageConfig): ModelPricing {
  const exact = config.pricing[model];
  if (exact) return exact;
  // Model ids are case-insensitive to providers; don't bill "GPT-5.2" at fallback rates.
  const lower = model.toLowerCase();
  const match = Object.keys(config.pricing).find((k) => k.toLowerCase() === lower);
  return match ? config.pricing[match]! : config.fallbackPricing;
}

// ============================================================================
// Cost Estimation
// ============================================================================

/**
 * Estimate the cost of a usage stats object based on model pricing.
 *
 * Input tokens include cached tokens as a subset:
 *   nonCachedInput = inputTokens - cachedInputTokens
 *
 * Output tokens include reasoning tokens as a subset:
 *   nonReasoningOutput = outputTokens - reasoningTokens
 *
 * Each subset is priced at its own rate.
 * Result is rounded to 6 decimal places (micro-dollar precision).
 */
export function estimateCost(usage: UsageStats, pricing: ModelPricing): number {
  const cached = usage.cachedInputTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;

  const nonCachedInput = Math.max(0, usage.inputTokens - cached);
  const nonReasoningOutput = Math.max(0, usage.outputTokens - reasoning);

  const cachedRate = pricing.cachedInputPer1M ?? pricing.inputPer1M * 0.5;
  const reasoningRate = pricing.reasoningPer1M ?? pricing.outputPer1M;

  const cost =
    (nonCachedInput * pricing.inputPer1M) / 1_000_000 +
    (cached * cachedRate) / 1_000_000 +
    (nonReasoningOutput * pricing.outputPer1M) / 1_000_000 +
    (reasoning * reasoningRate) / 1_000_000;

  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimal places
}
