/**
 * Shared in-memory active request store.
 *
 * Lets both WS and REST handlers register/cancel the currently running chat
 * request for a user within the same function instance.
 */

import { redactId } from "../utils/redact.js";

const activeAbortControllers = new Map<string, AbortController>();

export function registerActiveRequest(
  userId: string,
  controller: AbortController,
): void {
  activeAbortControllers.set(userId, controller);
}

export function getActiveRequest(userId: string): AbortController | undefined {
  return activeAbortControllers.get(userId);
}

export function clearActiveRequest(
  userId: string,
  controller?: AbortController,
): void {
  const current = activeAbortControllers.get(userId);
  if (!current) return;
  if (controller && current !== controller) return;
  activeAbortControllers.delete(userId);
}

export function abortActiveRequest(userId: string): boolean {
  const controller = activeAbortControllers.get(userId);
  if (!controller) return false;
  controller.abort();
  activeAbortControllers.delete(userId);
  return true;
}

// ============================================================================
// Cross-instance abort watcher
// ============================================================================

/** Structural type for client/abort-store.ts — avoids a client import here. */
export interface SharedAbortStore {
  requestAbort(userId: string): Promise<void>;
  consumePendingAbort(userId: string, since: Date): Promise<boolean>;
}

const SHARED_ABORT_POLL_MS = 2500;

/**
 * Poll the shared abort store while a run is in flight and trip the local
 * AbortController when a marker appears. This is what makes the stop button
 * work when the abort request lands on a DIFFERENT function instance than
 * the one running the chat — the in-memory registry above can't reach
 * across instances, the store can.
 *
 * Returns a cleanup function; call it when the run finishes (success or
 * failure) so the poller doesn't outlive the request.
 */
export function watchSharedAbort(
  store: SharedAbortStore | undefined,
  userId: string,
  controller: AbortController,
  startedAt: Date,
): () => void {
  if (!store) return () => {};
  let stopped = false;
  let checking = false;
  const timer = setInterval(() => {
    if (stopped || checking || controller.signal.aborted) return;
    checking = true;
    void store
      .consumePendingAbort(userId, startedAt)
      .then((shouldAbort) => {
        if (shouldAbort && !stopped && !controller.signal.aborted) {
          console.log(
            `[abort] Shared abort marker found for user=${redactId(userId)} — aborting run`,
          );
          controller.abort();
        }
      })
      .catch(() => {
        // Transient read failure — the next tick tries again.
      })
      .finally(() => {
        checking = false;
      });
  }, SHARED_ABORT_POLL_MS);
  // The poller must never hold the process open on its own.
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
