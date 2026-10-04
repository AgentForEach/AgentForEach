/**
 * AgentForEach Storage — Cosmos DB error mapping
 *
 * @azure/cosmos reports failures as ErrorResponse objects whose `code` is a
 * number or a string and whose `statusCode` may be set; this maps the ones
 * the contract names to `StorageError` and passes everything else through.
 */

import { StorageError, type StorageErrorCode } from "@agentforeach/storage";

const BY_STATUS: Record<number, StorageErrorCode> = {
  400: "BadRequest",
  404: "NotFound",
  409: "Conflict",
  412: "PreconditionFailed",
  413: "BadRequest",
  429: "Throttled",
};

const BY_NAME: Record<string, StorageErrorCode> = {
  BadRequest: "BadRequest",
  NotFound: "NotFound",
  Conflict: "Conflict",
  PreconditionFailed: "PreconditionFailed",
  TooManyRequests: "Throttled",
};

/** The Cosmos HTTP status of an error, if it has one. */
export function cosmosStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { statusCode?: unknown; code?: unknown };
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.code === "number") return e.code;
  return undefined;
}

/** A StorageError for a Cosmos failure the contract names; otherwise `err` itself. */
export function toStorageError(err: unknown): unknown {
  if (err instanceof StorageError) return err;
  const status = cosmosStatus(err);
  const name = (err as { code?: unknown } | null)?.code;
  const code = (status !== undefined ? BY_STATUS[status] : undefined) ?? (typeof name === "string" ? BY_NAME[name] : undefined);
  if (!code) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new StorageError(code, `cosmosdb: ${message}`, { cause: err });
}
