/**
 * AgentForEach Provider Layer — Barrel Exports
 *
 * Public API for the provider subsystem.
 * Importing this module also auto-registers the built-in providers
 * (OpenAI + Anthropic) so they're available via `getProvider()`.
 */

// Types
export type {
  // Identity & config
  ProviderId,
  ProviderConfig,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
  OpenAIResponsesConfig,
  OpenAIContextManagementConfig,
  OpenAIResponsesTruncation,
  // Tools
  ToolDefinition,
  ShellToolDefinition,
  LocalShellToolDefinition,
  FunctionToolDefinition,
  WebSearchToolDefinition,
  ShellEnvironment,
  ShellEnvironmentType,
  NetworkPolicy,
  DomainSecret,
  SkillReference,
  LocalSkill,
  // Conversation
  ConversationState,
  ConversationMessage,
  ContentBlock,
  ImageSource,
  // Request / Response
  ProviderRequest,
  ReasoningConfig,
  ProviderResponse,
  OutputItem,
  MessageOutputItem,
  ShellCallOutputItem,
  ShellCallResultItem,
  FunctionCallOutput,
  ToolResultImage,
  FunctionCallOutputItem,
  ReasoningOutputItem,
  UsageStats,
  // Streaming
  StreamEvent,
  // Provider interface
  Provider,
  ProviderFactory,
} from "./types.js";

// Registry
export {
  registerProvider,
  getProvider,
  hasProvider,
  listProviders,
  clearProviderCache,
} from "./registry.js";

// Config
export {
  loadLlmConfig,
  resolveProviderConfig,
  supportsReasoningEffort,
  resolveDefaultReasoningEffort,
  resolveDefaultProviderId,
  resolveEmbeddingConfig,
  getEnabledProviderIds,
  resolveEnvValue,
  resetLlmConfig,
  loadFailoverConfig,
  resolveFactoryId,
} from "./config.js";
export type { LlmConfig, LlmProviderEntry } from "./config.js";

// Failover
export {
  withFailover,
  withFailoverStream,
  isRetryableError,
  resetCooldowns,
} from "./failover.js";
export type { FailoverConfig, FailoverResult } from "./failover.js";

// Provider classes (for direct construction / type narrowing)
export { OpenAIProvider, createOpenAIProvider } from "./providers/openai.js";
export {
  AnthropicProvider,
  createAnthropicProvider,
} from "./providers/anthropic.js";
export {
  OpenAICompletionsProvider,
  createOpenAICompletionsProvider,
} from "./providers/openai-completions.js";

// ============================================================================
// Auto-register built-in providers
// ============================================================================

import { registerProvider } from "./registry.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOpenAICompletionsProvider } from "./providers/openai-completions.js";

registerProvider("openai", createOpenAIProvider);
registerProvider("anthropic", createAnthropicProvider);
registerProvider("openai-completions", createOpenAICompletionsProvider);
