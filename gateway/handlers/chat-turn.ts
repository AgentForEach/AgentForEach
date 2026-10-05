/**
 * AgentForEach Gateway — chat turns
 *
 * One place that runs a chat turn for the web/app surfaces (/api/chat and
 * the WebSocket "chat" message), either:
 *
 *   - in the background (default in the cloud with a real-time provider):
 *     the handler starts a ChatTurn durable job and returns at once; the
 *     reply streams over the real-time connection and lands in the session
 *     history. No HTTP request has to outlive a front-end limit (Azure's is
 *     230 s), a client retry doesn't start a second run (the job id is
 *     derived from the idempotency key), and an instance recycle doesn't
 *     lose the turn.
 *   - in the request (local development, or `"wait": true`): the old
 *     behaviour, with the reply in the HTTP response. Not on a host whose
 *     front door cuts requests off sooner than a turn can run
 *     (`HostInfo.maxRequestMs`, API Gateway's 30 s): there turns always run
 *     in the background, and `"wait": true` is refused.
 */

import { createHash, randomUUID } from "node:crypto";
import { effectiveDeadline, type HandlerContext, type JobDefinition } from "@agentforeach/platform";
import { durable, hasDurable } from "../runtime/durable.js";
import { hostInfo } from "../runtime/host.js";

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
import type { AgentClient } from "../client/index.js";
import { classifyRunFailure } from "../client/runner.js";
import { isCloudRuntime, parseEnvBool } from "../utils/index.js";
import { redactId } from "../utils/redact.js";
import { noteInterruptedTurn, turnExecutionId } from "../sessions/interrupted.js";
import {
  chatRunFingerprint,
  chatRunView,
  ChatRunConflictError,
  getChatRunStore,
  reconcileChatRun,
  isRunInProgress,
  type ChatRunOutcome,
  type ChatRunStore,
  type ChatRunView,
} from "../sessions/chat-runs.js";
import { getSharedRateLimiter, rateLimitMessage } from "../ratelimit/index.js";

/** The durable job kind that runs a background chat turn. */
export const CHAT_TURN_KIND = "ChatTurn";

/**
 * Refusals from client.send (before the runner) whose `text` is for the
 * user. SESSION_BUSY isn't here: the runner raises it and pushes it itself.
 */
const REFUSAL_CODES = new Set(["RATE_LIMITED", "INSUFFICIENT_CREDITS", "CREDITS_UNAVAILABLE"]);

/** In-request turns finish (or fail cleanly) before Azure's 230 s HTTP limit. */
export const HTTP_RUN_DEADLINE_MS = 215_000;

/** Background turns get most of the function timeout (host.json: 10 min). */
const BACKGROUND_TURN_DEADLINE_MS = 540_000;

/**
 * A background turn that waited longer than this to start is refused, not
 * run: the user has likely given up on it or resent it, and the shared stop
 * marker (10 min, client/abort-store.ts) must still exist when the turn
 * checks for a Stop pressed while it waited.
 */
export const MAX_QUEUE_WAIT_MS = 5 * 60_000;

const QUEUED_TOO_LONG_MESSAGE = "Your message waited too long to start. Please send it again.";

export { ChatRunConflictError };

/** What a turn reaches outside this module; tests replace it. */
export interface ChatTurnDeps {
  client(): Promise<AgentClient>;
  runs(): ChatRunStore;
  /** Push a chat event to the user's connections. */
  push(userId: string, data: Record<string, unknown>): Promise<unknown>;
}

const defaultDeps: ChatTurnDeps = {
  client: getAgentClient,
  runs: getChatRunStore,
  push: (userId, data) => sendEventToUser(userId, EVENTS.CHAT, data),
};

let deps = defaultDeps;

/** For tests: replace some dependencies, or restore them all (no argument). */
export function setChatTurnDepsForTests(overrides?: Partial<ChatTurnDeps>): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

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

/** Set once the CHAT_ASYNC_TURNS=false warning has been logged. */
let warnedBackgroundForced = false;

/**
 * Whether turns run in the background. CHAT_ASYNC_TURNS overrides; by
 * default only in the cloud with a real-time provider to deliver the reply.
 * Always on a host with `maxRequestMs`, where a turn in the request would be
 * cut off: CHAT_ASYNC_TURNS=false is ignored there, with one warning.
 */
export function backgroundTurnsEnabled(): boolean {
  const configured = parseEnvBool("CHAT_ASYNC_TURNS", isCloudRuntime() && resolveProviderId() !== "noop");
  const { maxRequestMs, platform } = hostInfo();
  if (maxRequestMs === undefined) return configured;
  if (!configured && !warnedBackgroundForced) {
    warnedBackgroundForced = true;
    console.warn(
      `[chat] CHAT_ASYNC_TURNS=false is ignored on ${platform}: requests end after ${maxRequestMs} ms, ` +
        "so chat turns always run in the background.",
    );
  }
  return true;
}

/**
 * Why `"wait": true` (the reply in the HTTP response) can't be served on
 * this host, or undefined when it can.
 */
export function waitUnavailable(): string | undefined {
  const { maxRequestMs } = hostInfo();
  if (maxRequestMs === undefined) return undefined;
  return (
    `"wait": true isn't available on this host: requests end after ${Math.round(maxRequestMs / 1000)} s. ` +
    "Send without it; the reply arrives over the realtime connection and in the session history."
  );
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
  // A user id with a newline in it would make "user\nkey" ambiguous; those
  // (and only those) hash a JSON pair, which never contains a raw newline.
  const material = userId.includes("\n") ? JSON.stringify([userId, idempotencyKey]) : `${userId}\n${idempotencyKey}`;
  const h = createHash("sha256").update(material).digest("hex");
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
 * Record the turn as accepted (sessions/chat-runs.ts), before it runs in the
 * background (`instanceId`, its job) or in this request. Throws
 * ChatRunConflictError when the idempotency key was used for a different
 * request. Any other failure is logged and the turn goes ahead: the status
 * record must not cost the user their message.
 */
export async function acceptChatTurn(
  context: HandlerContext,
  request: ChatTurnRequest,
  instanceId?: string,
): Promise<void> {
  try {
    await deps.runs().prepare({
      runId: request.runId,
      userId: request.userId,
      fingerprint: chatRunFingerprint(request),
      sessionId: request.sessionId,
      instanceId,
      acceptedAtMs: request.acceptedAtMs,
    });
  } catch (err) {
    if (err instanceof ChatRunConflictError) throw err;
    context.warn(`[chat-runs] could not record run=${request.runId} as accepted: ${errorText(err)}`);
  }
}

/**
 * Start the turn in the background. `duplicate` means a job for the same
 * idempotency key is already pending or running: nothing new was started.
 * A finished job with this id is replaced; the runner then replays the saved
 * reply for the idempotency key instead of calling the model.
 */
export async function startChatTurn(
  context: HandlerContext,
  instanceId: string,
  request: ChatTurnRequest,
): Promise<{ duplicate: boolean }> {
  await acceptChatTurn(context, request, instanceId);
  const { started } = await durable().startJob(CHAT_TURN_KIND, request, instanceId);
  return { duplicate: !started };
}

/**
 * The user's run as GET /api/chat/runs/{runId} reports it, or null when
 * the user has no such run. A run still recorded as in progress is checked
 * against its durable job (reconcileChatRun).
 */
export async function getChatRunStatus(userId: string, runId: string): Promise<ChatRunView | null> {
  const run = await deps.runs().get(userId, runId);
  if (!run) return null;
  const durableStatus =
    run.instanceId && isRunInProgress(run.status) && hasDurable()
      ? await durable()
          .status(run.instanceId)
          .then((info) => info?.status ?? null, () => undefined)
      : undefined;
  return chatRunView(reconcileChatRun(run, { durableStatus, inRequestLimitMs: HTTP_RUN_DEADLINE_MS }));
}

/** Record the run's status; a failed write is logged, never fails the turn. */
async function recordRun(
  context: HandlerContext,
  request: ChatTurnRequest,
  outcome: ChatRunOutcome | "running",
): Promise<void> {
  const runs = deps.runs();
  await (outcome === "running"
    ? runs.begin(request.userId, request.runId)
    : runs.finish(request.userId, request.runId, outcome)
  ).catch((err) =>
    context.warn(
      `[chat-runs] could not record run=${request.runId} as ${outcome === "running" ? outcome : outcome.status}: ${errorText(err)}`,
    ),
  );
}

/**
 * Run a turn that doesn't go through executeChatTurn (a HITL form's
 * continuation, hitl/orchestrator.ts) under a status record of its own:
 * accepted and running before `send`, then how it ended. `instanceId` is the
 * durable instance the turn runs in, so a reader can tell a turn still
 * running from one that was cut off. A failed write is logged, never fails
 * the turn.
 */
export async function trackChatRun(
  run: { runId: string; userId: string; sessionId?: string; message: string; instanceId?: string },
  warn: (message: string) => void,
  send: () => Promise<SendResponse>,
): Promise<SendResponse> {
  const note = (what: string) => (err: unknown) => warn(`[chat-runs] could not record run=${run.runId} as ${what}: ${errorText(err)}`);
  let runs: ChatRunStore;
  try {
    runs = deps.runs();
  } catch (err) {
    note("running")(err); // no store (no database configured): the turn runs unrecorded
    return send();
  }
  await runs
    .prepare({ runId: run.runId, userId: run.userId, fingerprint: chatRunFingerprint(run), sessionId: run.sessionId, instanceId: run.instanceId })
    .then(() => runs.begin(run.userId, run.runId))
    .catch(note("running"));
  let response: SendResponse;
  try {
    response = await send();
  } catch (err) {
    const { code, retryable } = classifyRunFailure(err);
    await runs.finish(run.userId, run.runId, { status: "failed", error: code, retryable }).catch(note("failed"));
    throw err;
  }
  const outcome = outcomeOf(response);
  await runs.finish(run.userId, run.runId, outcome).catch(note(outcome.status));
  return response;
}

/** How a turn that returned a response ended, for its status record. */
function outcomeOf(response: SendResponse): ChatRunOutcome {
  const sessionId = response.sessionId || undefined;
  if (response.status !== "failed") return { status: response.status, sessionId };
  // Refusals carry their code; anything else, the runner's classification.
  if (response.error && (REFUSAL_CODES.has(response.error) || response.error === "SESSION_BUSY")) {
    return { status: "failed", error: response.error.toLowerCase(), retryable: true, sessionId };
  }
  const { code, retryable } = classifyRunFailure(response.error ?? "");
  return { status: "failed", error: code, retryable, sessionId };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one chat turn in this invocation: stop-button wiring (this instance
 * and, through the abort store, any other), then the turn (whose runner
 * pushes "thinking").
 * Returns undefined when the user stopped it.
 */
export async function executeChatTurn(
  context: HandlerContext,
  request: ChatTurnRequest,
  deadlineAt: number,
  executionId?: string,
): Promise<SendResponse | undefined> {
  const { userId } = request;
  const client = await deps.client();

  const abortController = new AbortController();
  registerActiveRequest(userId, abortController);
  const { acceptedAtMs, ...sendRequest } = request;
  const abortStore = (client as unknown as { _abortStore?: SharedAbortStore })._abortStore;
  // A stop pressed after the message was accepted — possibly while the
  // turn waited to start — still applies.
  const stopsSince = new Date(acceptedAtMs ?? Date.now());
  const stopAbortWatch = watchSharedAbort(abortStore, userId, abortController, stopsSince);

  await recordRun(context, request, "running");
  // Undefined returns below are stops.
  let outcome: ChatRunOutcome = { status: "aborted" };
  try {
    // The watcher's first look is seconds away, with the model already
    // running: a Stop pressed while the turn waited is honoured here.
    if (acceptedAtMs !== undefined && (await abortStore?.consumePendingAbort(userId, stopsSince).catch(() => false))) {
      context.log(`chatTurn: run=${request.runId} was stopped before it started`);
      abortController.abort();
      return undefined;
    }
    const response = await client.send(
      {
        ...sendRequest,
        executionId,
        onCronMutation: createCronMutationSignal(context, userId),
        // A turn run here may pause for a HITL form (a durable wait).
        canSuspendForInput: true,
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
    outcome = outcomeOf(response);
    if (response.status === "failed" && response.text && REFUSAL_CODES.has(response.error ?? "")) {
      // Refused before the runner started (so it pushed nothing): tell the
      // client, which may not be waiting on this HTTP response at all.
      await deps.push(userId, {
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
    const { code, retryable } = classifyRunFailure(err);
    outcome = { status: "failed", error: code, retryable };
    throw err;
  } finally {
    stopAbortWatch();
    clearActiveRequest(userId, abortController);
    await recordRun(context, request, outcome);
  }
}

// ============================================================================
// Background turn: one durable job
// ============================================================================

/**
 * Not retried: a rerun would call the model again. If the turn fails, the
 * runner has already pushed an error event and the user can resend.
 *
 * A host may still run the turn again when the first run was cut off (a
 * restart or a deploy mid-turn). The model and the turn's tools have run
 * part-way, and running them again could repeat their side effects, so a
 * re-run tells the user to resend instead. The user is there to see it; a
 * channel turn, whose user may not be, re-runs instead (channel-webhook.ts).
 *
 * A turn that waited in the queue longer than MAX_QUEUE_WAIT_MS isn't run
 * either: the user is told to resend, as for a refusal.
 */
export const chatTurnJob: JobDefinition<ChatTurnRequest> = {
  kind: CHAT_TURN_KIND,
  async run(request, context) {
    if ((context.attempt ?? 1) > 1) {
      context.warn(`chatTurn: run=${request.runId} was interrupted; asking the user to resend (attempt ${context.attempt})`);
      await noteInterruptedTurn(request, context);
      await recordRun(context, request, { status: "interrupted", error: "interrupted", retryable: true });
      return;
    }
    const waitedMs = request.acceptedAtMs === undefined ? 0 : Date.now() - request.acceptedAtMs;
    if (waitedMs > MAX_QUEUE_WAIT_MS) {
      context.warn(`chatTurn: run=${request.runId} waited ${Math.round(waitedMs / 1000)}s to start; refusing it`);
      await deps.push(request.userId, {
        state: "error",
        runId: request.runId,
        sessionId: request.sessionId,
        error: QUEUED_TOO_LONG_MESSAGE,
        code: "queued_too_long",
        retryable: true,
      }).catch(() => {});
      await recordRun(context, request, { status: "failed", error: "queued_too_long", retryable: true });
      return;
    }
    const response = await executeChatTurn(
      context,
      request,
      effectiveDeadline(BACKGROUND_TURN_DEADLINE_MS, context),
      turnExecutionId(context),
    );
    context.log(
      `chatTurn: user=${redactId(request.userId)} run=${request.runId} ` +
        `status=${response?.status ?? "aborted"} duration=${response?.durationMs ?? 0}ms`,
    );
  },
};
