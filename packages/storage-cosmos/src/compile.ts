/**
 * AgentForEach Storage — Cosmos DB query compiler
 *
 * Compiles the storage SDK's queries (filter trees, ordering, projection,
 * vector and hybrid search) to parameterized Cosmos DB NoSQL. The output has
 * the shape the stores used to write by hand, so behaviour does not move:
 *
 *   - nested ANDs and ORs are flattened, and parentheses appear only where an
 *     OR sits inside an AND (or the reverse);
 *   - `missing(f)` prints as `NOT IS_DEFINED(c.f) OR c.f = null`;
 *   - null is a literal (`c.f = null`), every other value a parameter named
 *     after its field (`c.userId = @userId`);
 *   - TOP is a literal integer (the SDK validated it as a safe integer),
 *     matching how the memory store wrote its hybrid queries.
 *
 * Cosmos DB evaluates these with exactly the contract's semantics
 * (three-valued logic, type-strict comparison), so no translation of meaning
 * is needed, only of syntax.
 */

import type { JSONValue, SqlParameter, SqlQuerySpec } from "@azure/cosmos";
import {
  StorageError,
  checkHybridSearch,
  checkLimit,
  checkQuery,
  checkVectorSearch,
  fieldSegments,
  selectionKey,
  type CollectionSpec,
  type CountQuery,
  type Filter,
  type HybridSearchQuery,
  type Query,
  type Selection,
  type VectorSearchQuery,
} from "@agentforeach/storage";

/**
 * Alias of the similarity column in compiled vector searches, or the first
 * free `vectorDistance<n>` when a projection already uses it.
 */
export const SCORE_ALIAS = "vectorDistance";
/** Alias of the whole document in compiled vector searches without `select`. */
export const DOCUMENT_ALIAS = "document";

/**
 * Cosmos NoSQL keywords. A property with one of these names is written
 * `c["value"]`; `c.value` does not parse.
 */
const RESERVED = new Set([
  "AND", "ARRAY", "AS", "ASC", "BETWEEN", "BY", "CASE", "CAST", "CONVERT", "CROSS", "DESC",
  "DISTINCT", "ELSE", "END", "ESCAPE", "EXISTS", "FALSE", "FOR", "FROM", "GROUP", "HAVING",
  "IN", "INNER", "INSERT", "INTO", "IS", "JOIN", "LEFT", "LIKE", "LIMIT", "NOT", "NULL",
  "OFFSET", "ON", "OR", "ORDER", "OUTER", "OVER", "RANK", "RIGHT", "SELECT", "SET", "THEN",
  "TOP", "TRUE", "UDF", "UNDEFINED", "UPDATE", "VALUE", "WHEN", "WHERE", "WITH",
]);


/** `c.state.status`, with bracket access for reserved words. */
export function fieldExpression(path: string): string {
  return (
    "c" +
    fieldSegments(path)
      .map((segment) => (RESERVED.has(segment.toUpperCase()) ? `["${segment}"]` : `.${segment}`))
      .join("")
  );
}

/** Parameters named after what they hold (`@userId`, `@userId1`...). */
class Parameters {
  readonly list: SqlParameter[] = [];
  private readonly used = new Set<string>();

  add(hint: string, value: JSONValue): string {
    let name = `@${hint}`;
    for (let i = 1; this.used.has(name); i++) name = `@${hint}${i}`;
    this.used.add(name);
    this.list.push({ name, value });
    return name;
  }

  forField(path: string, value: JSONValue): string {
    const segments = fieldSegments(path);
    return this.add(segments[segments.length - 1], value);
  }
}

const COMPARATORS = { eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

type Logical = "and" | "or";

function flatten(op: Logical, filters: Filter[]): Filter[] {
  return filters.flatMap((f) => (f.op === op ? flatten(op, (f as { filters: Filter[] }).filters) : [f]));
}

function compileNode(filter: Filter, params: Parameters, parent?: Logical | "not"): string {
  switch (filter.op) {
    case "and":
    case "or": {
      const children = flatten(filter.op, filter.filters);
      if (children.length === 0) return filter.op === "and" ? "true" : "false";
      if (children.length === 1) return compileNode(children[0], params, parent);
      const joined = children.map((c) => compileNode(c, params, filter.op as Logical)).join(filter.op === "and" ? " AND " : " OR ");
      return parent !== undefined && parent !== filter.op ? `(${joined})` : joined;
    }
    case "not": {
      const inner = compileNode(filter.filter, params, "not");
      const isCall = filter.filter.op === "isDefined" || filter.filter.op === "contains";
      return isCall || inner.startsWith("(") ? `NOT ${inner}` : `NOT (${inner})`;
    }
    case "isDefined":
      return `IS_DEFINED(${fieldExpression(filter.field)})`;
    case "in": {
      if (filter.values.length === 0) return "false";
      const segments = fieldSegments(filter.field);
      const hint = segments[segments.length - 1];
      const names = filter.values.map((v, i) => params.add(`${hint}${i}`, v as JSONValue));
      return `${fieldExpression(filter.field)} IN (${names.join(", ")})`;
    }
    case "contains": {
      const field = fieldExpression(filter.field);
      if (filter.ignoreCase) {
        return `CONTAINS(LOWER(${field}), ${params.forField(filter.field, filter.value.toLowerCase())})`;
      }
      return `CONTAINS(${field}, ${params.forField(filter.field, filter.value)})`;
    }
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const value = filter.value === null ? "null" : params.forField(filter.field, filter.value as JSONValue);
      return `${fieldExpression(filter.field)} ${COMPARATORS[filter.op]} ${value}`;
    }
    default:
      throw new StorageError("BadRequest", `unknown filter op "${(filter as { op: string }).op}"`);
  }
}

/** A WHERE clause (without the keyword) for `filter`. */
export function compileFilter(filter: Filter, params = new Parameters()): { sql: string; parameters: SqlParameter[] } {
  return { sql: compileNode(filter, params), parameters: params.list };
}

function where(filter: Filter | undefined, params: Parameters): string {
  if (!filter) return "";
  if (filter.op === "and" && flatten("and", filter.filters).length === 0) return "";
  return ` WHERE ${compileNode(filter, params)}`;
}

/** Projection columns; keys were validated by checkQuery (identifiers, no keywords, distinct). */
function projection(select: Selection[]): string[] {
  return select.map((selection) => {
    const field = typeof selection === "string" ? selection : selection.field;
    const key = selectionKey(selection);
    const segments = fieldSegments(field);
    return key === segments[segments.length - 1] ? fieldExpression(field) : `${fieldExpression(field)} AS ${key}`;
  });
}

function top(limit: number | undefined): string {
  checkLimit(limit);
  return limit === undefined ? "" : ` TOP ${limit}`;
}

/** `SELECT ... FROM c WHERE ... ORDER BY ...` for a query. */
export function compileQuery(query: Query = {}): SqlQuerySpec {
  checkQuery(query);
  const params = new Parameters();
  const columns = query.select ? projection(query.select).join(", ") : "*";
  let sql = `SELECT${top(query.limit)} ${columns} FROM c${where(query.where, params)}`;
  if (query.orderBy) {
    const direction = query.orderBy.direction === "asc" ? " ASC" : query.orderBy.direction === "desc" ? " DESC" : "";
    sql += ` ORDER BY ${fieldExpression(query.orderBy.field)}${direction}`;
  }
  return { query: sql, parameters: params.list };
}

/** `SELECT VALUE COUNT(1) FROM c WHERE ...`. */
export function compileCount(query: CountQuery = {}): SqlQuerySpec {
  checkQuery(query);
  const params = new Parameters();
  return { query: `SELECT VALUE COUNT(1) FROM c${where(query.where, params)}`, parameters: params.list };
}

function vectorField(spec: CollectionSpec): string {
  return fieldExpression(spec.vector!.field);
}

/**
 * A vector search: the similarity is selected under `scoreAlias`
 * ("vectorDistance" unless the projection uses that name) and the document,
 * without `select`, as `document`. Cosmos' cosine VectorDistance is a
 * similarity, and ORDER BY VectorDistance lists the closest first.
 */
export function compileVectorSearch(
  spec: CollectionSpec,
  query: VectorSearchQuery,
): { spec: SqlQuerySpec; scoreAlias: string } {
  checkQuery({ partitionKey: query.partitionKey, where: query.where, select: query.select });
  checkVectorSearch(spec, query);
  const params = new Parameters();
  const vector = params.add("vector", query.vector);
  const distance = `VectorDistance(${vectorField(spec)}, ${vector})`;
  const columns = query.select ? projection(query.select) : [`c AS ${DOCUMENT_ALIAS}`];
  const taken = new Set(query.select?.map(selectionKey) ?? []);
  let scoreAlias = SCORE_ALIAS;
  for (let i = 1; taken.has(scoreAlias); i++) scoreAlias = `${SCORE_ALIAS}${i}`;
  const sql =
    `SELECT${top(query.limit)} ${[...columns, `${distance} AS ${scoreAlias}`].join(", ")} ` +
    `FROM c${where(query.where, params)} ORDER BY ${distance}`;
  return { spec: { query: sql, parameters: params.list }, scoreAlias };
}

/** A hybrid search: `ORDER BY RANK RRF(FullTextScore(...), VectorDistance(...), [weights])`. */
export function compileHybridSearch(spec: CollectionSpec, query: HybridSearchQuery): SqlQuerySpec {
  checkQuery({ partitionKey: query.partitionKey, where: query.where, select: query.select });
  checkHybridSearch(spec, query);
  const params = new Parameters();
  const columns = query.select ? projection(query.select).join(", ") : "*";
  const whereSql = where(query.where, params);
  const scores = query.rank.map((component) => {
    if (component.kind === "vector") return `VectorDistance(${vectorField(spec)}, ${params.add("vector", component.vector)})`;
    const terms = component.terms.map((term) => params.add("term", term));
    return `FullTextScore(${fieldExpression(component.field)}, ${terms.join(", ")})`;
  });
  let order: string;
  if (scores.length === 1) {
    order = query.rank[0].kind === "vector" ? scores[0] : `RANK ${scores[0]}`;
  } else {
    const weights = query.weights ? `, [${query.weights.join(", ")}]` : "";
    order = `RANK RRF(${scores.join(", ")}${weights})`;
  }
  return {
    query: `SELECT${top(query.limit)} ${columns} FROM c${whereSql} ORDER BY ${order}`,
    parameters: params.list,
  };
}
