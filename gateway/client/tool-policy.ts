/**
 * AgentForEach Client Layer — Tool Policy
 *
 * Session-type-based tool gating. Determines which tools are available
 * for each session type to prevent unintended side effects:
 *
 *   - interactive: Full access to all registered tools.
 *   - subagent:    Read-only subset — no cron, no prompt editing,
 *                  no episode management, no skill setup.
 *   - cron:        Minimal — only tools needed for heartbeat tasks
 *                  (memory read, cron read, message).
 *
 * The policy filters tool definition arrays BEFORE they're passed to
 * the LLM, so the model never sees tools it can't use.
 */

import type { SessionType } from "../prompt/types.js";

// ============================================================================
// Tool Policy Definitions
// ============================================================================

/**
 * Tools BLOCKED for subagent sessions.
 *
 * Subagents are spawned for focused tasks and should not:
 *   - Create/modify reminders or cron jobs
 *   - Edit prompt configuration
 *   - Manage episodes (that's the parent session's responsibility)
 *   - Set up or configure skills
 *   - Create digests
 */
const SUBAGENT_BLOCKED: ReadonlySet<string> = new Set([
  // Cron write tools
  "cron_create",
  "cron_update",
  "cron_delete",
  // Prompt editing
  "prompt_update",
  // Episode management (read is OK for context)
  "episode_create",
  "episode_update",
  // Skill setup (execution is OK)
  "skill_setup",
  // Memory forget (subagents shouldn't delete memories)
  "memory_forget",
]);

/**
 * Tools ALLOWED for cron/heartbeat sessions.
 *
 * Cron sessions are periodic health checks. They should only be able to:
 *   - Read memory and cron state (for awareness)
 *   - Send messages (to alert the user)
 *   - Execute skills (for scheduled tasks)
 *   - Search sessions (for context)
 */
const CRON_ALLOWED: ReadonlySet<string> = new Set([
  // Memory read
  "memory_search",
  "memory_get",
  // Cron read
  "cron_list",
  "cron_get",
  "cron_runs",
  // Messaging (alerts)
  "message",
  // Skill execution (scheduled tasks may need it)
  "skill_read",
  "http_fetch",
  "sandbox_exec",
  "sandbox_file_write",
  "sandbox_file_read",
  "sandbox_file_list",
  "sandbox_skill_load",
  // Web (for scheduled lookups)
  "web_search",
  "web_fetch",
  // Knowledge (scheduled tasks may need reference lookups)
  "knowledge_search",
  // Session awareness
  "session_search",
]);

// ============================================================================
// Policy Application
// ============================================================================

interface ToolLike {
  name: string;
}

/**
 * Filter tool definitions based on session type policy.
 *
 * @param tools - Full set of registered tool definitions.
 * @param sessionType - The session type for this request.
 * @returns Filtered tool definitions (subset or original array).
 */
export function applyToolPolicy<T extends ToolLike>(
  tools: T[],
  sessionType: SessionType,
  hiddenTools?: ReadonlySet<string>,
): T[] {
  let filtered: T[];
  switch (sessionType) {
    case "interactive":
      // Full access — no filtering
      filtered = tools;
      break;

    case "subagent":
      // Block specific write/management tools
      filtered = tools.filter((t) => !SUBAGENT_BLOCKED.has(t.name));
      break;

    case "cron":
      // Allowlist — only explicitly permitted tools
      filtered = tools.filter((t) => CRON_ALLOWED.has(t.name));
      break;

    default:
      filtered = tools;
  }
  // Strip config-level hidden tools (API-only, not exposed to LLM)
  return hiddenTools?.size
    ? filtered.filter((t) => !hiddenTools.has(t.name))
    : filtered;
}

/**
 * Filter tool name strings based on session type policy.
 * Same logic as applyToolPolicy but for name arrays (used for prompt context).
 */
export function filterToolNames(
  names: string[],
  sessionType: SessionType,
  hiddenTools?: ReadonlySet<string>,
): string[] {
  let filtered: string[];
  switch (sessionType) {
    case "interactive":
      filtered = names;
      break;
    case "subagent":
      filtered = names.filter((n) => !SUBAGENT_BLOCKED.has(n));
      break;
    case "cron":
      filtered = names.filter((n) => CRON_ALLOWED.has(n));
      break;
    default:
      filtered = names;
  }
  return hiddenTools?.size
    ? filtered.filter((n) => !hiddenTools.has(n))
    : filtered;
}

// ============================================================================
// Dispatch-time Enforcement
// ============================================================================

/**
 * The model can emit any tool name, including ones the policy hid from it.
 * Returns the tool error to send back when `name` was not offered this turn,
 * or null when the call may run.
 */
export function rejectUnofferedToolCall(
  name: string,
  offeredToolNames: ReadonlySet<string>,
): string | null {
  if (offeredToolNames.has(name)) return null;
  return JSON.stringify({
    error: true,
    message: `Tool "${name}" is not available in this session.`,
  });
}

/**
 * What to do with a call to a tool that has a HITL policy.
 *
 *   - execute: the policy does not gate these arguments.
 *   - suspend: gated, and this request can suspend into the HITL orchestrator.
 *   - deny:    gated, but this request cannot suspend (channels, cron, a
 *              resumed run). Running it would skip the approval, so refuse.
 */
export function hitlGateAction(
  gated: boolean,
  canSuspend: boolean,
): "execute" | "suspend" | "deny" {
  if (!gated) return "execute";
  return canSuspend ? "suspend" : "deny";
}

export const HITL_APPROVAL_UNAVAILABLE = JSON.stringify({
  error: true,
  approvalRequired: true,
  message:
    "This action needs the user's approval, which can only be given in the app. Tell the user to open the app to complete it.",
});
