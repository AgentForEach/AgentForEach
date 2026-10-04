/**
 * AgentForEach Storage SDK — Reference semantics
 *
 * The contract's rules as plain functions over JavaScript values: filter
 * evaluation (Cosmos DB three-valued logic), sort order, projection, patch
 * application, write validation and TTL. The in-memory adapter is built from
 * them, adapters that evaluate anything client-side should reuse them, and
 * they are the tie-breaker when a compiled query's behaviour is in doubt.
 */

import { StorageError } from "./errors.js";
import { FORBIDDEN_NAMES, checkJsonValue, fieldSegments, type Filter } from "./filter.js";
import {
  MAX_PATCH_OPERATIONS,
  SYSTEM_FIELDS,
  type CollectionSpec,
  type Doc,
  type HybridSearchQuery,
  type OrderBy,
  type PatchOperation,
  type Query,
  type Selection,
  type VectorSearchQuery,
} from "./types.js";

// ============================================================================
// Values
// ============================================================================

/**
 * The value at a dotted path, or undefined if any step is missing. Only a
 * document's own properties count (never inherited ones like `toString`).
 */
export function readField(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const segment of fieldSegments(path)) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Cross-type order: undefined < null < boolean < number < string < array < object. */
export function typeRank(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null) return 1;
  if (typeof value === "boolean") return 2;
  if (typeof value === "number") return 3;
  if (typeof value === "string") return 4;
  if (Array.isArray(value)) return 5;
  return 6;
}

/** Structural equality; object key order does not matter, types must match. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeRank(a) !== typeRank(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => jsonEqual(item, other[i]));
  }
  if (a !== null && typeof a === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left).filter((k) => left[k] !== undefined);
    const otherKeys = Object.keys(right).filter((k) => right[k] !== undefined);
    return keys.length === otherKeys.length && keys.every((k) => jsonEqual(left[k], right[k]));
  }
  return a === b;
}

/** Ordinal string comparison (UTF-16 code units), as Cosmos DB orders strings. */
function primitiveCompare(a: number | string | boolean, b: number | string | boolean): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort comparator for ORDER BY (ascending). */
export function compareForOrder(a: unknown, b: unknown): number {
  const rankDiff = typeRank(a) - typeRank(b);
  if (rankDiff !== 0) return rankDiff;
  if (typeof a === "number" || typeof a === "string" || typeof a === "boolean") {
    return primitiveCompare(a, b as typeof a);
  }
  return 0;
}

// ============================================================================
// Filters
// ============================================================================

/**
 * Evaluate a filter against a document: true, false, or undefined (unknown).
 * Queries keep a document only when this returns exactly true.
 */
export function evaluateFilter(filter: Filter, doc: unknown): boolean | undefined {
  switch (filter.op) {
    case "and": {
      let unknown = false;
      for (const child of filter.filters) {
        const value = evaluateFilter(child, doc);
        if (value === false) return false;
        if (value === undefined) unknown = true;
      }
      return unknown ? undefined : true;
    }
    case "or": {
      let unknown = false;
      for (const child of filter.filters) {
        const value = evaluateFilter(child, doc);
        if (value === true) return true;
        if (value === undefined) unknown = true;
      }
      return unknown ? undefined : false;
    }
    case "not": {
      const value = evaluateFilter(filter.filter, doc);
      return value === undefined ? undefined : !value;
    }
    case "isDefined":
      return readField(doc, filter.field) !== undefined;
    case "in": {
      // An empty list is false outright, as `IN ()` compiles to `false`.
      if (filter.values.length === 0) return false;
      const value = readField(doc, filter.field);
      if (value === undefined) return undefined;
      return filter.values.some((candidate) => jsonEqual(value, candidate));
    }
    case "contains": {
      const value = readField(doc, filter.field);
      if (typeof value !== "string") return undefined;
      return filter.ignoreCase
        ? value.toLowerCase().includes(filter.value.toLowerCase())
        : value.includes(filter.value);
    }
    case "eq":
    case "ne": {
      const value = readField(doc, filter.field);
      if (value === undefined) return undefined;
      const equal = jsonEqual(value, filter.value);
      return filter.op === "eq" ? equal : !equal;
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const value = readField(doc, filter.field);
      const other = filter.value;
      if (value === undefined) return undefined;
      // Same-type numbers, strings and booleans compare; so does null with
      // null (null <= null is true, as in Cosmos). Anything else is unknown.
      const comparable =
        typeRank(value) === typeRank(other) &&
        (value === null || typeof value === "number" || typeof value === "string" || typeof value === "boolean");
      if (!comparable) return undefined;
      const order = value === null ? 0 : primitiveCompare(value as number | string | boolean, other as number | string | boolean);
      if (filter.op === "lt") return order < 0;
      if (filter.op === "lte") return order <= 0;
      if (filter.op === "gt") return order > 0;
      return order >= 0;
    }
    default:
      throw new StorageError("BadRequest", `unknown filter op "${(filter as { op: string }).op}"`);
  }
}

/** True when the document passes the (optional) filter. */
export function matches(filter: Filter | undefined, doc: unknown): boolean {
  return filter === undefined || evaluateFilter(filter, doc) === true;
}

/**
 * Sort items by one document field (stable for ties). Items where the field
 * is absent sort first ascending and last descending. `documentOf` maps an
 * item to its document when items wrap documents.
 */
export function sortDocuments<D>(
  items: D[],
  orderBy: OrderBy | undefined,
  documentOf: (item: D) => unknown = (item) => item,
): D[] {
  if (!orderBy) return items;
  const direction = orderBy.direction === "desc" ? -1 : 1;
  const field = orderBy.field;
  return [...items].sort(
    (a, b) => direction * compareForOrder(readField(documentOf(a), field), readField(documentOf(b), field)),
  );
}

/** Validate a query limit: a non-negative safe integer (when given, or always if `required`). */
export function checkLimit(limit: number | undefined, required = false): void {
  if (limit === undefined && !required) return;
  if (!(Number.isSafeInteger(limit) && (limit as number) >= 0)) {
    throw new StorageError("BadRequest", `limit must be a non-negative integer, got ${String(limit)}`);
  }
}

/**
 * Words no projection key may use: SQL keywords that some databases cannot
 * take as a column alias. The rule is portable so that a projection valid on
 * one adapter is valid on all of them.
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "AND", "ARRAY", "AS", "ASC", "BETWEEN", "BY", "CASE", "CAST", "CONVERT", "CROSS", "DESC",
  "DISTINCT", "ELSE", "END", "ESCAPE", "EXISTS", "FALSE", "FOR", "FROM", "GROUP", "HAVING",
  "IN", "INNER", "INSERT", "INTO", "IS", "JOIN", "LEFT", "LIKE", "LIMIT", "NOT", "NULL",
  "OFFSET", "ON", "OR", "ORDER", "OUTER", "OVER", "RANK", "RIGHT", "SELECT", "SET", "THEN",
  "TOP", "TRUE", "UDF", "UNDEFINED", "UPDATE", "VALUE", "WHEN", "WHERE", "WITH",
]);

const OUTPUT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Output key of a selection: its alias, or the path's last segment. Validated. */
export function selectionKey(selection: Selection): string {
  const field = typeof selection === "string" ? selection : selection?.field;
  const segments = fieldSegments(field);
  const key = typeof selection === "string" ? segments[segments.length - 1] : selection.as;
  if (typeof key !== "string" || !OUTPUT_KEY.test(key) || FORBIDDEN_NAMES.has(key)) {
    throw new StorageError("BadRequest", `invalid projection key "${String(key)}"`);
  }
  if (RESERVED_WORDS.has(key.toUpperCase())) {
    throw new StorageError("BadRequest", `projection key "${key}" is a reserved word; choose another alias`);
  }
  return key;
}

/** Validate a projection: valid, distinct output keys. */
export function checkSelection(select: Selection[] | undefined): void {
  if (select === undefined) return;
  if (!Array.isArray(select)) throw new StorageError("BadRequest", "select must be an array");
  const seen = new Set<string>();
  for (const selection of select) {
    const key = selectionKey(selection);
    if (seen.has(key)) throw new StorageError("BadRequest", `projection key "${key}" appears twice`);
    seen.add(key);
  }
}

/** Project a document; fields it lacks are left out. */
export function project(doc: unknown, select: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of select) {
    const field = typeof selection === "string" ? selection : selection.field;
    const value = readField(doc, field);
    if (value !== undefined) out[selectionKey(selection)] = clone(value);
  }
  return out;
}

// ============================================================================
// Writes
// ============================================================================

/** A JSON round trip: undefined fields vanish, as they do in every database. */
export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

const INVALID_ID = /[/\\?#]/;
const MAX_ID_BYTES = 1023;
const MAX_PARTITION_KEY_BYTES = 2048;
/** Largest TTL Cosmos DB accepts (2^31 - 1 seconds). */
const MAX_TTL = 2_147_483_647;

/** -1, or a positive integer up to MAX_TTL. */
export function isValidTtl(ttl: unknown): boolean {
  return ttl === -1 || (Number.isInteger(ttl) && (ttl as number) > 0 && (ttl as number) <= MAX_TTL);
}

/**
 * The document as it will be stored: a JSON copy without system fields,
 * after checking its id, partition key and ttl. Returns the partition key.
 */
export function prepareWrite(
  spec: CollectionSpec,
  document: Doc,
): { doc: Record<string, unknown>; partitionKey: string } {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new StorageError("BadRequest", "document must be an object");
  }
  let doc: Record<string, unknown>;
  try {
    doc = clone(document) as Record<string, unknown>;
  } catch (err) {
    throw new StorageError("BadRequest", "document is not JSON-serializable", { cause: err });
  }
  for (const field of SYSTEM_FIELDS) delete doc[field];
  const id = doc.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new StorageError("BadRequest", "document id must be a non-empty string");
  }
  if (INVALID_ID.test(id)) {
    throw new StorageError("BadRequest", `document id "${id}" contains / \\ ? or #`);
  }
  if (Buffer.byteLength(id, "utf8") > MAX_ID_BYTES) {
    throw new StorageError("BadRequest", `document id is longer than ${MAX_ID_BYTES} bytes`);
  }
  const partitionKey = readField(doc, spec.partitionKey);
  if (typeof partitionKey !== "string") {
    throw new StorageError(
      "BadRequest",
      `document "${id}": partition key "${spec.partitionKey}" must be a string`,
    );
  }
  if (Buffer.byteLength(partitionKey, "utf8") > MAX_PARTITION_KEY_BYTES) {
    throw new StorageError("BadRequest", `document "${id}": partition key is longer than ${MAX_PARTITION_KEY_BYTES} bytes`);
  }
  if (doc.ttl !== undefined && !isValidTtl(doc.ttl)) {
    throw new StorageError("BadRequest", `document "${id}": ttl must be -1 or an integer from 1 to ${MAX_TTL}`);
  }
  return { doc, partitionKey };
}

/**
 * `prepareWrite` for `replace`: the body must keep the id and partition key
 * the request names (a document never moves).
 */
export function prepareReplace(
  spec: CollectionSpec,
  id: string,
  partitionKey: string,
  document: Doc,
): { doc: Record<string, unknown>; partitionKey: string } {
  const prepared = prepareWrite(spec, document);
  if (prepared.doc.id !== id) {
    throw new StorageError("BadRequest", `replace: body id "${String(prepared.doc.id)}" is not "${id}"`);
  }
  if (prepared.partitionKey !== partitionKey) {
    throw new StorageError("BadRequest", "replace: the body's partition key differs from the request's");
  }
  return prepared;
}

/**
 * The stored document `current` after `operations`, ready to write: patched
 * on a copy (all or nothing), then checked like any write. For adapters that
 * apply patches in the application (in a transaction or under a lock).
 */
export function patchDocument(
  spec: CollectionSpec,
  current: Record<string, unknown>,
  operations: PatchOperation[],
): { doc: Record<string, unknown>; partitionKey: string } {
  checkPatchTargets(spec, operations);
  const next = clone(current);
  applyPatch(next, operations);
  const prepared = prepareWrite(spec, next as Doc);
  if (prepared.doc.id !== current.id || prepared.partitionKey !== readField(current, spec.partitionKey)) {
    throw new StorageError("BadRequest", "patch may not change the id or partition key");
  }
  return prepared;
}

/**
 * When a document written at `writtenAtMs` expires (epoch ms), or undefined
 * if it never does. Every write restarts the clock.
 */
export function expiresAtMs(
  spec: CollectionSpec,
  doc: Record<string, unknown>,
  writtenAtMs: number,
): number | undefined {
  if (spec.defaultTtl === undefined) return undefined;
  const ttl = typeof doc.ttl === "number" ? doc.ttl : spec.defaultTtl;
  if (ttl === -1) return undefined;
  return writtenAtMs + ttl * 1000;
}

function pointer(path: string): string[] {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new StorageError("BadRequest", `patch path "${String(path)}" must start with "/"`);
  }
  const segments = path.slice(1).split("/");
  // Object members only: no array indexes ("0", "-") and no JSON-pointer
  // escapes ("~0", "~1"), whose meaning would differ between adapters.
  if (segments.some((s) => s.length === 0 || s === "-" || /^\d+$/.test(s) || s.includes("~") || FORBIDDEN_NAMES.has(s))) {
    throw new StorageError("BadRequest", `patch path "${path}" is invalid (object member names only)`);
  }
  return segments;
}

/**
 * Validate patch operations without a document: known ops, valid paths,
 * JSON values, finite increments, and at most MAX_PATCH_OPERATIONS. Adapters
 * that hand patches to their database call this first, so every adapter
 * refuses the same patches.
 */
export function checkPatch(operations: PatchOperation[]): void {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new StorageError("BadRequest", "patch needs at least one operation");
  }
  if (operations.length > MAX_PATCH_OPERATIONS) {
    throw new StorageError(
      "BadRequest",
      `patch accepts at most ${MAX_PATCH_OPERATIONS} operations, got ${operations.length}`,
    );
  }
  for (const operation of operations) {
    pointer(operation?.path);
    switch (operation.op) {
      case "set":
        // Same rule as document writes: any JSON-serializable value (undefined
        // members vanish, as they do in create/upsert); undefined itself is not.
        if (operation.value === undefined) {
          throw new StorageError("BadRequest", `patch set ${operation.path}: value is undefined`);
        }
        try {
          JSON.stringify(operation.value);
        } catch (err) {
          throw new StorageError("BadRequest", `patch set ${operation.path}: value is not JSON-serializable`, { cause: err });
        }
        break;
      case "remove":
        break;
      case "incr":
        if (typeof operation.value !== "number" || !Number.isFinite(operation.value)) {
          throw new StorageError("BadRequest", `patch incr ${operation.path}: value must be a finite number`);
        }
        break;
      default:
        throw new StorageError("BadRequest", `unknown patch op "${(operation as { op: string }).op}"`);
    }
  }
}

/**
 * Refuse patches that touch the id or the partition key (or an object above
 * it): a document never moves. Checked before the database sees the patch.
 */
export function checkPatchTargets(spec: CollectionSpec, operations: PatchOperation[]): void {
  const keyPath = fieldSegments(spec.partitionKey);
  for (const operation of operations) {
    const segments = pointer(operation.path);
    const touchesId = segments[0] === "id";
    const touchesKey = segments.length <= keyPath.length && segments.every((s, i) => s === keyPath[i]);
    if (touchesId || touchesKey) {
      throw new StorageError("BadRequest", `patch ${operation.path}: the id and partition key cannot be patched`);
    }
  }
}

/**
 * Apply patch operations to a document in place (validate first with
 * `checkPatch`; work on a copy for all-or-nothing). Paths address object
 * members; patching inside arrays is not part of the contract.
 */
export function applyPatch(doc: Record<string, unknown>, operations: PatchOperation[]): void {
  checkPatch(operations);
  for (const operation of operations) {
    const segments = pointer(operation.path);
    const last = segments[segments.length - 1];
    let parent: Record<string, unknown> = doc;
    for (const segment of segments.slice(0, -1)) {
      const next = Object.hasOwn(parent, segment) ? parent[segment] : undefined;
      if (next === null || typeof next !== "object" || Array.isArray(next)) {
        throw new StorageError("BadRequest", `patch path ${operation.path}: parent does not exist`);
      }
      parent = next as Record<string, unknown>;
    }
    const has = Object.hasOwn(parent, last);
    switch (operation.op) {
      case "set":
        parent[last] = clone(operation.value);
        break;
      case "remove":
        if (!has) throw new StorageError("BadRequest", `patch remove ${operation.path}: field does not exist`);
        delete parent[last];
        break;
      case "incr": {
        const current = has ? parent[last] : 0;
        if (typeof current !== "number") {
          throw new StorageError("BadRequest", `patch incr ${operation.path}: not a number`);
        }
        const next = current + operation.value;
        if (!Number.isFinite(next)) {
          throw new StorageError("BadRequest", `patch incr ${operation.path}: result is not a finite number`);
        }
        parent[last] = next;
        break;
      }
    }
  }
}

// ============================================================================
// Search requests
// ============================================================================

function checkVector(spec: CollectionSpec, vector: unknown): void {
  if (!spec.vector) {
    throw new StorageError("BadRequest", `collection "${spec.name}" has no vector policy`);
  }
  if (
    !Array.isArray(vector) ||
    vector.length !== spec.vector.dimensions ||
    !vector.every((x) => typeof x === "number" && Number.isFinite(x))
  ) {
    throw new StorageError(
      "BadRequest",
      `query vector must be ${spec.vector.dimensions} finite numbers for "${spec.name}"`,
    );
  }
}

/** Validate a vector search against the collection's policy. */
export function checkVectorSearch(spec: CollectionSpec, query: VectorSearchQuery): void {
  checkVector(spec, query.vector);
  checkLimit(query.limit, true);
}

/** Validate a hybrid search; returns the weights (default all 1). */
export function checkHybridSearch(spec: CollectionSpec, query: HybridSearchQuery): number[] {
  checkLimit(query.limit, true);
  if (!Array.isArray(query.rank) || query.rank.length === 0) {
    throw new StorageError("BadRequest", "hybrid search needs at least one rank component");
  }
  const weights = query.weights ?? query.rank.map(() => 1);
  if (weights.length !== query.rank.length || !weights.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0)) {
    throw new StorageError("BadRequest", "hybrid search needs one non-negative weight per rank component");
  }
  for (const component of query.rank) {
    if (component.kind === "vector") {
      checkVector(spec, component.vector);
    } else if (component.kind === "fullText") {
      if (!spec.fullText?.fields.includes(component.field)) {
        throw new StorageError(
          "BadRequest",
          `"${component.field}" is not in the full-text policy of "${spec.name}"`,
        );
      }
      if (
        !Array.isArray(component.terms) ||
        component.terms.length === 0 ||
        !component.terms.every((t) => typeof t === "string" && t.length > 0)
      ) {
        throw new StorageError("BadRequest", "full-text ranking needs at least one non-empty term");
      }
    } else {
      throw new StorageError("BadRequest", `unknown rank component "${(component as { kind: string }).kind}"`);
    }
  }
  return weights;
}

// ============================================================================
// Requests
// ============================================================================

/** Validate a filter tree (shape, field paths, values). */
export function checkFilter(filter: Filter): void {
  if (filter === null || typeof filter !== "object") {
    throw new StorageError("BadRequest", "filter must be an object");
  }
  switch (filter.op) {
    case "and":
    case "or":
      if (!Array.isArray(filter.filters)) throw new StorageError("BadRequest", `${filter.op}: filters must be an array`);
      filter.filters.forEach(checkFilter);
      return;
    case "not":
      checkFilter(filter.filter);
      return;
    case "isDefined":
      fieldSegments(filter.field);
      return;
    case "in":
      fieldSegments(filter.field);
      if (!Array.isArray(filter.values)) throw new StorageError("BadRequest", "in: values must be an array");
      checkJsonValue(filter.values, `in("${filter.field}")`);
      return;
    case "contains":
      fieldSegments(filter.field);
      if (typeof filter.value !== "string") throw new StorageError("BadRequest", "contains: value must be a string");
      return;
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      fieldSegments(filter.field);
      checkJsonValue(filter.value, `${filter.op}("${filter.field}")`);
      return;
    default:
      throw new StorageError("BadRequest", `unknown filter op "${(filter as { op: string }).op}"`);
  }
}

/** Validate a query before running it. */
export function checkQuery(query: Query): void {
  if (query.partitionKey !== undefined && typeof query.partitionKey !== "string") {
    throw new StorageError("BadRequest", "partitionKey must be a string");
  }
  if (query.where) checkFilter(query.where);
  if (query.orderBy) {
    fieldSegments(query.orderBy.field);
    const direction = query.orderBy.direction;
    if (direction !== undefined && direction !== "asc" && direction !== "desc") {
      throw new StorageError("BadRequest", `orderBy direction must be "asc" or "desc"`);
    }
  }
  checkLimit(query.limit);
  checkSelection(query.select);
}

/** Validate a collection definition. */
export function checkCollectionSpec(spec: CollectionSpec): void {
  if (!spec || typeof spec.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(spec.name)) {
    throw new StorageError("BadRequest", `invalid collection name "${String(spec?.name)}"`);
  }
  fieldSegments(spec.partitionKey);
  if (spec.defaultTtl !== undefined && !isValidTtl(spec.defaultTtl)) {
    throw new StorageError("BadRequest", `collection "${spec.name}": defaultTtl must be -1 or an integer from 1 to ${MAX_TTL}`);
  }
  if (spec.vector) {
    fieldSegments(spec.vector.field);
    if (!Number.isInteger(spec.vector.dimensions) || spec.vector.dimensions < 1) {
      throw new StorageError("BadRequest", `collection "${spec.name}": vector dimensions must be a positive integer`);
    }
    if (spec.vector.distance !== "cosine") {
      throw new StorageError("BadRequest", `collection "${spec.name}": only cosine distance is supported`);
    }
  }
  spec.fullText?.fields.forEach(fieldSegments);
  spec.indexes?.forEach(fieldSegments);
  spec.unindexed?.forEach(fieldSegments);
}
