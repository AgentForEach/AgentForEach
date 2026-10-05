/**
 * AgentForEach HITL Module — recovering forms after a reconnect
 *
 * A form reaches the client once, as an `input_request` event. A client that
 * was offline, or reconnects, asks for it again:
 *
 *   GET /api/hitl/pending  — the user's forms still waiting for an answer, as
 *                            the input_request events that showed them
 *   GET /api/hitl/{id}     — where one request is: pending, answered (and the
 *                            run that continued after it), expired, ...
 *
 * Both read the HITL store, partition-scoped to the signed-in user, so
 * another user's request is simply not found.
 */

import { getAgentClient } from "../shared.js";
import { getHitlStore } from "./authorize.js";
import type { HitlStore } from "./store.js";
import type { HitlRunState, InputRequestPayload } from "./types.js";

/** A form still waiting for an answer: the input_request event that showed it, and when it expires. */
export type PendingInputRequest = InputRequestPayload & { state: "input_request"; expiresAt: string };

/** Where an input request is. `responded` and `cancelled` are the user's answer; `failed`: the run didn't continue after it. */
export interface InputRequestStatus {
  requestId: string;
  status: "pending" | "responded" | "expired" | "cancelled" | "failed";
  sessionId: string;
  runId: string;
  /** When the user's answer was accepted. */
  answeredAt?: string;
  /** The run that continued the conversation after the answer, once it has finished. */
  resumedRunId?: string;
}

type StoreSource = () => Promise<Pick<HitlStore, "get" | "listPending"> | undefined>;

const sharedStore: StoreSource = async () => getHitlStore(await getAgentClient());

/** When a request stops waiting: its creation plus its timeout. */
function expiresAtMs(state: HitlRunState): number {
  return state.createdAt + (state.timeoutSeconds ?? 0) * 1000;
}

/** Waiting for an answer: pending, not yet answered, and not past its timeout. */
function awaitingAnswer(state: HitlRunState, now: number): boolean {
  return state.status === "pending" && !state.answer && expiresAtMs(state) > now;
}

/**
 * The user's forms still waiting for an answer, newest first, each as the
 * input_request event that showed it (so a client renders it the same way).
 * Requests saved before the form was recorded with them are left out.
 * Undefined when no HITL store is configured.
 */
export async function pendingInputRequests(
  userId: string,
  hitlStore: StoreSource = sharedStore,
): Promise<PendingInputRequest[] | undefined> {
  const store = await hitlStore();
  if (!store) return undefined;
  const now = Date.now();
  return (await store.listPending(userId))
    .filter((state) => state.inputRequest && awaitingAnswer(state, now))
    .map((state) => ({
      state: "input_request" as const,
      ...state.inputRequest!,
      expiresAt: new Date(expiresAtMs(state)).toISOString(),
    }));
}

/**
 * Where one of the user's input requests is, or null when the user has no
 * request with this id. Undefined when no HITL store is configured.
 */
export async function inputRequestStatus(
  userId: string,
  requestId: string,
  hitlStore: StoreSource = sharedStore,
): Promise<InputRequestStatus | null | undefined> {
  const store = await hitlStore();
  if (!store) return undefined;
  const state = await store.get(requestId, userId);
  if (!state) return null;
  return {
    requestId: state.requestId,
    status: reportedStatus(state),
    sessionId: state.sessionId,
    runId: state.runId,
    ...(state.answer ? { answeredAt: state.answer.answeredAt } : {}),
    ...(state.resumedRunId ? { resumedRunId: state.resumedRunId } : {}),
  };
}

function reportedStatus(state: HitlRunState): InputRequestStatus["status"] {
  switch (state.status) {
    case "pending":
      // A form nobody answered in time, whose expiry nothing recorded (a form
      // the model raised has no wait to time it out).
      return !state.answer && expiresAtMs(state) <= Date.now() ? "expired" : "pending";
    case "timed_out":
      return "expired";
    default:
      return state.status;
  }
}
