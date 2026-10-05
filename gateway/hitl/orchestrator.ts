/**
 * AgentForEach HITL Module — the durable wait for a user's answer
 *
 * Implements the "fire and leave, resume on response" pattern with a
 * durable wait (see `@agentforeach/platform`'s Durable port).
 *
 * Flow:
 *   1. Runner hits a HITL-gated tool call
 *   2. Runner saves state → starts the HitlAwaitInput wait → returns
 *      (the invocation exits, resources freed)
 *   3. The wait's start pushes the form to the client
 *   4. The wait sleeps until the "hitl_input_response" event or the
 *      timeout, at no compute cost
 *   5. User fills form → the client-event handler signals the wait
 *   6. The wait wakes → resumes the run: loads the saved state, merges the
 *      user's input, executes the tool, feeds the result back to the LLM
 *      and finishes the remaining run
 *
 * One-shot: the wait completes after the answer or the timeout.
 */

import { randomUUID } from "node:crypto";
import { effectiveDeadline, type HandlerContext, type WaitDefinition } from "@agentforeach/platform";
import type {
  InputRequest,
  InputResponse,
  HitlRunState,
  HitlWaitInput,
} from "./types.js";
import { HITL_INPUT_EVENT, HITL_ORCHESTRATION_NAME } from "./types.js";
import { sendEventToUser, EVENTS } from "../websocket/index.js";
import { getAgentClient } from "../shared.js";
import { handleMcpToolCall } from "../mcp/index.js";
import { REQUEST_USER_INPUT_TOOL_NAME } from "./tool.js";
import type { SessionStore, SessionMessage } from "../sessions/index.js";
import { getHitlStore } from "./authorize.js";
import type { HitlStore } from "./store.js";
import { redactId } from "../utils/redact.js";
import { noteInterruptedTurn, turnExecutionId } from "../sessions/interrupted.js";
import { DEFAULT_RUN_DEADLINE_MS } from "../client/runner.js";


/** Waits between resume attempts while the session is busy (~2.5 min total). */
const RESUME_BUSY_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000];
// ============================================================================
// Start: Push Input Request to Client
// ============================================================================

/** Pushes the input_request event to the user's connected clients. */
export async function pushInputRequest(input: {
  inputRequest: InputRequest;
  userId: string;
}): Promise<{ pushed: boolean }> {
  try {
    await sendEventToUser(input.userId, EVENTS.CHAT, {
      state: "input_request",
      ...input.inputRequest,
    });
    return { pushed: true };
  } catch (err) {
    console.error(
      `[hitl] Failed to push input_request to user=${redactId(input.userId)}:`,
      err instanceof Error ? err.message : err,
    );
    return { pushed: false };
  }
}

// ============================================================================
// Event: Resume the Agent Run After User Input
// ============================================================================

/**
 * Resumes the agent runner after the user provides input.
 *
 * Loads the saved HitlRunState from the HITL store, merges the user's
 * data into the pending tool call args, executes the MCP tool, then
 * feeds the result back to the LLM to continue the conversation.
 *
 * This effectively picks up execution from the exact point where the
 * runner paused — mid-tool-loop.
 */
export async function resumeAfterInput(input: {
  requestId: string;
  userId: string;
  response: InputResponse;
  /** The durable execution resuming (see `SendRequest.executionId`). */
  executionId?: string;
  /** The invocation resuming it: the resumed turn ends by its `deadlineAt`. */
  context?: Pick<HandlerContext, "deadlineAt">;
}): Promise<{ success: boolean; error?: string }> {
  console.log(
    `[hitl] Resume STARTED — request=${input.requestId} user=${redactId(input.userId)} ` +
      `cancelled=${input.response.cancelled} dataKeys=${Object.keys(input.response.data ?? {}).join(",")}`,
  );
  try {
    const client = await getAgentClient();
    console.log(`[hitl] Resume — client obtained`);

    // Load the saved run state from the HITL store
    const hitlStore = getHitlStore(client);
    if (!hitlStore) {
      console.error(`[hitl] Resume — HITL store not available`);
      return { success: false, error: "HITL store not available" };
    }

    const runState: HitlRunState | null = await hitlStore.get(
      input.requestId,
      input.userId,
    );

    if (!runState) {
      console.error(`[hitl] Resume — no pending HITL request: ${input.requestId}`);
      return {
        success: false,
        error: `No pending HITL request: ${input.requestId}`,
      };
    }

    console.log(
      `[hitl] Resume — loaded runState: status=${runState.status} ` +
        `tool=${runState.pendingToolCall.name} session=${redactId(runState.sessionId)}`,
    );

    // The answer saved when the user sent it is the one that counts, not the
    // event that delivered it (a re-delivered event can't change it).
    const response = resumeAnswer(runState, input.response);

    // Claim the request: only one resume moves it out of pending.
    const claimed = await hitlStore.updateStatus(
      input.requestId,
      input.userId,
      response.cancelled ? "cancelled" : "responded",
    );
    if (!claimed) {
      console.error(`[hitl] Resume — request ${input.requestId} is no longer pending (status was ${runState.status})`);
      return {
        success: false,
        error: `HITL request ${input.requestId} is not pending`,
      };
    }
    console.log(`[hitl] Resume — marked as ${response.cancelled ? "cancelled" : "responded"}`);

    let resumedRunId: string | undefined;
    if (response.cancelled) {
      // User cancelled — tell the LLM the tool call was cancelled
      console.log(`[hitl] Resume — user cancelled, resuming with cancel message`);
      resumedRunId = await resumeRunWithResult(
        client,
        runState,
        "User cancelled this action.",
        input.executionId,
        input.context,
      );
    } else if (runState.pendingToolCall.name === REQUEST_USER_INPUT_TOOL_NAME) {
      // request_user_input: the user's response IS the tool result.
      // No MCP tool to execute — return the user's data directly to the LLM.
      const toolResult = JSON.stringify({
        ok: true,
        userInput: response.data,
      });
      console.log(`[hitl] Resume — request_user_input, toolResult=${toolResult}`);
      resumedRunId = await resumeRunWithResult(client, runState, toolResult, input.executionId, input.context);
    } else {
      // Regular HITL-gated MCP tool: merge user data with LLM args, then execute
      const mergedArgs = {
        ...runState.pendingToolCall.arguments,
        ...response.data,
      };

      // Execute the actual MCP tool with the merged args
      const mcpManager = (client as any)._mcpManager;
      let toolResult: string;

      try {
        toolResult = await handleMcpToolCall(
          runState.pendingToolCall.name,
          mergedArgs,
          mcpManager,
          input.userId,
        );
      } catch (err) {
        toolResult = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Resume the run with the tool result
      resumedRunId = await resumeRunWithResult(client, runState, toolResult, input.executionId, input.context);
    }

    await recordContinuation(hitlStore, input.requestId, input.userId, resumedRunId);
    console.log(`[hitl] Resume COMPLETED — request=${input.requestId}`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[hitl] Resume FAILED: ${msg}`);
    if (stack) console.error(`[hitl] Resume stack:`, stack);
    return { success: false, error: msg };
  }
}

/**
 * The answer a resume acts on: the one saved on the request when the user
 * sent it (hitl/answer.ts), or, for a request answered before answers were
 * saved, the delivered event.
 */
export function resumeAnswer(runState: HitlRunState, delivered: InputResponse): InputResponse {
  const saved = runState.answer;
  return saved ? { requestId: runState.requestId, data: saved.data, cancelled: saved.cancelled } : delivered;
}

/**
 * Record how the answer's continuation ended, for `GET /api/hitl/{id}`: the
 * run that continued the conversation, or `failed` when there is none.
 * Best effort; the run itself is unaffected.
 */
async function recordContinuation(
  hitlStore: Pick<HitlStore, "transition">,
  requestId: string,
  userId: string,
  resumedRunId: string | undefined,
): Promise<void> {
  try {
    await hitlStore.transition(requestId, userId, (state) =>
      state.resumedRunId ? undefined : resumedRunId ? { ...state, resumedRunId } : { ...state, status: "failed" },
    );
  } catch (err) {
    console.warn(
      `[hitl] Failed to record the continuation of request=${requestId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Resume the LLM conversation with the tool result from the HITL interaction.
 *
 * Uses the shared session infrastructure (SessionStore) and client pipeline
 * (client.send → runAgentTurn) rather than rebuilding context manually:
 *
 *   1. Saves the tool execution result to the session via SessionStore.appendMessages()
 *   2. Clears session.conversationState.previousResponseId so the runner sends
 *      full conversation history (the HITL interruption broke the response chain —
 *      the LLM's last response had pending tool calls that were resolved outside
 *      the Responses API chain)
 *   3. Calls client.send() in "continuation mode" (_hitlContinuation metadata flag).
 *      The runner loads the session (which now includes the tool result), sends a
 *      transient continuation prompt to the LLM, and persists ONLY the assistant
 *      response — no synthetic user message is saved to the session.
 *
 * The LLM sees: original user message → tool execution result → continuation prompt
 * — the first two from session history, the prompt is transient (never persisted).
 */
/**
 * History entries for the tool calls that ran alongside the paused one (the
 * runner saves their results when it suspends), so the model sees they ran.
 */
export function siblingResultMessages(runState: HitlRunState, timestamp: string): SessionMessage[] {
  return (runState.completedToolResults ?? []).map((r) => ({
    role: "assistant" as const,
    content: `[${r.name ?? "tool"}] ${r.output}`,
    timestamp,
    runId: runState.runId,
  }));
}

/** Returns the continuation's run id, or undefined when it failed. */
async function resumeRunWithResult(
  client: any,
  runState: HitlRunState,
  toolResult: string,
  executionId?: string,
  context: Pick<HandlerContext, "deadlineAt"> = {},
): Promise<string | undefined> {
  const { originalRequest, pendingToolCall } = runState;
  const sessionId = originalRequest.sessionId ?? runState.sessionId;
  const sessionStore = (client as any)._sessionStore as SessionStore | undefined;

  console.log(
    `[hitl] resumeRunWithResult — session=${redactId(sessionId)} tool=${pendingToolCall.name} ` +
      `resultLen=${toolResult.length} hasSessionStore=${!!sessionStore}`,
  );

  // Step 1: Save the tool execution result to the session as an assistant message.
  // This uses the shared SessionStore — the same module that handles all
  // session persistence in the runner pipeline (Step 8 of runAgentTurn).
  if (sessionStore) {
    try {
      const now = new Date().toISOString();
      const toolResultMessage: SessionMessage = {
        role: "assistant",
        content:
          `[${pendingToolCall.name}] ${toolResult}`,
        timestamp: now,
        runId: runState.runId,
      };

      // Save the tool result AND clear the response chain in one call.
      // The HITL interruption broke the Responses API chain — the last
      // chained response has an unresolved tool call. Clearing forces the
      // runner to send full conversation history on resume, giving the LLM
      // complete context including the tool result we just saved.
      await sessionStore.appendMessages(
        originalRequest.userId,
        sessionId,
        [...siblingResultMessages(runState, now), toolResultMessage],
        null, // ← clear previousResponseId — chain is broken by HITL
      );
    } catch (err) {
      // Non-fatal — the continuation message below also carries the tool result
      console.warn(
        `[hitl] Failed to persist tool result to session=${redactId(sessionId)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Step 2: Resume via client.send() — the standard runner pipeline.
  // The runner will: load the session → load message history (which now
  // includes user's original message + our tool result) → build system
  // prompt → call LLM → persist response → push WS.
  //
  // Since we cleared previousResponseId, the runner includes full
  // conversation history in the LLM request (no stale response chain).
  //
  // The _hitlContinuation metadata flag tells the runner this is a
  // continuation — the transient message below is only seen by the LLM
  // (never persisted to the session), and the runner skips link resolution,
  // memory recall/capture, and knowledge recall for this turn.
  console.log(
    `[hitl] resumeRunWithResult — calling client.send() user=${redactId(originalRequest.userId)} ` +
      `session=${redactId(sessionId)} channel=${originalRequest.channelName}`,
  );
  try {
    // The user may have sent a new message after answering; the session is
    // then busy for that turn. Wait for it rather than dropping the answer.
    // Each attempt is a run of its own, with a status record (GET
    // /api/chat/runs/{runId}): a fresh id per attempt, since a busy session
    // refuses the attempt after its credits were reserved under that id.
    // Loaded lazily: chat-turn reaches this module through the runner.
    const { trackChatRun } = await import("../handlers/chat-turn.js");
    const message = "Continue the conversation naturally based on the tool execution result in the conversation history.";
    const request = {
      userId: originalRequest.userId,
      agentId: originalRequest.agentId,
      message,
      sessionId,
      providerId: originalRequest.providerId,
      model: originalRequest.model,
      reasoningEffort: originalRequest.reasoningEffort,
      temperature: originalRequest.temperature,
      channelName: originalRequest.channelName,
      userTimezone: originalRequest.userTimezone,
      idempotencyKey: `hitl-resume-${runState.requestId}`,
      executionId,
      deadlineAt: effectiveDeadline(DEFAULT_RUN_DEADLINE_MS, context),
      metadata: {
        ...originalRequest.metadata,
        _hitlContinuation: "true",
        _hitlRequestId: runState.requestId,
      },
      scheduled: true,
    };
    const send = () => {
      const runId = randomUUID();
      return trackChatRun(
        { runId, userId: request.userId, sessionId, message, instanceId: `hitl-${runState.requestId}` },
        (m) => console.warn(m),
        // No explicit stream callback — the runner auto-pushes to WebSocket
        // via realtimeEnabled + sendEventToUser (shared websocket module).
        () => client.send({ ...request, runId }),
      );
    };
    let response = await send();
    for (const waitMs of RESUME_BUSY_BACKOFF_MS) {
      if (response.error !== "SESSION_BUSY") break;
      await new Promise((r) => setTimeout(r, waitMs));
      response = await send();
    }

    console.log(
      `[hitl] Resumed run=${runState.runId} session=${redactId(sessionId)} ` +
        `result_status=${response.status} textLen=${response.text?.length ?? 0}`,
    );
    return response.status === "failed" ? undefined : response.runId;
  } catch (err) {
    console.error(
      `[hitl] Failed to resume run=${runState.runId}:`,
      err instanceof Error ? err.message : err,
    );

    // Best effort: notify the user via shared websocket module
    try {
      await sendEventToUser(originalRequest.userId, EVENTS.CHAT, {
        state: "error",
        runId: runState.runId,
        sessionId,
        error: "Failed to resume after your input. Please try again.",
      });
    } catch {
      // Non-fatal
    }
    return undefined;
  }
}

// ============================================================================
// Timeout: Expire the Request (no LLM call)
// ============================================================================

/**
 * Handles a timed-out HITL request WITHOUT calling the LLM.
 *
 * When the timeout passes before the answer arrives, this:
 *   1. Marks the request as "timed_out" in the HITL store
 *   2. Persists the user's original message + a brief assistant note
 *      to the session so the conversation has context when the user returns
 *   3. Sends an "input_expired" WebSocket event so the client can dismiss
 *      the form
 *
 * Critically: does NOT call client.send() — zero LLM calls, zero loops.
 * When the user sends their next message in the same chat, the session
 * history has full context and the LLM can re-trigger HITL if needed.
 */
export async function expireInputRequest(input: {
  requestId: string;
  userId: string;
}): Promise<{ success: boolean; error?: string; answered?: boolean }> {
  try {
    const client = await getAgentClient();
    const hitlStore = getHitlStore(client);
    const sessionStore = (client as any)._sessionStore as SessionStore | undefined;

    if (!hitlStore) {
      return { success: false, error: "HITL store not available" };
    }

    // Load the run state to get session context
    const runState: HitlRunState | null = await hitlStore.get(
      input.requestId,
      input.userId,
    );

    if (!runState) {
      return { success: false, error: `No HITL request: ${input.requestId}` };
    }

    // 1. Mark as timed_out in store: only a pending request nobody answered.
    //    One no longer pending was resolved in time, and an answer saved
    //    before the deadline wins (`answered`: the caller resumes with it).
    const expired = await hitlStore.transition(input.requestId, input.userId, (state) =>
      state.status === "pending" && !state.answer ? { ...state, status: "timed_out" } : undefined,
    );
    if (!expired?.updated) {
      return { success: true, answered: expired?.state.status === "pending" && !!expired.state.answer };
    }

    // 2. Persist a brief timeout note to the session so the user
    //    has context when they return. The original user message was
    //    already persisted when the runner suspended.
    if (sessionStore) {
      try {
        const toolName = runState.pendingToolCall.name;
        const now = new Date().toISOString();
        const timeoutMessage: SessionMessage = {
          role: "assistant",
          content:
            `I was preparing to use "${toolName}" and sent you an input form, ` +
            `but it timed out before you responded. No worries — just let me know ` +
            `when you'd like to continue and I'll pick up where we left off.`,
          timestamp: now,
          runId: runState.runId,
        };
        await sessionStore.appendMessages(
          input.userId,
          runState.sessionId,
          [...siblingResultMessages(runState, now), timeoutMessage],
        );
      } catch (err) {
        // Non-fatal — session persistence failure shouldn't block cleanup
        console.warn(
          `[hitl] Failed to persist timeout note to session=${redactId(runState.sessionId)}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // 3. Notify the client so it can dismiss the input form
    try {
      await sendEventToUser(input.userId, EVENTS.CHAT, {
        state: "input_expired",
        requestId: input.requestId,
        runId: runState.runId,
        sessionId: runState.sessionId,
        reason: "The input form timed out. You can continue the conversation whenever you're ready.",
      });
    } catch (err) {
      // Non-fatal
      console.warn(
        `[hitl] Failed to push input_expired to user=${redactId(input.userId)}:`,
        err instanceof Error ? err.message : err,
      );
    }

    console.log(
      `[hitl] Timeout: request=${input.requestId} session=${redactId(runState.sessionId)} — ` +
        `no LLM call, session preserved for next user message`,
    );

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[hitl] Timeout activity failed: ${msg}`);
    return { success: false, error: msg };
  }
}

// ============================================================================
// The wait
// ============================================================================

/**
 * Waits for the user's answer to a HITL form, or the timeout. Each handler
 * logs and absorbs its own failures, so a failed resume doesn't fail the
 * wait (the user is told, and can ask again).
 */
export const hitlWait: WaitDefinition<HitlWaitInput, InputResponse> = {
  kind: HITL_ORCHESTRATION_NAME,
  event: HITL_INPUT_EVENT,
  async start(input) {
    if (input.inputRequest) await pushInputRequest({ inputRequest: input.inputRequest, userId: input.userId });
  },
  async onEvent(input, response, context) {
    // The resumed turn was cut off and is being run again: the answer was
    // already marked responded and the tool may have run, so don't resume
    // a second time; tell the user instead (sessions/interrupted.ts).
    if ((context.attempt ?? 1) > 1) {
      const hitlStore = getHitlStore(await getAgentClient());
      const runState = await hitlStore?.get(input.requestId, input.userId);
      if (hitlStore) await recordContinuation(hitlStore, input.requestId, input.userId, undefined);
      context.warn(`[hitl] resume of request=${input.requestId} was interrupted; asking the user to resend`);
      await noteInterruptedTurn(
        {
          userId: input.userId,
          // The session the resume ran in (resumeRunWithResult).
          sessionId: runState?.originalRequest.sessionId ?? runState?.sessionId,
          runId: runState?.runId ?? input.requestId,
        },
        context,
      );
      return;
    }
    // resumeAfterInput acts on the answer saved with the request, if there is
    // one, rather than `response` (resumeAnswer).
    await resumeAfterInput({
      requestId: input.requestId,
      userId: input.userId,
      response,
      executionId: turnExecutionId(context),
      context,
    });
  },
  async onTimeout(input, context) {
    const expired = await expireInputRequest({ requestId: input.requestId, userId: input.userId });
    // The user answered before the deadline, but the signal lost the race
    // with this timeout: the saved answer wins, resumed as onEvent would.
    if (expired.answered) {
      context.log(`[hitl] request=${input.requestId} timed out with a saved answer; resuming with it`);
      await hitlWait.onEvent(
        input,
        { requestId: input.requestId, data: {}, cancelled: false }, // replaced by the saved answer (resumeAnswer)
        context,
      );
    }
  },
};
