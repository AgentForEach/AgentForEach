/**
 * AgentForEach Storage — PostgreSQL query compiler
 *
 * Compiles the storage SDK's queries to parameterized SQL over one table per
 * collection (see `schema.ts`): the document is a `jsonb` column, and a
 * field is `t.doc #> '{a,b}'`, which is SQL NULL when the field is absent.
 * That makes SQL's own three-valued logic the contract's:
 *
 *   - absent is SQL NULL (unknown) and JSON null is the jsonb value `null`,
 *     so the two stay different;
 *   - `eq` / `ne` / `in` are jsonb equality, which is type-strict (1 is not
 *     "1") and structural for arrays and objects;
 *   - ranges compare only within one type (numbers, booleans, null with
 *     null, strings in byte order via COLLATE "C"); across types they are
 *     NULL (unknown), as in Cosmos DB, so `NOT` cannot turn them true;
 *   - WHERE keeps only rows whose condition is TRUE.
 *
 * ORDER BY sorts absent < null < boolean < number < string, as Cosmos does.
 * Every query also hides expired rows (`expires_at`), which the adapter's
 * sweeper deletes later. Field paths are identifiers (validated by the SDK),
 * so they are written into the SQL as literals; every value is a parameter.
 */

import {
  RRF_K,
  StorageError,
  checkHybridSearch,
  checkQuery,
  checkVectorSearch,
  tokenize,
  type CollectionSpec,
  type CountQuery,
  type Filter,
  type HybridSearchQuery,
  type JsonValue,
  type OrderBy,
  type Query,
  type Selection,
  type VectorSearchQuery,
} from "@agentforeach/storage";
import { fullTextColumn, pathLiteral, textSearchConfig } from "./schema.js";

/** A statement for `pg`: text with $n placeholders and their values. */
export type SqlStatement = { text: string; values: unknown[] };

/** Rows that have not expired. `now()` is the database clock, as for writes. */
export const LIVE = "(t.expires_at IS NULL OR t.expires_at > now())";

/** Output column of the similarity in vector searches. */
export const SCORE_COLUMN = "_score";

/** Output column of the i-th projected field (`c0`, `c1`...). */
export const projectedColumn = (i: number): string => `c${i}`;

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * JSON text for a jsonb value. PostgreSQL stores UTF-8, so a lone UTF-16
 * surrogate (half an emoji, say, from a cut string) becomes U+FFFD, as text
 * columns do, instead of failing the write. Filter values get the same
 * treatment, so they still equal what was stored.
 */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    typeof member === "string" ? member.replace(LONE_SURROGATE, "\ufffd") : member,
  );
}

/** Positional parameters, `$1`, `$2`..., with an optional cast. */
export class Parameters {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value);
    const ref = `$${this.values.length}`;
    return cast ? `${ref}::${cast}` : ref;
  }

  json(value: JsonValue): string {
    return this.add(toJsonText(value), "jsonb");
  }
}

/** The field as jsonb: `(t.doc #> '{a,b}'::text[])`, NULL when absent. */
export function fieldExpression(path: string): string {
  return `(t.doc #> ${pathLiteral(path)})`;
}

/** The field as text (a string field's value), NULL when absent. */
function textExpression(path: string): string {
  return `(t.doc #>> ${pathLiteral(path)})`;
}

const COMPARATORS = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;

/** A comparison only within the value's own type; NULL (unknown) across types. */
function range(op: "lt" | "lte" | "gt" | "gte", path: string, value: JsonValue, params: Parameters): string {
  const field = fieldExpression(path);
  const sqlOp = COMPARATORS[op];
  if (value === null) {
    // null compares only with null, and is equal to it: null <= null.
    return `(CASE WHEN jsonb_typeof(${field}) = 'null' THEN ${op === "lte" || op === "gte" ? "TRUE" : "FALSE"} END)`;
  }
  if (typeof value === "string") {
    return `(CASE WHEN jsonb_typeof(${field}) = 'string' THEN ${textExpression(path)} COLLATE "C" ${sqlOp} ${params.add(value, "text")} END)`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    // jsonb orders numbers numerically and false before true.
    return `(CASE WHEN jsonb_typeof(${field}) = '${typeof value}' THEN ${field} ${sqlOp} ${params.json(value)} END)`;
  }
  // Arrays and objects have no order: always unknown.
  return "(NULL::boolean)";
}

function compileNode(filter: Filter, params: Parameters): string {
  switch (filter.op) {
    case "and":
    case "or": {
      if (filter.filters.length === 0) return filter.op === "and" ? "TRUE" : "FALSE";
      const children = filter.filters.map((child) => compileNode(child, params));
      return children.length === 1 ? children[0] : `(${children.join(filter.op === "and" ? " AND " : " OR ")})`;
    }
    case "not":
      return `(NOT ${compileNode(filter.filter, params)})`;
    case "isDefined":
      return `(${fieldExpression(filter.field)} IS NOT NULL)`;
    case "in": {
      if (filter.values.length === 0) return "FALSE";
      return `(${fieldExpression(filter.field)} IN (${filter.values.map((v) => params.json(v)).join(", ")}))`;
    }
    case "contains": {
      const field = fieldExpression(filter.field);
      const text = textExpression(filter.field);
      // Both sides folded by the database's lower(), so they fold alike.
      const haystack = filter.ignoreCase ? `lower(${text})` : text;
      const needle = filter.ignoreCase ? `lower(${params.add(filter.value, "text")})` : params.add(filter.value, "text");
      return `(CASE WHEN jsonb_typeof(${field}) = 'string' THEN strpos(${haystack}, ${needle}) > 0 END)`;
    }
    case "eq":
    case "ne":
      return `(${fieldExpression(filter.field)} ${COMPARATORS[filter.op]} ${params.json(filter.value)})`;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return range(filter.op, filter.field, filter.value, params);
    default:
      throw new StorageError("BadRequest", `unknown filter op "${(filter as { op: string }).op}"`);
  }
}

/** A boolean SQL expression for `filter` (callers validate it first). */
export function compileFilter(filter: Filter, params = new Parameters()): SqlStatement {
  return { text: compileNode(filter, params), values: params.values };
}

/** ` WHERE <partition> AND <live> AND <filter>` over the table aliased `t`. */
function whereClause(query: Pick<Query, "partitionKey" | "where">, params: Parameters): string {
  const terms: string[] = [];
  if (query.partitionKey !== undefined) terms.push(`t.pk = ${params.add(query.partitionKey, "text")}`);
  terms.push(LIVE);
  if (query.where && !(query.where.op === "and" && query.where.filters.length === 0)) {
    terms.push(compileNode(query.where, params));
  }
  return ` WHERE ${terms.join(" AND ")}`;
}

/**
 * Last sort key everywhere: rows that tie (equal values, equal scores) come
 * in a stable order, so a limit cuts the same rows on every call.
 */
const TIEBREAK = "t.pk, t.id";

/** Type rank, then the value within its type: absent < null < boolean < number < string. */
function orderClause(orderBy: OrderBy): string {
  const field = fieldExpression(orderBy.field);
  const direction = orderBy.direction === "desc" ? "DESC" : "ASC";
  const typeRank =
    `CASE jsonb_typeof(${field}) WHEN 'null' THEN 1 WHEN 'boolean' THEN 2 WHEN 'number' THEN 3 ` +
    `WHEN 'string' THEN 4 WHEN 'array' THEN 5 WHEN 'object' THEN 6 ELSE 0 END`;
  const scalar = `CASE WHEN jsonb_typeof(${field}) IN ('boolean', 'number') THEN ${field} END`;
  const text = `(CASE WHEN jsonb_typeof(${field}) = 'string' THEN ${textExpression(orderBy.field)} END) COLLATE "C"`;
  return ` ORDER BY ${typeRank} ${direction}, ${scalar} ${direction}, ${text} ${direction}, ${TIEBREAK}`;
}

/**
 * Projected fields as text columns `c0`, `c1`...: SQL NULL when the field is
 * absent, its JSON text otherwise (so a JSON null comes back as "null").
 */
function projection(select: Selection[]): string {
  return select
    .map((selection, i) => {
      const field = typeof selection === "string" ? selection : selection.field;
      return `${fieldExpression(field)}::text AS ${projectedColumn(i)}`;
    })
    .join(", ");
}

function columns(select: Selection[] | undefined): string {
  return select ? projection(select) : "t.doc, t.etag";
}

/** `SELECT ... FROM <table> t WHERE ... ORDER BY ... LIMIT n`. */
export function compileFind(table: string, query: Query = {}): SqlStatement {
  checkQuery(query);
  const params = new Parameters();
  let text = `SELECT ${columns(query.select)} FROM ${table} t${whereClause(query, params)}`;
  if (query.orderBy) text += orderClause(query.orderBy);
  if (query.limit !== undefined) text += ` LIMIT ${query.limit}`;
  return { text, values: params.values };
}

/** `SELECT count(*) FROM <table> t WHERE ...`. */
export function compileCount(table: string, query: CountQuery = {}): SqlStatement {
  checkQuery(query);
  const params = new Parameters();
  return { text: `SELECT count(*) AS n FROM ${table} t${whereClause(query, params)}`, values: params.values };
}

/** A pgvector literal, `[1,0.5,0]`. */
export function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

/**
 * Cosine similarity with the query vector (-1..1), or NULL when the row has
 * no vector of the collection's size. pgvector's distance is NaN when either
 * vector is all zeros; that scores 0, as `cosineSimilarity` does.
 */
function vectorScore(spec: CollectionSpec, vector: readonly number[], params: Parameters): string {
  const query = params.add(vectorLiteral(vector), "vector");
  return (
    `(CASE WHEN vector_dims(t.embedding) = ${spec.vector!.dimensions} ` +
    `THEN coalesce(nullif(1 - (t.embedding <=> ${query}), 'NaN'::float8), 0) END)`
  );
}

/**
 * A vector search: rows by similarity, best first, rows without a usable
 * vector last with a NULL score. Exact (no approximate index), so a filter
 * never leaves fewer results than the limit.
 */
export function compileVectorSearch(table: string, spec: CollectionSpec, query: VectorSearchQuery): SqlStatement {
  checkQuery({ partitionKey: query.partitionKey, where: query.where, select: query.select });
  checkVectorSearch(spec, query);
  const params = new Parameters();
  const score = vectorScore(spec, query.vector, params);
  const text =
    `SELECT ${columns(query.select)}, ${score} AS ${SCORE_COLUMN} FROM ${table} t${whereClause(query, params)} ` +
    `ORDER BY ${SCORE_COLUMN} DESC NULLS LAST, ${TIEBREAK} LIMIT ${query.limit}`;
  return { text, values: params.values };
}

/**
 * Full-text relevance of a field: `ts_rank_cd` of its generated tsvector
 * column against the terms' words, any of which may match (0 when none do).
 * Words are split as the SDK's BM25 splits them (letters, digits and
 * combining marks), so the tsquery text holds no operators of its own.
 */
function fullTextScore(spec: CollectionSpec, field: string, terms: string[], params: Parameters): string {
  const config = textSearchConfig(spec.fullText!.language);
  const words = [...new Set(terms.flatMap(tokenize))];
  const query = `to_tsquery('${config}'::regconfig, ${params.add(words.join(" | "), "text")})`;
  return `ts_rank_cd(t."${fullTextColumn(field, config)}", ${query})`;
}

/**
 * A hybrid search: every candidate (live, in scope, passing the filter) is
 * ranked by each component, with dense ranks (equal scores share a rank;
 * rows without a vector rank last), and ordered by the weighted reciprocal
 * rank fusion sum(weight_i / (60 + rank_i)), as Cosmos DB's RRF.
 */
export function compileHybridSearch(table: string, spec: CollectionSpec, query: HybridSearchQuery): SqlStatement {
  checkQuery({ partitionKey: query.partitionKey, where: query.where, select: query.select });
  const weights = checkHybridSearch(spec, query);
  const params = new Parameters();
  const ranks = query.rank.map((component, i) => {
    const score =
      component.kind === "vector"
        ? vectorScore(spec, component.vector, params)
        : fullTextScore(spec, component.field, component.terms, params);
    return `dense_rank() OVER (ORDER BY ${score} DESC NULLS LAST) AS r${i}`;
  });
  const output = query.select ? query.select.map((_, i) => `t.${projectedColumn(i)}`).join(", ") : "t.doc, t.etag";
  const fused = weights.map((weight, i) => `${params.add(weight, "float8")} / (${RRF_K} + t.r${i})`).join(" + ");
  const text =
    `SELECT ${output} FROM (SELECT ${columns(query.select)}, t.pk, t.id, ${ranks.join(", ")} ` +
    `FROM ${table} t${whereClause(query, params)}) t ORDER BY ${fused} DESC, ${TIEBREAK} LIMIT ${query.limit}`;
  return { text, values: params.values };
}
