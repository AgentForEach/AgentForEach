/**
 * AgentForEach Storage — Cosmos DB adapter (public API)
 *
 *   - `CosmosStorage`: the `StorageAdapter` for Azure Cosmos DB for NoSQL
 *   - `storageAdapter`: plugin entry for `createStorageAdapter("cosmosdb")`
 *   - `toContainerDefinition`: CollectionSpec -> container definition (IaC catalog)
 *   - the query compiler, for inspection and tests
 */

export { CosmosCollection, CosmosStorage, storageAdapter, type CosmosStorageOptions } from "./adapter.js";
export {
  DOCUMENT_ALIAS,
  SCORE_ALIAS,
  compileCount,
  compileFilter,
  compileHybridSearch,
  compileQuery,
  compileVectorSearch,
  fieldExpression,
} from "./compile.js";
export {
  cosmosOptions,
  jsonPath,
  toContainerDefinition,
  type CosmosCollectionOptions,
  type CosmosContainerDefinition,
  type CosmosIndexingPolicy,
} from "./definition.js";
export { cosmosStatus, toStorageError } from "./errors.js";
