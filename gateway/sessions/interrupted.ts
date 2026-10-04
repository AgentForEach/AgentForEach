/**
 * AgentForEach Sessions — a turn that was cut off
 *
 * When a host runs a background turn again because its first run was cut
 * off (a restart or a deploy mid-turn), the turn isn't run again: the model
 * and its tools already ran part-way. Instead the user is told, and the
 * session is given back:
 *
 * - a note in the session history, so the user sees it even if they missed
 *   the live event (a deploy also drops WebSocket connections, and pushes
 *   aren't replayed);
 * - a live "interrupted" error event, for a client that's connected;
 * - the cut-off run's session lease is released, so the user can resend at
 *   once instead of waiting for it to expire.
 *
 * The turn finds its lease by the execution id it ran under
 * (`turnExecutionId`): a lease is released only if an earlier run of the
 * same durable instance took it, never one a newer turn holds.
 */

import type { DurableContext, HandlerContext } from "@agentforeach/platform";
import { getAgentClient } from "../shared.js";
import { sendEventToUser, EVENTS } from "../websocket/index.js";
import { redactId } from "../utils/redact.js";
import type { SessionStore } from "./store.js";

export const INTERRUPTED_MESSAGE = "Your message was interrupted before the reply finished. Please send it again.";

/** How far back to look for a note an earlier re-run already wrote. */
const NOTE_LOOKBACK = 20;

/**
 * The execution id a durable handler runs a turn under (`SendRequest.executionId`):
 * its instance and attempt. Unset where the host doesn't count attempts,
 * since it never re-runs a handler there.
 */
export function turnExecutionId(context: HandlerContext): string | undefined {
  const { instanceId, attempt } = context as Partial<DurableContext>;
  return instanceId && attempt !== undefined ? `${instanceId}#${attempt}` : undefined;
}

export interface InterruptedTurnDeps {
  sessions(): Promise<SessionStore | undefined>;
  push(userId: string, data: Record<string, unknown>): Promise<unknown>;
}

const defaultDeps: InterruptedTurnDeps = {
  async sessions() {
    const client = await getAgentClient();
    return (client as unknown as { _sessionStore?: SessionStore })._sessionStore;
  },
  push: (userId, data) => sendEventToUser(userId, EVENTS.CHAT, data),
};

/**
 * `runId` is the run the user saw (the one the event and the note name).
 * `context` is the re-run's: its instance identifies the cut-off lease.
 */
export async function noteInterruptedTurn(
  turn: { userId: string; sessionId?: string; runId: string },
  context: DurableContext,
  deps: InterruptedTurnDeps = defaultDeps,
): Promise<void> {
  const { userId, sessionId, runId } = turn;
  if (sessionId) {
    const sessions = await deps.sessions().catch(() => undefined);
    if (sessions) {
      const failed = (what: string) => (err: unknown) =>
        context.warn(
          `[interrupted] could not ${what} for run=${runId} in session=${redactId(sessionId)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      // The note first, so it lands before anything the user resends; and
      // once, though a re-run cut off after writing it runs again.
      await (async () => {
        const recent = await sessions.getMessages(userId, sessionId, { limit: NOTE_LOOKBACK });
        if (recent.some((m) => m.runId === runId && m.content === INTERRUPTED_MESSAGE)) return;
        await sessions.appendMessages(userId, sessionId, [
          { role: "assistant", content: INTERRUPTED_MESSAGE, timestamp: new Date().toISOString(), runId },
        ]);
      })().catch(failed("write the note"));
      // Freed even if the note failed: the user can resend at once.
      await (async () => {
        const active = await sessions.peekActiveRun(userId, sessionId);
        if (active?.leaseId.startsWith(`${context.instanceId}#`)) {
          await sessions.releaseRunLease(userId, sessionId, active.leaseId);
        }
      })().catch(failed("release the session"));
    }
  }
  await deps.push(userId, {
    state: "error",
    runId,
    sessionId,
    error: INTERRUPTED_MESSAGE,
    code: "interrupted",
    retryable: true,
  }).catch(() => {});
}
