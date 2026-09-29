/**
 * AgentForEach Prompt Layer — Prompt Text Configuration
 *
 * Defines the typed config schema for all system-prompt text/instructions.
 * Text is loaded from agentforeach.json `"prompt"` section at runtime, with
 * built-in defaults so the system works identically if the section is absent.
 *
 * Template placeholders use `{name}` syntax — the section builders
 * perform string interpolation at assembly time.
 */

import { loadConfigSection } from "../utils/index.js";

// ============================================================================
// Onboarding feature config (top-level "onboarding" section in agentforeach.json)
// ============================================================================

export interface OnboardingJsonConfig {
  /** Enable/disable first-run onboarding (BOOTSTRAP document seeding & prompt injection). Default: true. */
  enabled?: boolean;
}

export interface OnboardingConfig {
  enabled: boolean;
}

let _onboardingCfg: OnboardingConfig | undefined;

/**
 * Load onboarding feature config from agentforeach.json "onboarding" section.
 * When disabled, BOOTSTRAP documents are never seeded and the builder
 * skips onboarding detection entirely (isOnboarding is always false).
 */
export function loadOnboardingConfig(): OnboardingConfig {
  if (_onboardingCfg) return _onboardingCfg;

  const section = loadConfigSection<OnboardingJsonConfig>("onboarding");
  _onboardingCfg = {
    enabled: section?.enabled !== false,   // default: true
  };
  return _onboardingCfg;
}

/** Check whether onboarding is enabled. */
export function isOnboardingEnabled(): boolean {
  return loadOnboardingConfig().enabled;
}

/** Reset the cached onboarding config (for testing). */
export function resetOnboardingConfigCache(): void {
  _onboardingCfg = undefined;
}

/**
 * Override the cached onboarding config (for testing only).
 * Call `resetOnboardingConfigCache()` to revert to file-based loading.
 */
export function setOnboardingConfigForTest(cfg: OnboardingConfig): void {
  _onboardingCfg = cfg;
}

// ============================================================================
// Prompt Config Mode — static vs dynamic prompt documents
// ============================================================================

/**
 * Controls whether prompt documents are mutable by the agent.
 *
 * - "static"  — Only USER can be updated via prompt_update.
 *               IDENTITY, SOUL, AGENTS, TOOLS, HEARTBEAT, MEMORY are read-only.
 * - "dynamic" — All document types can be updated (current behaviour).
 */
export type PromptConfigMode = "static" | "dynamic";

/** Document types the agent is NOT allowed to modify in static mode. */
export const STATIC_LOCKED_TYPES: ReadonlySet<string> = new Set([
  "IDENTITY", "AGENTS", "SOUL", "TOOLS", "HEARTBEAT", "MEMORY",
]);

let _promptMode: PromptConfigMode | undefined;

/**
 * Load the prompt config mode from agentforeach.json `"prompt"."type"` field.
 * Defaults to `"static"` when absent or unrecognised.
 */
export function loadPromptConfigMode(): PromptConfigMode {
  if (_promptMode) return _promptMode;

  const section = loadConfigSection<{ type?: string }>("prompt");
  const raw = section?.type;
  _promptMode = raw === "dynamic" ? "dynamic" : "static";
  return _promptMode;
}

/** Check whether prompt documents are in static (read-only) mode. */
export function isPromptStatic(): boolean {
  return loadPromptConfigMode() === "static";
}

/** Reset the cached prompt config mode (for testing). */
export function resetPromptConfigModeCache(): void {
  _promptMode = undefined;
}

/**
 * Override the cached prompt config mode (for testing only).
 * Call `resetPromptConfigModeCache()` to revert to file-based loading.
 */
export function setPromptConfigModeForTest(mode: PromptConfigMode): void {
  _promptMode = mode;
}

// ============================================================================
// Config Types — one sub-interface per section builder
// ============================================================================

export interface SafetyTextConfig {
  header: string;
  rules: string[];
}

/**
 * One gateway rule: a plain string applies on every channel; the object form
 * scopes it — a rule about tapping an app widget has no business in a
 * WhatsApp thread.
 */
export type GatewayRule = string | { channels: string[]; rule: string };

export interface GatewayPhaseConfig {
  /**
   * Tool names whose appearance in the PREVIOUS run's calls place the
   * conversation in this phase. Declaration order is precedence: the last
   * declared phase whose `enterOn` intersects wins, so list phases in flow
   * order (routing → collecting → building → reviewing).
   */
  enterOn: string[];
  rules: GatewayRule[];
}

/**
 * Flat (`rules`) and phase-scoped (`always` + `phases`) forms. Flat is the
 * back-compat shape every deployment starts with — the whole rulebook every
 * turn. Phase-scoping exists because a 30KB gateway on a greeting is cost
 * and rule-contention with no behaviour behind it: the assembler emits
 * `always` plus ONE phase, derived from the previous run's tool calls.
 * Absence of `phases` is the kill-switch back to flat behaviour.
 */
export interface GatewayTextConfig {
  header: string;
  rules?: GatewayRule[];
  always?: GatewayRule[];
  phases?: Record<string, GatewayPhaseConfig>;
}

export interface ToolingTextConfig {
  header: string;
  intro: string;
  caseSensitiveNote: string;
  emptyMessage: string;
  footer: string;
}

export interface ToolCallStyleTextConfig {
  header: string;
  rules: string[];
  responseFormat: {
    header: string;
    rules: string[];
  };
}

export interface MemoryRecallTextConfig {
  header: string;
  intro: string;
  toolGuideHeader: string;
  memorySearchDesc: string;
  memoryGetDesc: string;
  episodeRecallDesc: string;
  sessionSearchDesc: string;
  lowConfidenceNote: string;
}

export interface RecalledMemoriesTextConfig {
  header: string;
  intro: string;
  trustWarning: string;
}

export interface EpisodesTextConfig {
  header: string;
  intro: string[];
  recallHeader: string;
  recallIntro: string;
  recallRules: string[];
  recallCaveat: string;
  activeHeader: string;
  /** Template. Placeholder: {themes} */
  activeIntro: string;
  activeGuidance: string;
  managingHeader: string;
  managingIntro: string;
  managingSteps: string[];
  managingGuidelines: string[];
}

export interface SkillsTextConfig {
  header: string;
  intro: string[];
  toolGuideHeader: string;
  toolGuide: string[];
  credentialHeader: string;
  credentialNote: string[];
  translatingHeader: string;
  translatingIntro: string;
  translatingNote: string;
  translatingRules: string[];
  translatingFallback: string;
  needsSetupHeader: string;
  needsSetupFooter: string;
}

export interface CompactionTextConfig {
  header: string;
  intro: string;
}

export interface RecencyTextConfig {
  header: string;
  intro: string;
}

export interface KnowledgeTextConfig {
  header: string;
  intro: string;
  trustWarning: string;
}

export interface SilentRepliesTextConfig {
  header: string;
  /** Template. Placeholder: {token} */
  instruction: string;
  rulesHeader: string;
  /** Template. Placeholder: {token} */
  rules: string[];
}

export interface HeartbeatsTextConfig {
  header: string;
  instruction: string;
  /** Template. Placeholder: {token} */
  alertNote: string;
}

export interface WorkspaceTextConfig {
  header: string;
  lines: string[];
}

export interface TimeTextConfig {
  header: string;
  relativeTimeHint: string;
}

export interface AuthorizedSendersTextConfig {
  header: string;
  /** Template. Placeholder: {senders} */
  template: string;
}

export interface ChannelTextConfig {
  header: string;
  /** Template. Placeholder: {channel} */
  activeTemplate: string;
  formatting: string;
}

export interface ReplyTagsTextConfig {
  header: string;
  rules: string[];
}

export interface MessagingTextConfig {
  header: string;
  rules: string[];
  /** Template. Placeholder: {token} */
  messageToolNote: string;
}

export interface GroupChatTextConfig {
  respondRule: string;
  avoidRule: string;
}

export interface ExtraContextTextConfig {
  cronHeader: string;
  subagentHeader: string;
  groupHeader: string;
  defaultHeader: string;
}

export interface ProjectContextTextConfig {
  header: string;
  intro: string;
  soulInstruction: string;
}

export interface RuntimeTextConfig {
  header: string;
  prefix: string;
}

// ============================================================================
// Top-level config
// ============================================================================

export interface PromptTextConfig {
  /** Static opening line of the system prompt (e.g. "You are a personal AI assistant 🤖.") */
  topContext: string;
  safety: SafetyTextConfig;
  gateway: GatewayTextConfig;
  tooling: ToolingTextConfig;
  toolCallStyle: ToolCallStyleTextConfig;
  /** Per-tool descriptions shown in the Tooling section. */
  toolSummaries: Record<string, string>;
  /** Canonical tool display order. Tools not listed appear alphabetically after. */
  toolOrder: string[];
  /** Tools hidden from the LLM (not shown in prompt or function-calling). API access remains. */
  hiddenTools?: string[];
  /**
   * Channel-scoped tools: tool name -> the ONLY channel names it is served
   * on. A channel-shaped tool (a WhatsApp Flow hand-off) is prompt cost and
   * a refusal-in-waiting on every other surface, so it is filtered out of
   * both the tool listing and the provider definitions when the request's
   * channel does not match. Requests with no channel (internal/test callers)
   * see everything, same as gateway rule scoping.
   */
  toolChannels?: Record<string, string[]>;
  memoryRecall: MemoryRecallTextConfig;
  recalledMemories: RecalledMemoriesTextConfig;
  episodes: EpisodesTextConfig;
  skills: SkillsTextConfig;
  compaction: CompactionTextConfig;
  recency: RecencyTextConfig;
  knowledge: KnowledgeTextConfig;
  silentReplies?: SilentRepliesTextConfig;
  heartbeats?: HeartbeatsTextConfig;
  workspace?: WorkspaceTextConfig;
  time: TimeTextConfig;
  authorizedSenders?: AuthorizedSendersTextConfig;
  channel?: ChannelTextConfig;
  replyTags?: ReplyTagsTextConfig;
  messaging?: MessagingTextConfig;
  groupChat?: GroupChatTextConfig;
  extraContext?: ExtraContextTextConfig;
  projectContext?: ProjectContextTextConfig;
  runtime?: RuntimeTextConfig;
}

// ============================================================================
// Loader
// ============================================================================

let _cached: PromptTextConfig | null = null;

/**
 * Load prompt text configuration from agentforeach.json `"prompt"` section.
 *
 * agentforeach.json is the single source of truth — no in-code defaults.
 * Throws if the section is missing.
 *
 * Result is cached after first load.
 */
export function loadPromptTextConfig(): PromptTextConfig {
  if (_cached) return _cached;

  const section = loadConfigSection<PromptTextConfig>("prompt");

  if (!section) {
    throw new Error(
      'Missing "prompt" section in agentforeach.json. ' +
      'Config file is the single source of truth for prompt text.',
    );
  }

  _cached = section;
  return _cached;
}

/**
 * Reset cached prompt text config (for testing).
 */
export function resetPromptTextConfigCache(): void {
  _cached = null;
}

/**
 * Override the cached prompt text config (for testing only).
 * Call `resetPromptTextConfigCache()` to revert to file-based loading.
 */
export function setPromptTextConfigForTest(cfg: PromptTextConfig): void {
  _cached = cfg;
}
