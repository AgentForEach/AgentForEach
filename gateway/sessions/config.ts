/**
 * AgentForEach Sessions Module — Configuration
 *
 * Loads session configuration from agentforeach.json ("session" section).
 * Follows the same modular config pattern as auth/, llms/, cron/, memory/.
 *
 * Key integration points:
 *   - Uses shared `loadConfigSection()` from utils/config
 *   - Database connection is resolved from the shared database layer
 *   - agentforeach.json is the single source of truth for session configuration
 */

import { loadConfigSection } from "../utils/index.js";
import type { SessionJsonConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

/** Default Cosmos DB container name for sessions. */
export const DEFAULT_CONTAINER_ID = "sessions";

/** Default Cosmos DB container name for messages. */
export const DEFAULT_MESSAGES_CONTAINER_ID = "session-messages-v2";

/**
 * Default message document TTL: 7 days. Once a session expires (24 h idle by
 * default) its messages are unreachable, so this is how long they're stored
 * for nothing. Active sessions compact by age at half this, before expiry.
 */
export const DEFAULT_MESSAGE_TTL_SECONDS = 604_800;

/** Default session inactivity TTL: 24 hours. */
export const DEFAULT_TTL_SECONDS = 86400;

/** Default max recent messages to load for LLM history. */
export const DEFAULT_MAX_HISTORY = 100;

/** Default agent ID when none is specified. */
export const DEFAULT_AGENT_ID = "default";

/** Default message count before triggering compaction. */
export const DEFAULT_COMPACTION_THRESHOLD = 60;

/** Default number of recent messages to retain after compaction. */
export const DEFAULT_COMPACTION_RETAIN_COUNT = 20;

/** Default temperature for compaction LLM calls. */
export const DEFAULT_COMPACTION_TEMPERATURE = 0.3;

/** Default max output tokens for compaction summaries. */
export const DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS = 4000;

/** Default max preview length for session listing. */
export const DEFAULT_MAX_PREVIEW_LENGTH = 120;

// ============================================================================
// Resolved Config
// ============================================================================

/** Fully resolved session configuration with defaults applied. */
export interface SessionConfig {
  containerId: string;
  messagesContainerId: string;
  ttlSeconds: number;
  messageTtlSeconds: number;
  maxHistoryMessages: number;
  defaultAgentId: string;
  compactionThreshold: number;
  compactionRetainCount: number;
  compactionModel?: string;
  compactionTemperature: number;
  compactionMaxOutputTokens: number;
  maxPreviewLength: number;
}

// ============================================================================
// Config Loader
// ============================================================================

let _cfg: SessionConfig | undefined;

/**
 * Load session config from agentforeach.json "session" section and resolve
 * all defaults.
 *
 * Follows the same pattern as `loadMemoryConfig()` and cron's `cfg()`:
 *   1. Load the raw JSON section via `loadConfigSection()`
 *   2. Apply defaults for any missing fields
 *   3. Cache the resolved config for subsequent calls
 *
 * agentforeach.json is the single source of truth for session configuration.
 */
export function loadSessionConfig(): SessionConfig {
  if (_cfg) return _cfg;

  const section = loadConfigSection<SessionJsonConfig>("session");
  const json = section ?? {};

  _cfg = {
    containerId: json.containerId ?? DEFAULT_CONTAINER_ID,
    messagesContainerId: json.messagesContainerId ?? DEFAULT_MESSAGES_CONTAINER_ID,
    ttlSeconds: json.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    messageTtlSeconds: json.messageTtlSeconds ?? DEFAULT_MESSAGE_TTL_SECONDS,
    maxHistoryMessages: json.maxHistoryMessages ?? DEFAULT_MAX_HISTORY,
    defaultAgentId: json.defaultAgentId ?? DEFAULT_AGENT_ID,
    compactionThreshold: json.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
    compactionRetainCount: json.compactionRetainCount ?? DEFAULT_COMPACTION_RETAIN_COUNT,
    compactionModel: json.compactionModel,
    compactionTemperature: json.compactionTemperature ?? DEFAULT_COMPACTION_TEMPERATURE,
    compactionMaxOutputTokens: json.compactionMaxOutputTokens ?? DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS,
    maxPreviewLength: json.maxPreviewLength ?? DEFAULT_MAX_PREVIEW_LENGTH,
  };

  return _cfg;
}

// ============================================================================
// Resolved Accessors
// ============================================================================

/** Get the resolved container ID. */
export function resolveContainerId(): string {
  return loadSessionConfig().containerId;
}

/** Get the resolved messages container ID. */
export function resolveMessagesContainerId(): string {
  return loadSessionConfig().messagesContainerId;
}

/** Get the resolved TTL in seconds. */
export function resolveTtlSeconds(): number {
  return loadSessionConfig().ttlSeconds;
}

/** Get the resolved max history messages. */
export function resolveMaxHistory(): number {
  return loadSessionConfig().maxHistoryMessages;
}

/** Get the resolved default agent ID. */
export function resolveDefaultAgentId(): string {
  return loadSessionConfig().defaultAgentId;
}

/** Get the resolved compaction threshold. */
export function resolveCompactionThreshold(): number {
  return loadSessionConfig().compactionThreshold;
}

/** Get the resolved compaction retain count. */
export function resolveCompactionRetainCount(): number {
  return loadSessionConfig().compactionRetainCount;
}

/**
 * Reset cached session config (for testing).
 */
export function resetSessionConfigCache(): void {
  _cfg = undefined;
}
