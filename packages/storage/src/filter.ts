/**
 * AgentForEach Storage SDK — Filters
 *
 * Queries describe their WHERE clause as a small tree of plain objects
 * rather than as SQL text, so each adapter compiles it to its own query
 * language (Cosmos SQL, Postgres JSONB, an in-memory evaluator...).
 *
 * The operators are the ones the runtime actually uses. Their semantics are
 * Cosmos DB's, which every adapter must reproduce (see `semantics.ts` for
 * the reference implementation):
 *
 *   - three-valued logic: a comparison involving a field that is absent is
 *     *undefined*, `NOT undefined` is undefined, and a query keeps only
 *     documents whose filter is exactly true;
 *   - `eq` across types is false and `ne` across types is true, so
 *     `ne("x", null)` matches every document where x is present and not null;
 *   - `lt`/`lte`/`gt`/`gte` compare only numbers with numbers, strings with
 *     strings (ordinal) and booleans with booleans; anything else is undefined;
 *   - absent and null are different: clearing a field removes it, and
 *     `missing(f)` / `present(f)` test both.
 *
 * Field paths are dotted ("state.nextRunAtMs"); every segment must be an
 * identifier, which keeps adapters' compiled queries injection-free.
 */

import { StorageError } from "./errors.js";
import { SYSTEM_FIELDS } from "./types.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A dotted field path, e.g. "userId" or "state.status". */
export type FieldPath = string;

export type ComparisonOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export type Filter =
  | { op: "and"; filters: Filter[] }
  | { op: "or"; filters: Filter[] }
  | { op: "not"; filter: Filter }
  | { op: ComparisonOp; field: FieldPath; value: JsonValue }
  | { op: "in"; field: FieldPath; values: JsonValue[] }
  | { op: "isDefined"; field: FieldPath }
  | { op: "contains"; field: FieldPath; value: string; ignoreCase: boolean };

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names that reach JavaScript object internals. Refused in field paths,
 * patch paths and projection keys, so no adapter that walks documents in
 * JavaScript can be steered onto Object.prototype.
 */
export const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const SYSTEM_NAMES: ReadonlySet<string> = new Set(SYSTEM_FIELDS);

/**
 * Split and validate a field path; throws BadRequest when it is unusable.
 * System fields (`_etag`, `_ts`...) cannot be queried: some databases keep
 * them outside the document, so a filter on them would not be portable.
 */
export function fieldSegments(path: FieldPath): string[] {
  const segments = typeof path === "string" ? path.split(".") : [];
  if (
    segments.length === 0 ||
    SYSTEM_NAMES.has(segments[0]) ||
    !segments.every((s) => SEGMENT.test(s) && !FORBIDDEN_NAMES.has(s))
  ) {
    throw new StorageError("BadRequest", `invalid field path "${String(path)}"`);
  }
  return segments;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Check that `value` is plain JSON that every database stores and compares
 * the same way: finite numbers, strings, booleans, null, arrays and plain
 * objects of those. NaN, Infinity, undefined members, Dates and class
 * instances are refused: JSON would silently turn them into something else
 * (NaN into null, a Date into a string) on the way to a database, while an
 * in-process evaluator would compare the originals.
 */
export function checkJsonValue(value: unknown, where: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new StorageError("BadRequest", `${where}: ${value} is not a finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkJsonValue(item, `${where}[${i}]`));
    return;
  }
  if (typeof value === "object" && isPlainObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      if (FORBIDDEN_NAMES.has(key)) throw new StorageError("BadRequest", `${where}: key "${key}" is not allowed`);
      checkJsonValue(member, `${where}.${key}`);
    }
    return;
  }
  throw new StorageError("BadRequest", `${where}: ${value === undefined ? "undefined" : typeof value} is not a JSON value`);
}

function comparison(op: ComparisonOp, field: FieldPath, value: JsonValue): Filter {
  fieldSegments(field);
  checkJsonValue(value, `${op}("${field}")`);
  return { op, field, value };
}

type MaybeFilter = Filter | undefined | null | false | "" | 0;

function compact(filters: MaybeFilter[]): Filter[] {
  return filters.filter((f): f is Filter => Boolean(f));
}

// ----------------------------------------------------------------------------
// Builders
// ----------------------------------------------------------------------------

export const eq = (field: FieldPath, value: JsonValue): Filter => comparison("eq", field, value);
export const ne = (field: FieldPath, value: JsonValue): Filter => comparison("ne", field, value);
export const lt = (field: FieldPath, value: JsonValue): Filter => comparison("lt", field, value);
export const lte = (field: FieldPath, value: JsonValue): Filter => comparison("lte", field, value);
export const gt = (field: FieldPath, value: JsonValue): Filter => comparison("gt", field, value);
export const gte = (field: FieldPath, value: JsonValue): Filter => comparison("gte", field, value);

/**
 * All of the filters. Falsy entries are dropped, so optional clauses can be
 * written inline: `and(eq("userId", u), agentId && eq("agentId", agentId))`.
 * With nothing left it matches every document.
 */
export function and(...filters: MaybeFilter[]): Filter {
  return { op: "and", filters: compact(filters) };
}

/** Any of the filters (falsy entries dropped). With nothing left it matches nothing. */
export function or(...filters: MaybeFilter[]): Filter {
  return { op: "or", filters: compact(filters) };
}

export function not(filter: Filter): Filter {
  return { op: "not", filter };
}

/** The field exists (it may be null). */
export function isDefined(field: FieldPath): Filter {
  fieldSegments(field);
  return { op: "isDefined", field };
}

/** The field equals one of `values` (same type rules as `eq`). */
export function oneOf(field: FieldPath, values: JsonValue[]): Filter {
  fieldSegments(field);
  if (!Array.isArray(values)) {
    throw new StorageError("BadRequest", `oneOf("${field}"): values must be an array of JSON values`);
  }
  checkJsonValue(values, `oneOf("${field}")`);
  return { op: "in", field, values };
}

/** The string field contains `value` as a substring (optionally ignoring case). */
export function contains(
  field: FieldPath,
  value: string,
  options: { ignoreCase?: boolean } = {},
): Filter {
  fieldSegments(field);
  if (typeof value !== "string") {
    throw new StorageError("BadRequest", `contains("${field}"): value must be a string`);
  }
  return { op: "contains", field, value, ignoreCase: options.ignoreCase ?? false };
}

/** The field is absent or null: `NOT IS_DEFINED(f) OR f = null`. */
export function missing(field: FieldPath): Filter {
  return or(not(isDefined(field)), eq(field, null));
}

/** The field is present and not null: `IS_DEFINED(f) AND f != null`. */
export function present(field: FieldPath): Filter {
  return and(isDefined(field), ne(field, null));
}
