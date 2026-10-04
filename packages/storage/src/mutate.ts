/**
 * AgentForEach Storage SDK — Optimistic read-modify-write
 *
 * The runtime's one concurrency primitive: read a document, compute its next
 * version, and replace it only if nobody wrote in between (`ifMatch` on the
 * `_etag` just read), retrying on PreconditionFailed. Session appends, run
 * leases, compaction, cron claims and HITL answers all follow this loop.
 *
 * `mutate` runs it for any adapter and reports how it ended. What to do when
 * retries run out (throw, return false, give up) stays with the caller.
 */

import { isNotFound, isPreconditionFailed } from "./errors.js";
import type { Collection, Doc, Stored } from "./types.js";

export type MutateResult<T extends Doc> =
  /** The replace succeeded; `document` is what is stored now. */
  | { status: "updated"; document: Stored<T> }
  /** The updater returned undefined (a guard failed); nothing was written. */
  | { status: "skipped"; document: Stored<T> }
  /** The document does not exist (or vanished between attempts). */
  | { status: "notFound" }
  /** Every attempt lost a race with another writer. */
  | { status: "contention"; attempts: number };

export type MutateOptions = {
  /** Total attempts, including the first. Default 4. */
  maxAttempts?: number;
};

/**
 * Read `id`, pass it to `update`, and replace it with the result under an
 * `ifMatch` on the version read. `update` may be called several times (once
 * per attempt, always with the latest version) and must not change the id
 * or partition key. Return undefined from `update` to write nothing.
 */
export async function mutate<T extends Doc>(
  collection: Collection<T>,
  id: string,
  partitionKey: string,
  update: (current: Stored<T>, attempt: number) => T | undefined | Promise<T | undefined>,
  options: MutateOptions = {},
): Promise<MutateResult<T>> {
  const maxAttempts = options.maxAttempts ?? 4;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("mutate: maxAttempts must be a positive integer");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await collection.read(id, partitionKey);
    if (!current) return { status: "notFound" };
    const next = await update(current, attempt);
    if (next === undefined) return { status: "skipped", document: current };
    try {
      const document = await collection.replace(id, partitionKey, next, { ifMatch: current._etag });
      return { status: "updated", document };
    } catch (err) {
      if (isPreconditionFailed(err)) continue;
      if (isNotFound(err)) return { status: "notFound" };
      throw err;
    }
  }
  return { status: "contention", attempts: maxAttempts };
}
