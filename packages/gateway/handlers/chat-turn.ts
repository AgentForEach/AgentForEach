/**
 * AgentForEach Gateway — chat turns
 *
 * One place that runs a chat turn for the web/app surfaces (/api/chat and
 * the WebSocket "chat" message), either:
 *
 *   - in the background (default in the cloud with Web PubSub): the handler
 *     starts a ChatTurn orchestration and returns at once; the reply streams
 *     over Web PubSub and lands in the session history. No HTTP request has
 *     to outlive Azure's 230 s front-end limit, a client retry doesn't start
 *     a second run (the orchestration id is derived from the idempotency
 *     key), and an instance recycle doesn't lose the turn.
 *   - in the request (local development, or `"wait": true`): the old
 *     behaviour, with the reply in the HTTP response.
 */

import { createHash, randomUUID } from "node:crypto";
import type { InvocationContext } from "@azure/functions";
import * as df from "durable-functions";

import { getAgentClient } from "../shared.js";
import { sendEventToUser, EVENTS } from "../websocket/index.js";
import { resolveProviderId } from "../websocket/config.js";
import { createCronMutationSignal } from "./cron-signal.js";
import {
  clearActiveRequest,
  registerActiveRequest,
  watchSharedAbort,
  type SharedAbortStore,
} from "./active-request-store.js";
import type { SendRequest, SendResponse } from "../client/types.js";
import { isCloudRuntime, parseEnvBool } from "../utils/index.js";
import { redactId } from "../utils/redact.js";
import { getSharedRateLimiter, rateLimitMessage } from "../ratelimit/index.js";

export const CHAT_TURN_ORCHESTRATION = "ChatTurn";
const CHAT_TURN_ACTIVITY = "RunChatTurn";

/**
 * Refusals from client.send (before the runner) whose `text` is for the
 * user. SESSION_BUSY isn't here: the runner raises it and pushes it itself.
 */
const REFUSAL_CODES = new Set(["RATE_LIMITED", "INSUFFICIENT_CREDITS", "CREDITS_UNAVAILABLE"]);

/** In-request turns finish (or fail cleanly) before Azure's 230 s HTTP limit. */
export const HTTP_RUN_DEADLINE_MS = 215_000;

/** Background turns get most of the function timeout (host.json: 10 min). */
const BACKGROUND_TURN_DEADLINE_MS = 540_000;

/** The serialisable part of a chat request (no signals, callbacks or contexts). */
export type ChatTurnRequest = Pick<
  SendRequest,
  | "userId"
  | "message"
  | "sessionId"
  | "idempotencyKey"
  | "model"
  | "providerId"
  | "temperature"
  | "reasoningEffort"
  | "userTimezone"
  | "channelName"
  | "attachments"
  | "hitlInputResponse"
  | "metadata"
  | "rateLimitChecked"
> & {
  runId: string;
  /** When the handler accepted the message (a stop pressed after this counts). */
  acceptedAtMs?: number;
};

/**
 * Whether turns run in the background. CHAT_ASYNC_TURNS overrides; by
 * default only in the cloud with a real-time provider to deliver the reply.
 */
export function backgroundTurnsEnabled(): boolean {
  return parseEnvBool("CHAT_ASYNC_TURNS", isCloudRuntime() && resolveProviderId() !== "noop");
}

/**
 * Run id, orchestration id and (for a client that sent none) session id for
 * a turn. With an idempotency key all three are derived from it, so a
 * retried request maps onto the run — and the session — already started.
 */
export function chatTurnIds(
  userId: string,
  idempotencyKey?: string,
): { runId: string; instanceId: string; newSessionId: string } {
  if (!idempotencyKey) {
    const runId = randomUUID();
    return { runId, instanceId: `chat-${runId}`, newSessionId: randomUUID() };
  }
  const h = createHash("sha256").update(`${userId}\n${idempotencyKey}`).digest("hex");
  const runId = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return { runId, instanceId: `chat-${h.slice(0, 32)}`, newSessionId: `s-${h.slice(32, 56)}` };
}

/**
 * Count a message against the user's rate limit before a background turn
 * starts, so refused messages cost no orchestration. Returns the refusal,
 * or undefined when the message may go ahead.
 */
export async function refuseIfRateLimited(
  userId: string,
  channelName: string,
): Promise<{ error: "RATE_LIMITED"; message: string; retryAfterSeconds: number } | undefined> {
  const decision = await getSharedRateLimiter().check(userId, channelName);
  if (decision.allowed) return undefined;
  return { error: "RATE_LIMITED", message: rateLimitMessage(decision), retryAfterSeconds: decision.retryAfterSeconds };
}

/**
 * Start the turn in the background. `duplicate` means an orchestration for
 * the same idempotency key is already running: nothing new was started.
 */
export async function startChatTurn(
  context: InvocationContext,
  instanceId: string,
  request: ChatTurnRequest,
): Promise<{ duplicate: boolean }> {
  const client = df.getClient(context);
  const existing = await client.getStatus(instanceId).catch(() => undefined);
  const running =
    existing?.runtimeStatus === df.OrchestrationRuntimeStatus.Running ||
    existing?.runtimeStatus === df.OrchestrationRuntimeStatus.Pending;
  if (running) return { duplicate: true };
  // A completed instance with this id is replaced; the runner then replays
  // the saved reply for the idempotency key instead of calling the model.
  try {
    await client.startNew(CHAT_TURN_ORCHESTRATION, { instanceId, input: request });
  } catch (err) {
    // Two identical requests racing: the other one started it.
    if (/already exists/i.test(err instanceof Error ? err.message : String(err))) return { duplicate: true };
    throw err;
  }
  return { duplicate: false };
}

/**
 * Run one chat turn in this invocation: stop-button wiring (this instance
 * and, through the abort store, any other), then the turn (whose runner
 * pushes "thinking").
 * Returns undefined when the user stopped it.
 */
export async function executeChatTurn(
  context: InvocationContext,
  request: ChatTurnRequest,
  deadlineAt: number,
): Promise<SendResponse | undefined> {
  const { userId } = request;
  const client = await getAgentClient();

  const abortController = new AbortController();
  registerActiveRequest(userId, abortController);
  const { acceptedAtMs, ...sendRequest } = request;
  const stopAbortWatch = watchSharedAbort(
    (client as unknown as { _abortStore?: SharedAbortStore })._abortStore,
    userId,
    abortController,
    // A stop pressed after the message was accepted — possibly while the
    // turn waited to start — still applies.
    new Date(acceptedAtMs ?? Date.now()),
  );

  try {
    const response = await client.send(
      {
        ...sendRequest,
        onCronMutation: createCronMutationSignal(context, userId),
        _invocationContext: context,
        abortSignal: abortController.signal,
        deadlineAt,
      },
      (event: { type: string }) => {
        // Presence of this callback enables runner streaming mode; the
        // runner pushes the stream to Web PubSub itself.
        context.trace(`stream event: ${event.type}`);
      },
    );
    if (response.status === "aborted" || abortController.signal.aborted) return undefined;
    if (response.status === "failed" && response.text && REFUSAL_CODES.has(response.error ?? "")) {
      // Refused before the runner started (so it pushed nothing): tell the
      // client, which may not be waiting on this HTTP response at all.
      await sendEventToUser(userId, EVENTS.CHAT, {
        state: "error",
        runId: request.runId,
        sessionId: request.sessionId,
        error: response.text,
        code: response.error!.toLowerCase(),
        retryable: true,
        ...(response.retryAfterSeconds ? { retryAfterSeconds: response.retryAfterSeconds } : {}),
      }).catch(() => {});
    }
    return response;
  } catch (err) {
    if (abortController.signal.aborted) return undefined;
    throw err;
  } finally {
    stopAbortWatch();
    clearActiveRequest(userId, abortController);
  }
}

// ============================================================================
// Background turn: one orchestration, one activity
// ============================================================================

/**
 * A single activity, not retried: a rerun would call the model again. If
 * the activity fails, the runner has already pushed an error event and the
 * user can resend.
 */
df.app.orchestration(CHAT_TURN_ORCHESTRATION, function* (ctx) {
  const input = ctx.df.getInput() as ChatTurnRequest;
  return yield ctx.df.callActivity(CHAT_TURN_ACTIVITY, input);
});

df.app.activity(CHAT_TURN_ACTIVITY, {
  // HITL approvals start their own orchestration from inside the turn.
  extraInputs: [df.input.durableClient()],
  handler: async (input: unknown, context: InvocationContext) => {
    const request = input as ChatTurnRequest;
    const response = await executeChatTurn(context, request, Date.now() + BACKGROUND_TURN_DEADLINE_MS);
    context.log(
      `chatTurn: user=${redactId(request.userId)} run=${request.runId} ` +
        `status=${response?.status ?? "aborted"} duration=${response?.durationMs ?? 0}ms`,
    );
    return { status: response?.status ?? "aborted", error: response?.error };
  },
});
