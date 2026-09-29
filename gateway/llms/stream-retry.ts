/**
 * AgentForEach LLMs — retry a model stream that fails before producing anything
 *
 * A stream can drop at the transport level ("Premature close", a reset
 * socket) before the model has produced a single token. Nothing has reached
 * the user yet, so starting the request again is invisible and safe. Once
 * any event has been passed on, a retry would duplicate output, so later
 * failures surface as before.
 */

import type { StreamEvent } from "./types.js";

/** Connection-level failures worth one immediate retry. */
const TRANSIENT = /premature close|econnreset|socket hang up|terminated|fetch failed|etimedout|epipe|other side closed|und_err_socket/i;

export function isTransientStreamError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status === 500 || status === 502 || status === 503;
  const e = err as { message?: unknown; cause?: { message?: unknown; code?: unknown }; code?: unknown };
  const text = [e.message, e.code, e.cause?.message, e.cause?.code].filter(Boolean).join(" ");
  return TRANSIENT.test(text);
}

/**
 * Wrap `start` (which opens the stream) so a transient failure before the
 * first event is retried `retries` times. Errors arrive either thrown or as
 * `{ type: "error" }` events; both are handled.
 */
export async function* retryStreamStart(
  start: () => AsyncIterable<StreamEvent>,
  opts: { retries?: number; signal?: AbortSignal; onRetry?: (err: unknown) => void } = {},
): AsyncGenerator<StreamEvent> {
  const retries = opts.retries ?? 1;
  for (let attempt = 0; ; attempt++) {
    let produced = false;
    let failed = false;
    let failure: unknown;
    try {
      for await (const event of start()) {
        if (!produced && event.type === "error") {
          failed = true;
          failure = event.error;
          break;
        }
        produced = true;
        yield event;
      }
    } catch (err) {
      if (produced) throw err;
      failed = true;
      failure = err;
    }
    if (!failed) return;
    if (attempt >= retries || opts.signal?.aborted || !isTransientStreamError(failure)) {
      yield { type: "error", error: failure instanceof Error ? failure : new Error(String(failure ?? "model stream failed")) } as StreamEvent;
      return;
    }
    opts.onRetry?.(failure);
  }
}
