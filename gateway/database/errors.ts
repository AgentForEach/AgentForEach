/** A write refused by an IfMatch (etag) condition: someone else wrote first. */
export function isPreconditionFailedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e.code === 412 || e.code === "PreconditionFailed" || e.statusCode === 412
  );
}

export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e.code === 404 || e.code === "NotFound" || e.statusCode === 404;
}
