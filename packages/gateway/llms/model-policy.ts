/**
 * AgentForEach LLM Layer — which models a client may request
 *
 * Clients can name a model per request. Unchecked, that lets any user pick
 * the most expensive model, billed at fallback rates when it has no price.
 */

import { loadUsageConfig } from "../usage/config.js";
import { loadLlmConfig, matchesModelPattern, resolveProviderConfig } from "./config.js";

/**
 * Whether `model` may be requested for `providerId`. It must be priced (so
 * usage is billed correctly) or be the provider's default model, and, when
 * the provider sets `allowedModels`, also match one of those patterns.
 */
export function isModelAllowed(providerId: string, model: string): boolean {
  const patterns = loadLlmConfig().providers?.[providerId]?.allowedModels;
  if (patterns && patterns.length > 0 && !patterns.some((p) => matchesModelPattern(model, p))) {
    return false;
  }
  if (resolveProviderConfig(providerId)?.defaultModel?.toLowerCase() === model.toLowerCase()) return true;
  const priced = Object.keys(loadUsageConfig().pricing).map((m) => m.toLowerCase());
  return priced.includes(model.toLowerCase());
}
