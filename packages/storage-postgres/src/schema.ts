/**
 * AgentForEach Storage — PostgreSQL schema
 *
 * One table per collection, named exactly as the collection (quoted, so
 * "rate-limits" stays "rate-limits"):
 *
 *   pk          text         the partition key value
 *   id          text         unique within the partition: PRIMARY KEY (pk, id)
 *   doc         jsonb        the document, as written (without `_etag`)
 *   etag        text         version token, new on every write
 *   expires_at  timestamptz  when TTL hides the row (NULL: never)
 *   embedding   vector       collections with a vector policy: the vector
 *                            field, when it holds `dimensions` numbers
 *   "fts:<config>:<field>"   tsvector, generated from each full-text field
 *
 * The vector stays in `doc` too, so documents read back exactly as written
 * (pgvector stores float32). The `embedding` column has no fixed size: a
 * change of embedding model leaves old rows unscored instead of failing
 * writes. Vector search is exact, so there is no vector index; there is no
 * GIN index either, because hybrid search ranks every candidate.
 *
 * Indexes: the primary key (every point operation and partition-scoped
 * query), `expires_at` for the TTL sweeper, and a btree on each field in
 * the spec's `indexes` (equality filters on it can use the index).
 */

import { createHash } from "node:crypto";
import { StorageError, checkCollectionSpec, fieldSegments, readField, type CollectionSpec } from "@agentforeach/storage";

/** Longest identifier PostgreSQL keeps (NAMEDATALEN - 1 bytes). */
const MAX_IDENTIFIER_BYTES = 63;

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A quoted identifier. */
export function quoteIdentifier(name: string): string {
  if (Buffer.byteLength(name, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new StorageError("BadRequest", `postgres: identifier "${name}" is longer than ${MAX_IDENTIFIER_BYTES} bytes`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Validate a schema name (an unquoted identifier). */
export function checkSchemaName(schema: string): string {
  if (typeof schema !== "string" || !SCHEMA_NAME.test(schema)) {
    throw new StorageError("BadRequest", `postgres: invalid schema name "${String(schema)}"`);
  }
  return schema;
}

/** `"schema"."collection"`. */
export function tableName(spec: CollectionSpec, schema: string): string {
  return `${quoteIdentifier(checkSchemaName(schema))}.${quoteIdentifier(spec.name)}`;
}

/**
 * An index name: readable, within the 63-byte limit, and carrying a hash of
 * the collection and the exact purpose. Index names share one namespace with
 * every table and index in the schema, so without the hash an index of one
 * collection could take the name of another collection's table or index
 * (`x` + "doc_a_b" vs `x_doc` + "a_b"), and IF NOT EXISTS would hide it.
 */
function indexName(spec: CollectionSpec, purpose: string): string {
  const hash = createHash("sha256").update(`${spec.name}\u0000${purpose}`).digest("hex").slice(0, 10);
  const readable = purpose.replace(/\./g, "_");
  return `${spec.name.slice(0, 24)}_${readable.slice(0, 24)}_${hash}`;
}

/**
 * A field path as a PostgreSQL `text[]` literal, `'{"a","b"}'::text[]`.
 * Elements are quoted: an unquoted element spelled NULL (any case) would be
 * a SQL NULL, and the path would never match. Segments are identifiers
 * (validated by the SDK), so they contain no quotes or backslashes.
 */
export function pathLiteral(path: string): string {
  return `'{${fieldSegments(path).map((segment) => `"${segment}"`).join(",")}}'::text[]`;
}

/**
 * Built-in text search configurations (PostgreSQL 13 and later, as pgvector
 * requires) by BCP 47 primary language subtag.
 */
const TEXT_SEARCH_CONFIGS: Record<string, string> = {
  ar: "arabic", ca: "catalan", da: "danish", de: "german", el: "greek", en: "english",
  es: "spanish", eu: "basque", fi: "finnish", fr: "french", ga: "irish", hi: "hindi",
  hu: "hungarian", hy: "armenian", id: "indonesian", it: "italian", lt: "lithuanian",
  ne: "nepali", nl: "dutch", no: "norwegian", nb: "norwegian", nn: "norwegian",
  pt: "portuguese", ro: "romanian", ru: "russian", sr: "serbian", sv: "swedish",
  ta: "tamil", tr: "turkish", yi: "yiddish",
};

/**
 * The text search configuration for a full-text policy's language: the
 * language's stemmer ("en-US" -> english), or `simple` (lower-cased words,
 * no stemming) for languages without one.
 */
export function textSearchConfig(language: string): string {
  const primary = String(language).toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(TEXT_SEARCH_CONFIGS, primary) ? TEXT_SEARCH_CONFIGS[primary] : "simple";
}

/** Generated tsvector column of a full-text field. */
export function fullTextColumn(field: string, config: string): string {
  const name = `fts:${config}:${fieldSegments(field).join(".")}`;
  quoteIdentifier(name); // length check
  return name;
}

function fullTextColumns(spec: CollectionSpec): Array<{ name: string; definition: string }> {
  if (!spec.fullText) return [];
  const config = textSearchConfig(spec.fullText.language);
  return spec.fullText.fields.map((field) => {
    const path = pathLiteral(field);
    const text = `CASE WHEN jsonb_typeof(doc #> ${path}) = 'string' THEN doc #>> ${path} ELSE '' END`;
    return {
      name: fullTextColumn(field, config),
      definition: `tsvector GENERATED ALWAYS AS (to_tsvector('${config}'::regconfig, ${text})) STORED`,
    };
  });
}

export type ColumnDefinition = { name: string; definition: string };
export type IndexDefinition = { name: string; sql: string };

/** The columns a collection's table needs. */
export function tableColumns(spec: CollectionSpec): ColumnDefinition[] {
  return [
    { name: "pk", definition: "text NOT NULL" },
    { name: "id", definition: "text NOT NULL" },
    { name: "doc", definition: "jsonb NOT NULL" },
    { name: "etag", definition: "text NOT NULL" },
    { name: "expires_at", definition: "timestamptz" },
    ...(spec.vector ? [{ name: "embedding", definition: "vector" }] : []),
    ...fullTextColumns(spec),
  ];
}

/** The secondary indexes a collection's table needs. */
export function tableIndexes(spec: CollectionSpec, schema = "public"): IndexDefinition[] {
  const table = tableName(spec, schema);
  const indexes: IndexDefinition[] = [];
  if (spec.defaultTtl !== undefined) {
    const name = indexName(spec, "expires_at");
    indexes.push({
      name,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${table} (expires_at) WHERE expires_at IS NOT NULL`,
    });
  }
  for (const field of spec.indexes ?? []) {
    const name = indexName(spec, `doc.${fieldSegments(field).join(".")}`);
    indexes.push({
      name,
      sql: `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(name)} ON ${table} ((doc #> ${pathLiteral(field)}))`,
    });
  }
  return indexes;
}

export type SchemaSqlOptions = {
  /** Schema holding the tables. Default "public". */
  schema?: string;
};

/**
 * The DDL that creates a collection's table and indexes, or brings a table
 * from an older release up to the spec, idempotently (IF NOT EXISTS), for
 * migrations and infrastructure code. Collections with a vector policy need
 * the pgvector extension, created first. Nothing is ever dropped.
 */
export function schemaSql(spec: CollectionSpec, options: SchemaSqlOptions = {}): string[] {
  checkCollectionSpec(spec);
  const schema = checkSchemaName(options.schema ?? "public");
  const table = tableName(spec, schema);
  return [
    ...(spec.vector ? ["CREATE EXTENSION IF NOT EXISTS vector"] : []),
    // Not for "public", which exists: CREATE SCHEMA IF NOT EXISTS still needs
    // CREATE on the database, which a role that only creates tables lacks.
    ...(schema === "public" ? [] : [`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`]),
    createTableSql(spec, schema),
    // A table created by an older release gets the columns a newer spec adds
    // (a vector policy, a full-text field); on a new table these do nothing.
    ...tableColumns(spec)
      .filter((column) => !BASE_COLUMNS.has(column.name))
      .map((column) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column.name)} ${column.definition}`),
    ...tableIndexes(spec, schema).map((index) => index.sql),
  ];
}

/** Columns every table has from the start. */
const BASE_COLUMNS = new Set(["pk", "id", "doc", "etag", "expires_at"]);

/** `CREATE TABLE IF NOT EXISTS` with every column the spec needs. */
export function createTableSql(spec: CollectionSpec, schema = "public"): string {
  const columns = tableColumns(spec).map((c) => `${quoteIdentifier(c.name)} ${c.definition}`);
  return `CREATE TABLE IF NOT EXISTS ${tableName(spec, schema)} (${columns.join(", ")}, PRIMARY KEY (pk, id))`;
}

/** Largest magnitude float32 holds; pgvector refuses anything larger. */
function fitsFloat32(x: unknown): boolean {
  return typeof x === "number" && Number.isFinite(Math.fround(x));
}

/**
 * The `embedding` column value for a document: its vector field when that is
 * an array of exactly `dimensions` numbers (float32 range), else NULL, which
 * vector search ranks last, unscored.
 */
export function embeddingOf(spec: CollectionSpec, doc: Record<string, unknown>): number[] | null {
  if (!spec.vector) return null;
  const vector = readField(doc, spec.vector.field);
  return Array.isArray(vector) && vector.length === spec.vector.dimensions && vector.every(fitsFloat32)
    ? (vector as number[])
    : null;
}
