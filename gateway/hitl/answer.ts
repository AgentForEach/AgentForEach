/**
 * AgentForEach HITL Module — answering an input request
 *
 * A form reaches the user in one of two ways, and is answered accordingly:
 *
 * - A gated tool's form (an MCP tool that asks before it runs) parks the run
 *   in a durable wait, `hitl-<requestId>`. The answer is the event that wait
 *   is waiting for; the wait resumes the run.
 * - A form the model raised itself (request_user_input, a browser handoff)
 *   has no wait: the next chat turn carries the answer and resumes the exact
 *   response that asked (the runner's direct-input path).
 *
 * Every client path that carries an answer — a realtime `input_response`
 * frame, or a chat request with `hitlInputResponse` — goes through
 * `answerInputRequest`, so both kinds of form can be answered from either.
 * It saves the answer on the request before delivering it, so a retry is
 * safe and a second, different answer is refused (`conflict`, HTTP 409).
 */

import { isActive, type HandlerContext } from "@agentforeach/platform";
import { durable } from "../runtime/durable.js";
import { getAgentClient } from "../shared.js";
import { isBrowserHandoffCall } from "../skills/browser/handler.js";
import { getHitlStore } from "./authorize.js";
import type { HitlStore } from "./store.js";
import { REQUEST_USER_INPUT_TOOL_NAME } from "./tool.js";
import { HITL_INPUT_EVENT, type HitlAnswer, type HitlRunState, type InputResponse } from "./types.js";

export interface InputAnswer {
  requestId: string;
  data?: Record<string, unknown>;
  cancelled?: boolean;
}

/**
 * - `resumed`: a gated tool's wait received the answer and resumes the run.
 * - `direct`: a form the model raised; the chat turn that carries the answer resumes it.
 * - `conflict`: the request was already answered, differently.
 * - `not_found`: no pending request of this user's with this id (answered, timed out, or never existed).
 * - `unavailable`: no HITL store is configured.
 *
 * The same answer sent again gets the outcome the first one got.
 */
export type AnswerOutcome = "resumed" | "direct" | "conflict" | "not_found" | "unavailable";

/** A paused call the user answers through a form, resuming this exact response (request_user_input, a browser handoff). */
export function isDirectInputCall(call: { name: string; arguments?: Record<string, unknown> }): boolean {
  return call.name === REQUEST_USER_INPUT_TOOL_NAME || isBrowserHandoffCall(call);
}

/** JSON with object keys sorted, so two answers compare by content. */
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, (item as Record<string, unknown>)[key]]))
      : item,
  );
}

/** Whether two answers say the same thing (their data and whether they cancel). */
export function sameAnswer(a: Pick<HitlAnswer, "data" | "cancelled">, b: Pick<HitlAnswer, "data" | "cancelled">): boolean {
  return a.cancelled === b.cancelled && fingerprint(a.data) === fingerprint(b.data);
}

/** The wait took the answer and resumed (or tried to resume) the run. */
function resumedAlready(state: HitlRunState): boolean {
  return state.status === "responded" || state.status === "cancelled" || state.status === "failed";
}

/**
 * Deliver `answer` to the request it answers. Only the owner of a pending
 * request may answer it: the answer resumes the run as that user, with this
 * data merged into the tool call. The store read is partition-scoped to
 * `userId`, so another user's request is simply not found.
 *
 * The answer is saved on the request before it is delivered, and the first
 * answer is the one that counts: a retry with the same answer is accepted
 * again (and delivered again only while the wait hasn't taken it), a
 * different answer is a conflict, and the resume reads the saved answer.
 */
export async function answerInputRequest(
  userId: string,
  answer: InputAnswer,
  context: HandlerContext,
  hitlStore: () => Promise<Pick<HitlStore, "get" | "transition"> | undefined> = async () => getHitlStore(await getAgentClient()),
): Promise<AnswerOutcome> {
  const store = await hitlStore();
  if (!store) return "unavailable";
  const given = { data: answer.data ?? {}, cancelled: answer.cancelled ?? false };
  let verdict = "closed" as "saved" | "same" | "conflict" | "closed";
  const result = await store.transition(answer.requestId, userId, (state) => {
    if (state.answer) {
      verdict = sameAnswer(state.answer, given) ? "same" : "conflict";
      return undefined;
    }
    if (state.status !== "pending") {
      verdict = "closed";
      return undefined;
    }
    verdict = "saved";
    return { ...state, answer: { ...given, answeredAt: new Date().toISOString() } };
  });
  if (!result || verdict === "closed") return "not_found";
  if (verdict === "conflict") return "conflict";
  const { state } = result;
  if (isDirectInputCall(state.pendingToolCall)) return "direct";
  if (resumedAlready(state)) return "resumed";
  if (state.status !== "pending") return "not_found";
  const delivered = await durable().signal(`hitl-${answer.requestId}`, HITL_INPUT_EVENT, {
    requestId: answer.requestId,
    data: state.answer!.data,
    cancelled: state.answer!.cancelled,
  } satisfies InputResponse);
  if (delivered) return "resumed";
  // A retry can find the wait just finished with the first delivery.
  const now = await store.get(answer.requestId, userId);
  if (now && resumedAlready(now)) return "resumed";
  // Refused because the wait is firing its timeout: the timeout resumes with
  // the saved answer (hitlWait.onTimeout), so it still counts.
  if (now?.status === "pending" && now.answer && isActive((await durable().status(`hitl-${answer.requestId}`))?.status)) {
    return "resumed";
  }
  context.warn(`[hitl] the wait for request ${answer.requestId} isn't running`);
  return "not_found";
}
