/**
 * AgentForEach Storage SDK — Errors
 *
 * Every adapter reports failures as a `StorageError` with one of a few
 * portable codes, so stores never sniff a vendor's error shapes.
 *
 * Each error also carries the HTTP-style `statusCode` Cosmos DB used for the
 * same condition (404 / 409 / 412 / 429 / 400). Code written against Cosmos
 * errors (`err.code === 412 || err.code === "PreconditionFailed"`) keeps
 * working while it moves to the predicates below.
 */

export type StorageErrorCode =
  /** The document does not exist (or has expired). */
  | "NotFound"
  /** `create` of an id that already exists in the partition. */
  | "Conflict"
  /** An `ifMatch` condition failed: someone else wrote first. */
  | "PreconditionFailed"
  /** The database is rate limiting; retry later. */
  | "Throttled"
  /** The request is invalid (bad id, partition key mismatch, bad patch...). */
  | "BadRequest"
  /** The adapter does not support the operation (see its capabilities). */
  | "Unsupported";

const STATUS: Record<StorageErrorCode, number> = {
  NotFound: 404,
  Conflict: 409,
  PreconditionFailed: 412,
  Throttled: 429,
  BadRequest: 400,
  Unsupported: 501,
};

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly statusCode: number;

  constructor(code: StorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
    this.statusCode = STATUS[code];
  }
}

/**
 * Matched by name as well as class: an adapter package may bundle its own
 * copy of this SDK, and `instanceof` fails across copies.
 */
function hasCode(err: unknown, code: StorageErrorCode): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return (err instanceof StorageError || e.name === "StorageError") && e.code === code;
}

export function isNotFound(err: unknown): boolean {
  return hasCode(err, "NotFound");
}

export function isConflict(err: unknown): boolean {
  return hasCode(err, "Conflict");
}

export function isPreconditionFailed(err: unknown): boolean {
  return hasCode(err, "PreconditionFailed");
}

export function isThrottled(err: unknown): boolean {
  return hasCode(err, "Throttled");
}
