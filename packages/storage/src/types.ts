/**
 * AgentForEach Storage SDK — Contract
 *
 * The document-store contract every database adapter implements. It is the
 * set of primitives the AgentForEach runtime actually relies on, no more:
 *
 *   - collections of JSON documents keyed by (partition key, id);
 *   - point reads and writes, `create` failing with Conflict;
 *   - optimistic concurrency on a per-document version token (`_etag`);
 *   - atomic patches, including a server-side increment;
 *   - TTL: a collection default plus a per-document `ttl`, counted from the
 *     last write, with expired documents invisible at once;
 *   - filtered queries within one partition or across partitions, ordered by
 *     one field, limited, optionally projected, and counted;
 *   - vector search (cosine) and, optionally, hybrid full-text + vector
 *     search fused with weighted reciprocal rank fusion.
 *
 * No multi-document transactions, joins, change feeds or pagination: the
 * runtime does not use them, so adapters need not provide them.
 *
 * Semantics follow Cosmos DB, the original backend, so that moving to
 * another adapter changes nothing the runtime can observe. The conformance
 * suite (`@agentforeach/storage/conformance`) checks every rule.
 */

import type { FieldPath, Filter, JsonValue } from "./filter.js";

// ============================================================================
// Documents
// ============================================================================

/**
 * A stored document. `id` is unique within its partition. Two fields are
 * reserved:
 *
 *   - `ttl`: seconds the document lives after its last write, overriding the
 *     collection default: -1 (never) or 1..2147483647. Ignored when the
 *     collection has no `defaultTtl` (TTL off), as in Cosmos DB.
 *   - `_etag`: the version token, set by the adapter on every document it
 *     returns and ignored on writes (pass it as `ifMatch` instead). Adapters
 *     return no other system fields.
 *
 * Portable limits, enforced by every adapter: ids are non-empty strings of
 * at most 1023 UTF-8 bytes without `/`, `\`, `?` or `#` (Cosmos itself
 * allows `?` and `#`, but they break URL-addressed point operations in
 * several SDKs); partition key values are strings of at most 2048 bytes.
 */
export type Doc = {
  id: string;
  ttl?: number;
  _etag?: string;
  [key: string]: unknown;
};

/** A document as an adapter returns it: always with its current `_etag`. */
export type Stored<T extends Doc> = T & { _etag: string };

/**
 * System fields adapters drop from documents before writing them. `_etag`
 * is the contract's own; the others are Cosmos DB's, which documents read
 * from Cosmos carry back into later writes.
 */
export const SYSTEM_FIELDS = ["_etag", "_ts", "_rid", "_self", "_attachments", "_lsn"] as const;

// ============================================================================
// Collections
// ============================================================================

export type VectorPolicy = {
  /** Field holding the embedding (an array of numbers). */
  field: FieldPath;
  dimensions: number;
  distance: "cosine";
  dataType?: "float32";
};

export type FullTextPolicy = {
  /** Fields that full-text ranking may score. */
  fields: FieldPath[];
  /** BCP 47 language tag, e.g. "en-US". */
  language: string;
};

/**
 * A collection as the runtime defines it. Adapters create it from this
 * definition (or, when provisioning is left to infrastructure, expect it to
 * exist with this shape).
 */
export type CollectionSpec = {
  /** Collection name (Cosmos container id, Postgres table name...). */
  name: string;
  /** Field holding the partition key. Its value must be a string. */
  partitionKey: FieldPath;
  /**
   * Cosmos DB TTL semantics:
   *   - undefined: TTL off; documents never expire, even with a `ttl` field;
   *   - -1: TTL on, documents live forever unless they set `ttl`;
   *   - n > 0: documents expire n seconds after their last write unless
   *     they set their own `ttl`.
   */
  defaultTtl?: number;
  vector?: VectorPolicy;
  fullText?: FullTextPolicy;
  /**
   * Fields the runtime filters or orders on. Adapters that need explicit
   * indexes (Postgres) create them; adapters that index everything (Cosmos)
   * may ignore this.
   */
  indexes?: FieldPath[];
  /** Fields never queried (large text, secrets): adapters may skip indexing them. */
  unindexed?: FieldPath[];
  /**
   * Adapter-specific settings keyed by adapter name, e.g.
   * `{ cosmosdb: { indexingPolicy } }`. Other adapters ignore them.
   */
  adapterOptions?: Record<string, unknown>;
};

// ============================================================================
// Queries
// ============================================================================

/**
 * A projected field: a path (output key = its last segment, as in Cosmos
 * `SELECT c.a.b` -> "b") or a path with an alias. Fields absent from a
 * document are absent from its projection.
 */
export type Selection = FieldPath | { field: FieldPath; as: string };

export type OrderBy = { field: FieldPath; direction?: "asc" | "desc" };

export type Query = {
  /** Restrict to one partition; omitted means across all partitions. */
  partitionKey?: string;
  where?: Filter;
  /**
   * One sort field. Documents where the field is absent are kept: first
   * ascending, last descending (verified on Cosmos DB). Values of different
   * types order absent < null < boolean < number < string (ordinal). Sort on
   * fields holding booleans, numbers or strings: arrays and objects have no
   * portable order. Ties have no defined order.
   */
  orderBy?: OrderBy;
  /** At most this many results (applied after ordering). */
  limit?: number;
  /** Project these fields instead of returning whole documents. */
  select?: Selection[];
};

export type CountQuery = Pick<Query, "partitionKey" | "where">;

// ============================================================================
// Patches
// ============================================================================

/** Most operations one `patch` accepts, on every adapter (Cosmos DB's limit). */
export const MAX_PATCH_OPERATIONS = 10;

/**
 * Patch operations, with JSON-pointer paths ("/count", "/data/name").
 * Applied atomically, in order, to one document; at most
 * MAX_PATCH_OPERATIONS. Paths address object members: segments that are
 * array indexes (`0`, `-`) or JSON-pointer escapes (`~`) are refused.
 *
 *   - set: create or overwrite the field (its parent must exist);
 *   - remove: delete the field (BadRequest if it is absent);
 *   - incr: add `value` to a number field server-side (an absent field
 *     starts from 0; BadRequest on a non-number). Concurrent increments
 *     never lose an update.
 */
export type PatchOperation =
  /** `value`: anything JSON-serializable (undefined members vanish, as in writes). */
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "incr"; path: string; value: number };

export type WriteCondition = {
  /** Only write if the document's current `_etag` equals this; else PreconditionFailed. */
  ifMatch?: string;
};

// ============================================================================
// Vector and hybrid search
// ============================================================================

export type VectorSearchQuery = {
  partitionKey?: string;
  where?: Filter;
  /** Query embedding; its length must match the collection's dimensions. */
  vector: number[];
  limit: number;
  select?: Selection[];
};

/**
 * Results are ordered by score, best first. Adapters may use approximate
 * indexes (Cosmos diskANN), so the true nearest neighbours are not
 * guaranteed. Documents without a vector of the right size come after all
 * others with a null score (as Cosmos DB returns them).
 */
export type VectorSearchResult<R> = {
  document: R;
  /** Cosine similarity, -1..1, higher is closer; null without a vector. */
  score: number | null;
};

/** One ranking fed into hybrid search's reciprocal rank fusion. */
export type RankComponent =
  | {
      kind: "fullText";
      /** A field listed in the collection's full-text policy. */
      field: FieldPath;
      /** Terms scored with BM25 (any term may match). */
      terms: string[];
    }
  | { kind: "vector"; vector: number[] };

export type HybridSearchQuery = {
  partitionKey?: string;
  where?: Filter;
  /**
   * Rankings fused as score = sum(weight_i / (60 + rank_i)), like Cosmos DB
   * `ORDER BY RANK RRF(...)`: ranks are dense (from 1; equal scores share a
   * rank). Order matters: `weights[i]` belongs to `rank[i]`. Which
   * candidates each ranking considers (all, or its own top results) is up
   * to the adapter. Documents with equal fused scores have no defined order.
   */
  rank: RankComponent[];
  /** One weight per component; default all 1. */
  weights?: number[];
  limit: number;
  select?: Selection[];
};

// ============================================================================
// Collection handle
// ============================================================================

export interface Collection<T extends Doc = Doc> {
  readonly spec: CollectionSpec;

  /** The document, or null if it does not exist or has expired. */
  read(id: string, partitionKey: string): Promise<Stored<T> | null>;

  /** Insert; Conflict if the id already exists in the partition. */
  create(document: T): Promise<Stored<T>>;

  /** Insert or overwrite. */
  upsert(document: T): Promise<Stored<T>>;

  /**
   * Overwrite an existing document. NotFound if it is missing,
   * PreconditionFailed if `ifMatch` is stale, BadRequest if the body's id or
   * partition key differs from the arguments.
   */
  replace(id: string, partitionKey: string, document: T, condition?: WriteCondition): Promise<Stored<T>>;

  /** Apply patch operations atomically. NotFound if the document is missing. */
  patch(
    id: string,
    partitionKey: string,
    operations: PatchOperation[],
    condition?: WriteCondition,
  ): Promise<Stored<T>>;

  /**
   * Delete. True if this call deleted the document, false if it did not
   * exist; of two concurrent deletes exactly one returns true.
   * PreconditionFailed if `ifMatch` is stale.
   */
  delete(id: string, partitionKey: string, condition?: WriteCondition): Promise<boolean>;

  /** Documents matching the query (whole documents carry `_etag`). */
  find<R = Stored<T>>(query?: Query): Promise<R[]>;

  /**
   * Number of documents matching the query. May transiently include
   * documents whose TTL has expired but which the database has not purged
   * yet (Cosmos DB counts them for a while; reads and `find` never see them).
   */
  count(query?: CountQuery): Promise<number>;

  /** Nearest documents by cosine similarity. Needs `capabilities.vectorSearch`. */
  vectorSearch<R = Stored<T>>(query: VectorSearchQuery): Promise<VectorSearchResult<R>[]>;

  /** Documents in fused rank order. Needs `capabilities.hybridSearch`. */
  hybridSearch<R = Stored<T>>(query: HybridSearchQuery): Promise<R[]>;
}

// ============================================================================
// Adapter
// ============================================================================

export type StorageCapabilities = {
  vectorSearch: boolean;
  hybridSearch: boolean;
};

export interface StorageAdapter {
  /** Adapter name, e.g. "cosmosdb", "postgres", "memory". */
  readonly name: string;
  readonly capabilities: StorageCapabilities;

  /** Connect and prepare. Idempotent. */
  initialize(): Promise<void>;

  /**
   * A handle on the collection, creating it from `spec` if the adapter
   * provisions collections. Repeated calls return the same collection; the
   * first definition wins.
   */
  collection<T extends Doc = Doc>(spec: CollectionSpec): Promise<Collection<T>>;

  /** Release connections. Optional. */
  close?(): Promise<void>;
}
