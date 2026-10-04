/**
 * AgentForEach Storage — PostgreSQL adapter (public API)
 *
 *   - `PostgresStorage`: the `StorageAdapter` for PostgreSQL with pgvector
 *   - `storageAdapter`: plugin entry for `createStorageAdapter("postgres")`
 *   - `schemaSql`: CollectionSpec -> DDL (migrations, infrastructure)
 *   - the query compiler, for inspection and tests
 */

export {
  PostgresCollection,
  PostgresStorage,
  createPool,
  storageAdapter,
  type PoolOptions,
  type PoolSource,
  type PostgresStorageOptions,
} from "./adapter.js";
export {
  LIVE,
  SCORE_COLUMN,
  compileCount,
  compileFilter,
  compileFind,
  compileHybridSearch,
  compileVectorSearch,
  fieldExpression,
  type SqlStatement,
} from "./compile.js";
export {
  createTableSql,
  embeddingOf,
  fullTextColumn,
  schemaSql,
  tableColumns,
  tableIndexes,
  tableName,
  textSearchConfig,
  type SchemaSqlOptions,
} from "./schema.js";
export { sqlState, toStorageError } from "./errors.js";
