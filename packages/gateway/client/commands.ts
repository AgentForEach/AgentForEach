/**
 * AgentForEach Client Layer — Slash Commands
 *
 * Intercepts slash commands (/new, /reset, /compact) before they reach
 * the LLM pipeline. Commands return a synthetic SendResponse directly,
 * skipping the normal runAgentTurn() flow.
 *
 * Design:
 *   - parseCommand() extracts the command name from the message text
 *   - tryHandleCommand() is called from AgentClient.send() before runAgentTurn()
 *   - Each handler builds and returns a SendResponse
 *   - /new and /reset delete the current session (no LLM call)
 *   - /compact triggers LLM-powered compaction (uses the provider)
 *
 * Hooks emitted:
 *   - "command"          — for every recognized command
 *   - "before_reset"     — before session deletion (awaited for memory extraction)
 *   - "session_end"      — after session deletion
 *   - "before_compaction" / "after_compaction" — around compaction
 */

import { randomUUID } from "node:crypto";
import type { SendRequest, SendResponse, StreamCallback } from "./types.js";
import type { RunnerDeps } from "./runner.js";
import { runCompaction } from "../sessions/index.js";

// ============================================================================
// Command Types
// ============================================================================

/** Recognized slash command names. */
export type SlashCommandName = "new" | "reset" | "compact";

/** Result of parsing a message for a slash command. */
export interface ParsedCommand {
  name: SlashCommandName;
  args: string;
}

/** All recognized commands. */
const COMMAND_NAMES: ReadonlySet<string> = new Set<string>([
  "new",
  "reset",
  "compact",
]);

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a message to check if it's a slash command.
 *
 * Returns the parsed command if the message starts with "/" followed
 * by a recognized command name, or null if it's a regular message.
 *
 * Matching rules:
 *   - Message must start with "/" (after trimming whitespace)
 *   - Command name is case-insensitive
 *   - Everything after the command name (separated by whitespace) is args
 *   - Only exact command names are matched (no prefix matching)
 */
export function parseCommand(message: string): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith("/")) return null;

  // Split on first whitespace: "/compact foo bar" → ["compact", "foo bar"]
  const withoutSlash = trimmed.slice(1);
  const spaceIndex = withoutSlash.search(/\s/);
  const name = (
    spaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, spaceIndex)
  ).toLowerCase();
  const args =
    spaceIndex === -1 ? "" : withoutSlash.slice(spaceIndex + 1).trim();

  if (!COMMAND_NAMES.has(name)) return null;

  return { name: name as SlashCommandName, args };
}

// ============================================================================
// Command Dispatcher
// ============================================================================

/**
 * Try to handle the message as a slash command.
 *
 * Called by AgentClient.send() before runAgentTurn(). Returns a
 * SendResponse if the message was a command, or null if it should
 * proceed through the normal LLM pipeline.
 */
export async function tryHandleCommand(
  request: SendRequest,
  deps: RunnerDeps,
  onStream?: StreamCallback,
): Promise<SendResponse | null> {
  const parsed = parseCommand(request.message);
  if (!parsed) return null;

  const startTime = Date.now();
  const runId = randomUUID();

  // Emit command hook for all recognized commands
  deps.hooks.emit("command", {
    name: parsed.name,
    args: parsed.args,
    userId: request.userId,
    sessionId: request.sessionId,
  });

  try {
    let text: string;

    switch (parsed.name) {
      case "new":
      case "reset":
        text = await handleNewOrReset(request, deps);
        break;
      case "compact":
        text = await handleCompact(request, deps);
        break;
    }

    const response: SendResponse = {
      runId,
      text,
      sessionId: request.sessionId ?? "",
      identity: { name: "Assistant" },
      providerId: deps.provider.id,
      model: deps.defaultModel,
      memoriesRecalled: 0,
      memoryCaptured: false,
      durationMs: Date.now() - startTime,
      status: "completed",
    };

    onStream?.({ type: "done", response });
    return response;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const errorResponse: SendResponse = {
      runId,
      text: "",
      sessionId: request.sessionId ?? "",
      identity: { name: "Assistant" },
      providerId: deps.provider.id,
      model: deps.defaultModel,
      memoriesRecalled: 0,
      memoryCaptured: false,
      durationMs: Date.now() - startTime,
      status: "failed",
      error: errorMessage,
    };

    onStream?.({
      type: "error",
      error: err instanceof Error ? err : new Error(errorMessage),
    });
    return errorResponse;
  }
}

// ============================================================================
// /new and /reset Handler
// ============================================================================

/**
 * Handle /new and /reset commands.
 *
 * Deletes the current session (if sessionId is provided). The next
 * message will auto-create a fresh session via getOrCreate().
 *
 * Emits before_reset (awaited) before deletion to allow memory
 * extraction hooks to complete first.
 */
async function handleNewOrReset(
  request: SendRequest,
  deps: RunnerDeps,
): Promise<string> {
  if (!request.sessionId) {
    return "Session reset. Your next message will start a new conversation.";
  }

  // Load session for the hook event (may be null if already deleted)
  const session = await deps.sessionStore.get(
    request.userId,
    request.sessionId,
  );

  // Await before_reset so memory extraction hooks complete before deletion
  await deps.hooks.emit("before_reset", {
    userId: request.userId,
    sessionId: request.sessionId,
    session,
  });

  await deps.sessionStore.delete(request.userId, request.sessionId);

  deps.hooks.emit("session_end", {
    userId: request.userId,
    sessionId: request.sessionId,
  });

  return "Session reset. Your next message will start a new conversation.";
}

// ============================================================================
// /compact Handler
// ============================================================================

/**
 * Handle /compact command.
 *
 * Force-triggers LLM-powered compaction on the current session,
 * regardless of whether the compaction threshold has been reached.
 *
 * Unlike the runner's fire-and-forget compaction, this awaits
 * completion so the user sees the result.
 */
async function handleCompact(
  request: SendRequest,
  deps: RunnerDeps,
): Promise<string> {
  if (!request.sessionId) {
    return "No active session to compact. Send a message first to start a conversation.";
  }

  const session = await deps.sessionStore.get(
    request.userId,
    request.sessionId,
  );
  if (!session) {
    return "No active session to compact. Send a message first to start a conversation.";
  }

  // Check if there are enough messages to compact
  const config = deps.sessionStore.getConfig();
  const fromSeq = session.lastCompactedSeq ?? 0;
  const retainBoundary = session.messageSeq - config.compactionRetainCount;

  if (retainBoundary <= fromSeq) {
    return `Session has ${session.messageSeq} messages. Not enough to compact yet (need more than ${config.compactionRetainCount} uncompacted messages).`;
  }

  await deps.hooks.emit("before_compaction", { session });

  // Run compaction (makes an LLM call for summarization)
  await runCompaction({
    session,
    provider: deps.provider,
    model: config.compactionModel,
    sessionStore: deps.sessionStore,
    messageStore: deps.sessionStore.getMessageStore(),
    config,
    memoryLayer: deps.memory,
  });

  const compactedCount = retainBoundary - fromSeq;

  deps.hooks.emit("after_compaction", {
    session,
    summary: "(manual compaction)",
    compactedCount,
  });

  return `Compaction complete. Summarized ${compactedCount} messages, retaining the ${config.compactionRetainCount} most recent.`;
}
