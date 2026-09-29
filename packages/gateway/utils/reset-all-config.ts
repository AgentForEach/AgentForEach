/**
 * AgentForEach Utilities — Reset All Config Caches
 *
 * Aggregates every module-level config-reset function into a single
 * `resetAllConfig()` call.  Primarily useful for test isolation — call
 * it in `beforeEach` / `afterEach` to guarantee a clean slate.
 *
 * NOTE: This file is intentionally NOT re-exported from `utils/index.ts`
 * to avoid circular module dependencies (each domain config imports from
 * `utils/`).  Import it directly:
 *
 * ```ts
 * import { resetAllConfig } from "../utils/reset-all-config.js";
 * ```
 */

// -- Core config (JSON file cache) -------------------------------------------
import { resetConfigCache } from "./config.js";

// -- Domain module resets (alphabetical) --------------------------------------
import { resetAuthConfig } from "../auth/config.js";
import { resetChannelsConfig } from "../channels/config.js";
import { resetTelegramConfig } from "../channels/telegram/config.js";
import { resetCronConfig } from "../cron/config.js";
import { resetDigestConfig } from "../digests/config.js";
import { resetEpisodeConfig } from "../episodes/config.js";
import { resetIdentityConfigCache } from "../identity/config.js";
import { resetKnowledgeConfig } from "../knowledge/config.js";
import { resetLinkConfig } from "../link-understanding/config.js";
import { resetLlmConfig } from "../llms/config.js";
import { resetMcpConfig } from "../mcp/config.js";
import { resetMemoryConfig } from "../memory/config.js";
import {
  resetPromptTextConfigCache,
  resetOnboardingConfigCache,
  resetPromptConfigModeCache,
} from "../prompt/prompt-config.js";
import { resetTemplatesCache } from "../prompt/templates.js";
import { resetSessionConfigCache } from "../sessions/config.js";
import { resetSkillsConfig } from "../skills/config.js";
import { resetUsageConfigCache } from "../usage/config.js";
import { resetWebConfig } from "../web/config.js";
import { resetWebSocketConfig } from "../websocket/config.js";
import { resetHitlConfig } from "../hitl/config.js";
import { resetCreditsConfig } from "../credits/config.js";

// =============================================================================
// Public API
// =============================================================================

/** All individual reset functions, exposed for selective use. */
export const CONFIG_RESET_FUNCTIONS: ReadonlyArray<{
  module: string;
  reset: () => void;
}> = [
  { module: "utils (root JSON)", reset: resetConfigCache },
  { module: "auth", reset: resetAuthConfig },
  { module: "channels", reset: resetChannelsConfig },
  { module: "channels/telegram", reset: resetTelegramConfig },
  { module: "cron", reset: resetCronConfig },
  { module: "digests", reset: resetDigestConfig },
  { module: "episodes", reset: resetEpisodeConfig },
  { module: "identity", reset: resetIdentityConfigCache },
  { module: "knowledge", reset: resetKnowledgeConfig },
  { module: "link-understanding", reset: resetLinkConfig },
  { module: "llms", reset: resetLlmConfig },
  { module: "mcp", reset: resetMcpConfig },
  { module: "memory", reset: resetMemoryConfig },
  { module: "prompt/text", reset: resetPromptTextConfigCache },
  { module: "prompt/onboarding", reset: resetOnboardingConfigCache },
  { module: "prompt/mode", reset: resetPromptConfigModeCache },
  { module: "prompt/templates", reset: resetTemplatesCache },
  { module: "sessions", reset: resetSessionConfigCache },
  { module: "skills", reset: resetSkillsConfig },
  { module: "usage", reset: resetUsageConfigCache },
  { module: "web", reset: resetWebConfig },
  { module: "websocket", reset: resetWebSocketConfig },
  { module: "hitl", reset: resetHitlConfig },
  { module: "credits", reset: resetCreditsConfig },
];

/**
 * Reset **every** config cache across all AgentForEach modules.
 *
 * The core JSON cache (`utils/config.ts`) is always reset first so that
 * downstream modules re-read from disk on their next `loadConfigSection` call.
 *
 * @returns The number of caches that were reset.
 */
export function resetAllConfig(): number {
  for (const { reset } of CONFIG_RESET_FUNCTIONS) {
    reset();
  }
  return CONFIG_RESET_FUNCTIONS.length;
}
