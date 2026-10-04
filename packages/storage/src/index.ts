/**
 * AgentForEach Storage SDK — Public API
 *
 *   - Contract: `StorageAdapter`, `Collection`, `CollectionSpec`, `Query`...
 *   - Filters: `eq`, `and`, `missing`, `present`... (`./filter.ts`)
 *   - Errors: `StorageError` and `isNotFound` / `isConflict` / ...
 *   - `mutate`: optimistic read-modify-write with retries
 *   - Registry: `createStorageAdapter`, `registerStorageAdapter`
 *   - `InMemoryStorage`: the reference adapter (tests, local development)
 *   - Reference semantics and ranking helpers for adapter authors
 *
 * The conformance suite lives at `@agentforeach/storage/conformance`.
 */

export type {
  Collection,
  CollectionSpec,
  CountQuery,
  Doc,
  FullTextPolicy,
  HybridSearchQuery,
  OrderBy,
  PatchOperation,
  Query,
  RankComponent,
  Selection,
  StorageAdapter,
  StorageCapabilities,
  Stored,
  VectorPolicy,
  VectorSearchQuery,
  VectorSearchResult,
  WriteCondition,
} from "./types.js";
export { MAX_PATCH_OPERATIONS, SYSTEM_FIELDS } from "./types.js";

export {
  FORBIDDEN_NAMES,
  and,
  checkJsonValue,
  contains,
  eq,
  fieldSegments,
  gt,
  gte,
  isDefined,
  lt,
  lte,
  missing,
  ne,
  not,
  oneOf,
  or,
  present,
  type ComparisonOp,
  type FieldPath,
  type Filter,
  type JsonValue,
} from "./filter.js";

export {
  StorageError,
  isConflict,
  isNotFound,
  isPreconditionFailed,
  isThrottled,
  type StorageErrorCode,
} from "./errors.js";

export { mutate, type MutateOptions, type MutateResult } from "./mutate.js";

export {
  createStorageAdapter,
  getRegisteredStorageAdapters,
  registerStorageAdapter,
  type StorageAdapterFactory,
  type StorageAdapterOptions,
  type StorageAdapterPlugin,
} from "./registry.js";

export {
  InMemoryCollection,
  InMemoryStorage,
  type InMemoryStorageOptions,
  type OperationContext,
  type OperationHook,
} from "./memory/adapter.js";

export {
  RESERVED_WORDS,
  applyPatch,
  checkCollectionSpec,
  checkFilter,
  checkHybridSearch,
  checkLimit,
  checkPatch,
  checkPatchTargets,
  checkQuery,
  checkSelection,
  checkVectorSearch,
  clone,
  compareForOrder,
  evaluateFilter,
  expiresAtMs,
  jsonEqual,
  matches,
  patchDocument,
  prepareReplace,
  prepareWrite,
  project,
  readField,
  selectionKey,
  sortDocuments,
  typeRank,
} from "./semantics.js";

export { RRF_K, bm25Scores, cosineSimilarity, denseRanks, fuseRanks, reciprocalRankFusion, tokenize } from "./ranking.js";
