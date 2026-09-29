/**
 * AgentForEach LLM Layer — Configuration
 *
 * Loads LLM provider configuration from agentforeach.json ("llms" section).
 * Allows switching providers, models, and API keys via config instead
 * of environment variables.
 *
 * Env vars still work as overrides — config is the base, env vars win.
 */

import { loadConfigSection, resolveEnvValue } from "../utils/index.js";
import type {
  OpenAIResponsesConfig,
  ProviderId,
} from "./types.js";
import { DEFAULT_FAILOVER_CONFIG, type FailoverConfig } from "./failover.js";

// ============================================================================
// LLM Config Types
// ============================================================================

/**
 * Per-provider configuration in agentforeach.json.
 *
 * Each key in "providers" is a ProviderId (e.g. "openai", "anthropic").
 */
export interface LlmProviderEntry {
  /** Whether this provider is available. Defaults to true. */
  enabled?: boolean;
  /**
   * API key for the provider.
   * Supports env var references: "$OPENAI_API_KEY" → process.env.OPENAI_API_KEY.
   */
  apiKey?: string;
  /** Default model for this provider. */
  defaultModel?: string;
  /**
   * Narrows the models a client may request (glob patterns, e.g. "gpt-5*").
   * Whatever the list says, a requested model must also be the default model
   * or have a price in usage.pricing, so nothing is billed at fallback rates.
   */
  allowedModels?: string[];
  /** Optional provider-level cap for tool calls per response run. */
  maxToolCalls?: number;
  /** Base URL override (proxies, Azure OpenAI, self-hosted, etc.). */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;

  // -- OpenAI-specific --
  /** OpenAI organization ID. */
  organization?: string;
  /** OpenAI project ID. */
  project?: string;
  /** OpenAI Responses API context-window controls. */
  responses?: OpenAIResponsesConfig;

  // -- Anthropic-specific --
  /** Default max tokens (Anthropic requires this). */
  defaultMaxTokens?: number;

  // -- API format --
  /**
   * Which API format this provider uses.
   *
   * - `"responses"`   → OpenAI Responses API (default for "openai")
   * - `"completions"` → OpenAI Chat Completions API (Minimax, Together, Groq, etc.)
   * - `"messages"`    → Anthropic Messages API (default for "anthropic")
   *
   * When set, the client routes to the matching provider factory regardless
   * of the provider ID in config.  Omit to use the built-in default for
   * the provider ID (e.g. "openai" → "responses").
   */
  apiFormat?: "responses" | "completions" | "messages";

  // -- Reasoning / thinking capability --
  /**
   * Reasoning effort support for this provider.
   *
   * If enabled and the selected model supports reasoning,
   * the client can auto-default effort to "low" when callers
   * do not explicitly set a reasoning effort.
   */
  reasoningEffort?: {
    /** Enable reasoning effort for this provider. */
    enabled?: boolean;
    /** Default effort when supported by the selected model. */
    defaultEffort?: "low" | "medium" | "high";
    /**
     * Optional model allow-list patterns.
     * Supports simple wildcard `*` (case-insensitive), e.g. `gpt-5*`.
     */
    supportedModels?: string[];
  };
}

/**
 * Top-level LLM configuration ("llms" section of agentforeach.json).
 */
export interface LlmConfig {
  /**
   * Default provider to use when not specified per-request.
   * Must match a key in `providers`. Defaults to "openai".
   */
  defaultProvider?: ProviderId;

  /**
   * Default model used when the provider's own defaultModel is not set.
   * Falls back to provider-specific defaults if omitted.
   */
  defaultModel?: string;

  /**
   * Per-provider configuration.
   * Key = provider ID ("openai", "anthropic", or custom).
   */
  providers?: Record<string, LlmProviderEntry>;

  /**
   * Embedding configuration (used by the memory layer).
   */
  embedding?: {
    /** Provider to use for embeddings. Defaults to "openai". */
    provider?: string;
    /** API key for embeddings (defaults to the embedding provider's apiKey). */
    apiKey?: string;
    /** Embedding model. Defaults to "text-embedding-3-small". */
    model?: string;
    /** Base URL for embedding API (defaults to the embedding provider's baseUrl). */
    baseUrl?: string;
  };

  /**
   * Failover configuration for automatic retry and provider fallback.
   *
   * When enabled, retryable errors (429, 500, 502, 503) trigger a retry
   * with the next provider in the chain. Providers that fail are put into
   * a cooldown period.
   */
  failover?: Partial<FailoverConfig>;

  /**
   * Continue conversations with the provider's stored response chain
   * (OpenAI previous_response_id) instead of sending local history.
   * Default: true. AGENTFOREACH_CHAIN_RESPONSES overrides.
   */
  chainResponses?: boolean;

  /**
   * Maximum number of tool-call rounds (LLM call → tool execution cycles)
   * before the runner forces completion. Defaults to 15.
   *
   * For agentic workflows with many sequential tool calls (e.g. multi-step
   * MCP workflows), increase this to 30 or higher.
   */
  maxToolRounds?: number;

  /**
   * Soft tool-round budget, enforced by the runner rather than stated in
   * prompt prose (a prose budget cannot be honoured deterministically and
   * ends up fighting the workflow instructions).
   *
   * When the round count reaches `soft`, a one-time note is injected into
   * the model's context saying how many rounds remain before the
   * `maxToolRounds` hard stop, so it converges instead of being cut off
   * mid-flow. Absent = no note.
   */
  toolBudget?: {
    /** Round count at which the model is warned. */
    soft: number;
  };
}

// ============================================================================
// Env Var Resolution
// ============================================================================

/**
 * Resolve a config value that may be an env var reference.
 * Re-exported from utils/env for backward compatibility.
 */
export { resolveEnvValue } from "../utils/index.js";

// ============================================================================
// Config Loader
// ============================================================================

let _llmConfig: LlmConfig | undefined;

/**
 * Load the LLM config from agentforeach.json.
 *
 * Uses the shared config loader from utils/config.
 * Falls back to sensible defaults if no config found.
 */
export function loadLlmConfig(): LlmConfig {
  if (_llmConfig) return _llmConfig;

  const llmSection = loadConfigSection<LlmConfig>("llms");

  if (!llmSection) {
    _llmConfig = buildDefaultConfig();
  } else {
    _llmConfig = llmSection;
  }

  return _llmConfig;
}

/**
 * Resolve the effective provider config by merging:
 *   agentforeach.json config → env var overrides
 *
 * Env vars always win over config file values.
 */
export function resolveProviderConfig(providerId: string): {
  apiKey: string;
  defaultModel: string;
  maxToolCalls?: number;
  baseUrl?: string;
  timeoutMs?: number;
  organization?: string;
  project?: string;
  responses?: OpenAIResponsesConfig;
  defaultMaxTokens?: number;
  reasoningEffort?: {
    enabled?: boolean;
    defaultEffort?: "low" | "medium" | "high";
    supportedModels?: string[];
  };
  apiFormat?: "responses" | "completions" | "messages";
} | null {
  const config = loadLlmConfig();
  const entry = config.providers?.[providerId];

  if (entry?.enabled === false) return null;

  // Resolve API key: env var override → config value (with env ref) → provider-specific env var
  const envKeyMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };

  const apiKey =
    process.env[envKeyMap[providerId] ?? ""] ||
    resolveEnvValue(entry?.apiKey) ||
    undefined;

  if (!apiKey) return null;

  // Resolve default model: env var → config → provider defaults
  const defaultModelMap: Record<string, string> = {
    openai: "gpt-5.2",
    anthropic: "claude-sonnet-5",
  };

  const defaultModel =
    process.env.PROVIDER_MODEL ||
    entry?.defaultModel ||
    config.defaultModel ||
    defaultModelMap[providerId] ||
    "gpt-5.2";

  // Resolve base URL: env var → config
  const baseUrl =
    process.env.PROVIDER_BASE_URL ||
    resolveEnvValue(entry?.baseUrl) ||
    undefined;

  return {
    apiKey,
    defaultModel,
    maxToolCalls: entry?.maxToolCalls,
    baseUrl,
    timeoutMs: entry?.timeoutMs,
    organization: entry?.organization,
    project: entry?.project,
    responses: entry?.responses,
    defaultMaxTokens: entry?.defaultMaxTokens,
    reasoningEffort: entry?.reasoningEffort,
    apiFormat: entry?.apiFormat,
  };
}

/**
 * Resolve whether a specific provider/model supports reasoning effort.
 */
export function supportsReasoningEffort(params: {
  providerId: string;
  model?: string;
}): boolean {
  const config = loadLlmConfig();
  const providerId = params.providerId.trim().toLowerCase();
  const model = params.model?.trim();
  const entry = config.providers?.[params.providerId];

  if (entry?.enabled === false) return false;

  const configured = entry?.reasoningEffort;
  if (configured?.enabled === false) return false;

  const supportedModels = configured?.supportedModels;
  if (supportedModels && supportedModels.length > 0) {
    if (!model) return false;
    return supportedModels.some((pattern) => matchesModelPattern(model, pattern));
  }

  if (!model) return false;
  return matchesBuiltInReasoningModel(providerId, model);
}

/**
 * Resolve the default reasoning effort for a provider/model pair.
 * Returns undefined when reasoning effort is unsupported.
 */
export function resolveDefaultReasoningEffort(params: {
  providerId: string;
  model?: string;
}): "low" | "medium" | "high" | undefined {
  const config = loadLlmConfig();
  const entry = config.providers?.[params.providerId];

  if (!supportsReasoningEffort(params)) {
    return undefined;
  }

  return entry?.reasoningEffort?.defaultEffort ?? "low";
}

/**
 * Resolve the default provider ID from config + env.
 * Env var PROVIDER_ID wins, then config, then "openai".
 */
export function resolveDefaultProviderId(): ProviderId {
  const config = loadLlmConfig();
  return (
    (process.env.PROVIDER_ID as ProviderId | undefined) ||
    config.defaultProvider ||
    "openai"
  );
}

/**
 * Get all enabled provider IDs from config.
 */
export function getEnabledProviderIds(): ProviderId[] {
  const config = loadLlmConfig();
  if (!config.providers) return [];
  return Object.entries(config.providers)
    .filter(([, entry]) => entry.enabled !== false)
    .map(([id]) => id);
}

/**
 * Resolve embedding configuration.
 */
export function resolveEmbeddingConfig(): {
  apiKey: string | undefined;
  model: string;
  baseUrl: string | undefined;
} {
  const config = loadLlmConfig();
  const embedding = config.embedding;

  const embeddingProvider = embedding?.provider ?? "openai";
  const providerEntry = config.providers?.[embeddingProvider];

  const apiKey =
    process.env.EMBEDDING_API_KEY ||
    resolveEnvValue(embedding?.apiKey) ||
    resolveEnvValue(providerEntry?.apiKey) ||
    process.env.OPENAI_API_KEY ||
    undefined;

  const model =
    process.env.EMBEDDING_MODEL || embedding?.model || "text-embedding-3-small";

  const baseUrl =
    process.env.EMBEDDING_BASE_URL ||
    resolveEnvValue(embedding?.baseUrl) ||
    resolveEnvValue(providerEntry?.baseUrl) ||
    undefined;

  return { apiKey, model, baseUrl };
}

/**
 * Load the resolved failover configuration.
 *
 * Merges agentforeach.json "llms.failover" with defaults.
 * If the chain is empty, it auto-populates from enabled providers.
 */
export function loadFailoverConfig(): FailoverConfig {
  const config = loadLlmConfig();
  const partial = config.failover;

  const resolved: FailoverConfig = {
    enabled: partial?.enabled ?? DEFAULT_FAILOVER_CONFIG.enabled,
    retryableStatusCodes:
      partial?.retryableStatusCodes ?? DEFAULT_FAILOVER_CONFIG.retryableStatusCodes,
    maxRetries: partial?.maxRetries ?? DEFAULT_FAILOVER_CONFIG.maxRetries,
    cooldownMs: partial?.cooldownMs ?? DEFAULT_FAILOVER_CONFIG.cooldownMs,
    chain: partial?.chain ?? DEFAULT_FAILOVER_CONFIG.chain,
  };

  // Auto-populate chain from enabled providers if not explicitly set
  if (resolved.enabled && resolved.chain.length === 0) {
    resolved.chain = getEnabledProviderIds();
  }

  return resolved;
}

/**
 * Reset the cached config (for testing).
 */
export function resetLlmConfig(): void {
  _llmConfig = undefined;
}

// ============================================================================
// API Format → Factory Routing
// ============================================================================

/** Format → registered factory provider ID. */
const FORMAT_FACTORY_MAP: Record<string, string> = {
  responses: "openai",
  completions: "openai-completions",
  messages: "anthropic",
};

/**
 * Resolve which factory provider ID to use for a given config provider.
 *
 * When a config entry has `apiFormat` set, this maps it to the matching
 * factory ID (e.g. `apiFormat: "completions"` → `"openai-completions"`).
 * Otherwise returns the config provider ID unchanged — the existing
 * built-in providers ("openai", "anthropic") are registered under their
 * own names.
 */
export function resolveFactoryId(configProviderId: string): string {
  const config = loadLlmConfig();
  const entry = config.providers?.[configProviderId];
  const format = entry?.apiFormat;

  if (!format) return configProviderId;

  return FORMAT_FACTORY_MAP[format] ?? configProviderId;
}

// ============================================================================
// Defaults
// ============================================================================

function buildDefaultConfig(): LlmConfig {
  return {
    defaultProvider: "openai",
    providers: {
      openai: {
        enabled: true,
        apiKey: "$OPENAI_API_KEY",
        defaultModel: "gpt-5.2",
        reasoningEffort: {
          enabled: true,
          defaultEffort: "low",
          supportedModels: ["gpt-5*", "o1*", "o3*", "o4*"],
        },
      },
      anthropic: {
        enabled: true,
        apiKey: "$ANTHROPIC_API_KEY",
        defaultModel: "claude-sonnet-4-20250514",
        defaultMaxTokens: 4096,
        reasoningEffort: {
          enabled: true,
          defaultEffort: "low",
          supportedModels: ["claude*"],
        },
      },
    },
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
    },
  };
}

export function matchesModelPattern(model: string, pattern: string): boolean {
  const value = model.trim().toLowerCase();
  const pat = pattern.trim().toLowerCase();
  if (!value || !pat) return false;

  if (!pat.includes("*")) {
    return value === pat;
  }

  const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function matchesBuiltInReasoningModel(providerId: string, model: string): boolean {
  const provider = providerId.trim().toLowerCase();
  const value = model.trim().toLowerCase();

  if (provider === "openai") {
    return (
      value.startsWith("gpt-5") ||
      value.startsWith("o1") ||
      value.startsWith("o3") ||
      value.startsWith("o4")
    );
  }

  if (provider === "anthropic") {
    return value.startsWith("claude");
  }

  return false;
}

/** Whether new turns continue the provider's response chain (see LlmConfig.chainResponses). */
export function chainResponsesEnabled(): boolean {
  const env = process.env.AGENTFOREACH_CHAIN_RESPONSES;
  if (env !== undefined && env !== "") return env === "true" || env === "1";
  return loadLlmConfig().chainResponses ?? true;
}
