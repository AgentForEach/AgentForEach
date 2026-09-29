/**
 * AgentForEach Hooks Module — Types
 *
 * Typed event definitions for the hook system. Each hook name maps to
 * a specific event shape in HookEventMap, and modifying hooks have
 * corresponding return types in HookResultMap.
 *
 * Two categories of hooks:
 *   - **Void hooks** — observe-only, fire in parallel, errors caught
 *   - **Modifying hooks** — can return data, run sequentially by priority
 *
 * Equivalent to OpenClaw's internal-hooks + plugin-hooks merged into
 * one typed system (AgentForEach doesn't need directory discovery or HOOK.md).
 */

import type { SendResponse } from "../client/types.js";
import type { Session } from "../sessions/types.js";
import type { PromptContext } from "../prompt/types.js";
import type { ProviderRequest, ProviderResponse, UsageStats } from "../llms/index.js";

// ============================================================================
// Hook Event Map — One entry per hook point
// ============================================================================

/**
 * Maps each hook name to its event payload type.
 * This is the single source of truth for all hook events.
 */
export interface HookEventMap {
  // ── Run lifecycle ──────────────────────────────────────────────────────

  /** Emitted at the start of a run, before session load. */
  run_started: {
    runId: string;
    userId: string;
    agentId: string;
    message?: string;
    sessionId?: string;
    channelName?: string;
    metadata?: Record<string, string>;
  };

  /** Emitted after a successful run completes. */
  run_completed: { runId: string; userId?: string; response: SendResponse };

  /** Emitted when a run fails with an error. */
  run_failed: {
    runId: string;
    userId?: string;
    sessionId?: string;
    error: Error;
    /** Tokens the run spent before failing (billed like a completed run). */
    usage?: UsageStats;
    model?: string;
  };

  // ── Session lifecycle ──────────────────────────────────────────────────

  /** Emitted when a new session is created (messageSeq === 0). */
  session_created: { session: Session; userId: string };

  /** Emitted when an existing session is loaded (messageSeq > 0). */
  session_loaded: { session: Session; userId: string };

  /** Emitted when a session is deleted (via /new, /reset, or API). */
  session_end: { userId: string; sessionId: string };

  /** Emitted before session reset — awaited to allow memory extraction. */
  before_reset: {
    userId: string;
    sessionId: string;
    session: Session | null;
  };

  // ── Prompt ─────────────────────────────────────────────────────────────

  /** MODIFYING: Emitted before system prompt assembly. Can inject context. */
  before_prompt_build: { context: PromptContext };

  // ── LLM ────────────────────────────────────────────────────────────────

  /** MODIFYING: Emitted before the LLM call. Can modify the request. */
  before_llm_call: {
    runId?: string;
    userId?: string;
    sessionId?: string;
    round?: number;
    request: ProviderRequest;
  };

  /** Emitted immediately before an LLM round starts. */
  llm_call_started: {
    runId: string;
    userId: string;
    sessionId: string;
    round: number;
    request: ProviderRequest;
  };

  /** Emitted when provider failover occurs mid-run. */
  provider_fallback: {
    runId: string;
    userId: string;
    sessionId: string;
    round: number;
    fromProvider: string;
    toProvider: string;
    reason: string;
  };

  /** Emitted after the LLM responds. */
  llm_response: {
    runId: string;
    userId: string;
    sessionId: string;
    round: number;
    response: ProviderResponse;
    providerId: string;
    model: string;
  };

  // ── Tools ──────────────────────────────────────────────────────────────

  /** MODIFYING: Emitted before a tool call. Can block execution. */
  before_tool_call: {
    runId?: string;
    userId?: string;
    sessionId?: string;
    round?: number;
    name: string;
    callId: string;
    args: unknown;
  };

  /** Emitted immediately before a tool execution starts. */
  tool_call_started: {
    runId: string;
    userId: string;
    sessionId: string;
    round: number;
    name: string;
    callId: string;
    args: unknown;
  };

  /** Emitted after a tool call completes. */
  after_tool_call: {
    runId?: string;
    userId?: string;
    sessionId?: string;
    round?: number;
    name: string;
    callId: string;
    args: unknown;
    result: string;
  };

  // ── Memory ─────────────────────────────────────────────────────────────

  /** Emitted after memories are recalled and injected into the prompt. */
  memories_recalled: { count: number; context: string };

  /** Emitted after auto-capture decides whether to store a memory. */
  memory_captured: {
    userId: string;
    text: string;
    captured: boolean;
  };

  // ── Messages ───────────────────────────────────────────────────────────

  /** Emitted when a message is received from a channel. */
  message_received: {
    userId: string;
    message: string;
    channelName?: string;
  };

  /** MODIFYING: Emitted before sending a reply through a channel. Can modify/cancel. */
  message_sending: {
    text: string;
    channelName?: string;
    chatId: string;
  };

  /** Emitted after messages are persisted to the session store. */
  message_persisted: { sessionId: string; messageCount: number };

  // ── Compaction ─────────────────────────────────────────────────────────

  /** Emitted before compaction begins. */
  before_compaction: { session: Session };

  /** Emitted after compaction completes. */
  after_compaction: {
    session: Session;
    summary: string;
    compactedCount: number;
  };

  // ── Links ──────────────────────────────────────────────────────────────

  /** Emitted after URLs in the user message are resolved. */
  links_resolved: { urls: string[]; count: number };

  // ── Attachments ────────────────────────────────────────────────────────

  /** Emitted after attached documents are extracted to text. */
  documents_extracted: { fileNames: string[]; count: number };

  // ── Commands ───────────────────────────────────────────────────────────

  /** Emitted when a slash command is executed. */
  command: {
    name: string;
    args: string;
    userId: string;
    sessionId?: string;
  };
}

// ============================================================================
// Modifying Hook Results — Return types for hooks that can alter data
// ============================================================================

/**
 * Maps modifying hook names to their result types.
 * Hooks NOT present in this map are void (observe-only).
 */
export interface HookResultMap {
  /** Extra context to append to the system prompt. */
  before_prompt_build: { extraContext?: string };

  /** Partial request modifications to merge into the LLM request. */
  before_llm_call: { request?: Partial<ProviderRequest> };

  /** Can block tool execution. */
  before_tool_call: { block?: boolean; blockReason?: string };

  /** Can modify or cancel the outbound message. */
  message_sending: { text?: string; cancel?: boolean };
}

// ============================================================================
// Derived Hook Name Types
// ============================================================================

/** Hook names that can return modifications (sequential execution). */
export type ModifyingHookName = keyof HookResultMap;

/** Hook names that are observe-only (parallel execution). */
export type VoidHookName = Exclude<keyof HookEventMap, ModifyingHookName>;

// ============================================================================
// Handler Types
// ============================================================================

/** Handler for a void hook (observe-only, no return value). */
export type VoidHookHandler<K extends VoidHookName> = (
  event: HookEventMap[K],
) => void | Promise<void>;

/** Handler for a modifying hook (can return modifications). */
export type ModifyingHookHandler<K extends ModifyingHookName> = (
  event: HookEventMap[K],
) => HookResultMap[K] | undefined | Promise<HookResultMap[K] | undefined>;

/** Union handler type for any hook (used internally by the emitter). */
export type HookHandler<K extends keyof HookEventMap> =
  K extends ModifyingHookName
    ? ModifyingHookHandler<K>
    : K extends VoidHookName
      ? VoidHookHandler<K>
      : never;
