/**
 * AgentForEach Prompt Layer — Public API
 *
 * Barrel export for the system prompt / identity / context management layer.
 *
 * Usage:
 * ```ts
 * import {
 *   buildSystemPrompt,
 *   PromptDocumentStore,
 *   resolveIdentity,
 *   DEFAULT_TEMPLATES,
 *   getPromptToolDefinitions,
 *   PromptToolHandler,
 * } from "./prompt/index.js";
 *
 * // 1. Initialize the store
 * const store = new PromptDocumentStore(cosmosDb);
 * await store.initialize();
 *
 * // 2. Seed defaults for new users
 * await store.seedDefaults("user_123", "default");
 *
 * // 3. Build system prompt for a request
 * const prompt = await buildSystemPrompt(store, {
 *   userId: "user_123",
 *   agentId: "default",
 *   sessionType: "interactive",
 *   promptMode: "full",
 * });
 *
 * // 4. Use in provider request
 * const response = await provider.createResponse({
 *   model: "gpt-5.2",
 *   input: userMessage,
 *   instructions: prompt.instructions,
 * });
 * ```
 */

// -- Types --
export type {
  PromptMode,
  SessionType,
  PromptDocumentType,
  PromptDocument,
  AgentIdentity,
  IdentityConfig,
  PromptContext,
  AssembledPrompt,
  PromptBuilderOptions,
  OnboardingState,
  LoadedPromptDoc,
  IdentityData,
  UserData,
  SoulData,
  AgentsData,
  ToolsData,
  HeartbeatData,
  BootstrapData,
  MemoryData,
  PromptDataMap,
} from "./types.js";

export {
  PROMPT_DOCUMENT_ORDER,
  MINIMAL_SESSION_DOCUMENTS,
  CRON_SESSION_DOCUMENTS,
  DEFAULT_PROMPT_OPTIONS,
  DOC_TYPE_DISPLAY_NAME,
  UPDATABLE_FIELDS,
  getTypedData,
} from "./types.js";

// -- Identity resolution --
export { resolveIdentity } from "./sections/identity.js";

// -- Templates & renderers --
export {
  DEFAULT_TEMPLATES,
  getDefaultTemplate,
  resetTemplatesCache,
  renderDocumentData,
} from "./templates.js";

// -- Store --
export { PromptDocumentStore, DEFAULT_AGENT_ID } from "./store.js";

// -- Builder --
export { buildSystemPrompt } from "./builder.js";

// -- LLM Tools (prompt_get, prompt_update) --
export {
  getPromptToolDefinitions,
  PromptToolHandler,
  isPromptTool,
  PROMPT_GET_TOOL_NAME,
  PROMPT_UPDATE_TOOL_NAME,
} from "./tools.js";

// -- Section builders (for advanced usage / testing) --
export {
  buildToolLines,
  buildToolingSection,
  buildToolCallStyleSection,
  CORE_TOOL_SUMMARIES,
  TOOL_ORDER,
  buildSafetySection,
  buildGatewayReferenceSection,
  buildMemoryRecallSection,
  buildRecalledMemoriesSection,
  buildWorkspaceSection,
  buildAuthorizedSendersSection,
  buildTimeSection,
  buildReplyTagsSection,
  buildMessagingSection,
  buildChannelContextSection,
  buildGroupChatSection,
  buildExtraContextSection,
  buildProjectContextSection,
  buildSilentRepliesSection,
  buildHeartbeatsSection,
  buildRuntimeSection,
  buildRuntimeLine,
} from "./sections/index.js";

// -- Prompt Text Config (agentforeach.json "prompt" section) --
export {
  loadPromptTextConfig,
  resetPromptTextConfigCache,
  setPromptTextConfigForTest,
} from "./prompt-config.js";
export type { PromptTextConfig } from "./prompt-config.js";

// -- Onboarding Config (agentforeach.json "onboarding" section) --
export {
  loadOnboardingConfig,
  isOnboardingEnabled,
  resetOnboardingConfigCache,
  setOnboardingConfigForTest,
} from "./prompt-config.js";
export type { OnboardingConfig, OnboardingJsonConfig } from "./prompt-config.js";

// -- Prompt Config Mode (agentforeach.json "prompt"."type" field) --
export {
  loadPromptConfigMode,
  isPromptStatic,
  resetPromptConfigModeCache,
  setPromptConfigModeForTest,
  STATIC_LOCKED_TYPES,
} from "./prompt-config.js";
export type { PromptConfigMode } from "./prompt-config.js";
