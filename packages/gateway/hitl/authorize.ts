/**
 * AgentForEach HITL Module — who may answer an input request
 *
 * An input response resumes a run as the request's owner, with the caller's
 * data merged into the pending tool call. Only the owner may answer, and
 * only while the request is still pending.
 */

import type { HitlStore } from "./store.js";

/**
 * True when `userId` owns a pending request `requestId`. The store read is
 * partition-scoped to `userId`, so another user's request is simply not found.
 */
export async function authorizeHitlResponse(
  store: Pick<HitlStore, "get">,
  requestId: string,
  userId: string,
): Promise<boolean> {
  const state = await store.get(requestId, userId);
  return state?.status === "pending";
}

/** The HITL store the client created (stored on the client by client/client.ts). */
export function getHitlStore(client: unknown): HitlStore | undefined {
  return (client as { _hitlStore?: HitlStore } | undefined)?._hitlStore;
}
