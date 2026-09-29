/**
 * AgentForEach Usage Module — Public API
 *
 * Barrel export for the usage tracking and cost analytics module.
 * All AgentForEach subsystems should import from here.
 *
 * Core types:
 *   - `UsageRecord`          — per-run usage document
 *   - `ModelPricing`         — per-model price rates
 *   - `UsageSummary`         — aggregated usage response
 *   - `UsageBreakdownEntry`  — per-provider/model breakdown
 *
 * Store:
 *   - `UsageStore`           — Cosmos DB-backed usage tracking
 *   - `aggregateRecords()`   — pure aggregation helper
 *
 * Pricing:
 *   - `estimateCost()`       — estimate cost from usage + pricing
 *   - `getModelPricing()`    — resolve pricing for a model
 *
 * Config:
 *   - `loadUsageConfig()`    — load from agentforeach.json "usage" section
 */

// -- Types -------------------------------------------------------------------
export type {
  UsageRecord,
  ModelPricing,
  UsageSummary,
  UsageBreakdownEntry,
  UsageChannelBreakdownEntry,
  UsageJsonConfig,
} from "./types.js";

// -- Config ------------------------------------------------------------------
export {
  loadUsageConfig,
  resetUsageConfigCache,
  isUsageEnabled,
  resolveUsageContainerId,
  resolveUsageTtlSeconds,
  DEFAULT_USAGE_CONTAINER_ID,
  DEFAULT_USAGE_TTL_SECONDS,
  DEFAULT_USAGE_ENABLED,
  type UsageConfig,
} from "./config.js";

// -- Pricing -----------------------------------------------------------------
export {
  DEFAULT_MODEL_PRICING,
  DEFAULT_FALLBACK_PRICING,
  getModelPricing,
  estimateCost,
} from "./pricing.js";

// -- Store -------------------------------------------------------------------
export { UsageStore, aggregateRecords } from "./store.js";
