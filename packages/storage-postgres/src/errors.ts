/**
 * AgentForEach Storage — PostgreSQL error mapping
 *
 * `pg` reports server errors with a SQLSTATE `code`. The ones the contract
 * names become `StorageError`s; everything else passes through unchanged:
 * client-side network failures (ECONNREFUSED, a dropped connection), as the
 * Cosmos adapter passes its network errors through, and configuration
 * errors such as a missing table when provisioning is off.
 */

import { StorageError, type StorageErrorCode } from "@agentforeach/storage";

const BY_SQLSTATE: Record<string, StorageErrorCode> = {
  // A unique key: only a race the adapter's own statements do not absorb.
  "23505": "Conflict",
  // Retry later: serialization failure, deadlock, a lock or statement
  // timeout, resource or connection limits, a read-only server (failover in
  // progress), the server shutting down or starting up.
  "40001": "Throttled",
  "40P01": "Throttled",
  "55P03": "Throttled",
  "57014": "Throttled",
  "53000": "Throttled",
  "53100": "Throttled",
  "53200": "Throttled",
  "53300": "Throttled",
  "25006": "Throttled",
  "57P01": "Throttled",
  "57P02": "Throttled",
  "57P03": "Throttled",
  // Values PostgreSQL cannot store: "\u0000" in jsonb or text, JSON it will
  // not parse, a number out of range, a key too large for its index.
  "22P05": "BadRequest",
  "22P02": "BadRequest",
  "22021": "BadRequest",
  "22003": "BadRequest",
  "54000": "BadRequest",
};

/** The SQLSTATE of a `pg` error, if it has one. */
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** A StorageError for a failure the contract names; otherwise `err` itself. */
export function toStorageError(err: unknown): unknown {
  if (err instanceof StorageError) return err;
  const state = sqlState(err);
  const code = state !== undefined && Object.hasOwn(BY_SQLSTATE, state) ? BY_SQLSTATE[state] : undefined;
  if (!code) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new StorageError(code, `postgres: ${message}`, { cause: err });
}
