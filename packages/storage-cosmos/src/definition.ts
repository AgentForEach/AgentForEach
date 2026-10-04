/**
 * AgentForEach Storage — Cosmos DB container definitions
 *
 * Maps a provider-neutral `CollectionSpec` to the Cosmos container
 * definition used both at runtime (createIfNotExists, local development) and
 * by the IaC catalog (infra/cosmos-containers.json, deployed by Pulumi).
 *
 * Derived from the spec:
 *   - partition key `/<field>`, Hash v2 (what infra applies to every container);
 *   - the TTL (`defaultTtl` as is);
 *   - an indexing policy: everything indexed except the vector field,
 *     `unindexed` fields and `_etag`, plus full-text and vector indexes;
 *   - the vector embedding and full-text policies.
 *
 * Cosmos-specific settings go in `spec.adapterOptions.cosmosdb`
 * (`CosmosCollectionOptions`).
 */

import { fieldSegments, type CollectionSpec } from "@agentforeach/storage";

export type CosmosIndexingPolicy = Record<string, unknown>;

/** `spec.adapterOptions.cosmosdb`. */
export type CosmosCollectionOptions = {
  /**
   * Use this indexing policy instead of the derived one; `null` sends none,
   * leaving the account's default (automatic, consistent, all paths).
   */
  indexingPolicy?: CosmosIndexingPolicy | null;
  /**
   * Vector index type. Default: "flat" (exact search) up to 505 dimensions,
   * Cosmos' limit for flat indexes, else "diskANN".
   */
  vectorIndexType?: "flat" | "quantizedFlat" | "diskANN";
  /**
   * Fail on first use if the container's partition key differs from the
   * spec's (an existing container keeps the key it was created with). When
   * provisioning, the createIfNotExists response is checked; otherwise this
   * costs one control-plane read.
   */
  verifyPartitionKey?: boolean;
};

export type CosmosContainerDefinition = {
  id: string;
  partitionKey: { paths: string[]; kind: "Hash"; version: 2 };
  defaultTtl?: number;
  indexingPolicy?: CosmosIndexingPolicy;
  vectorEmbeddingPolicy?: {
    vectorEmbeddings: Array<{ path: string; dataType: string; dimensions: number; distanceFunction: string }>;
  };
  fullTextPolicy?: {
    defaultLanguage: string;
    fullTextPaths: Array<{ path: string; language: string }>;
  };
};

/** The spec's Cosmos options (empty when none are set). */
export function cosmosOptions(spec: CollectionSpec): CosmosCollectionOptions {
  return (spec.adapterOptions?.cosmosdb as CosmosCollectionOptions | undefined) ?? {};
}

/** `/a/b` for the field path "a.b". */
export function jsonPath(field: string): string {
  return "/" + fieldSegments(field).join("/");
}

const ETAG_PATH = '/"_etag"/?';

export function toContainerDefinition(spec: CollectionSpec): CosmosContainerDefinition {
  const options = cosmosOptions(spec);
  const definition: CosmosContainerDefinition = {
    id: spec.name,
    partitionKey: { paths: [jsonPath(spec.partitionKey)], kind: "Hash", version: 2 },
  };
  if (spec.defaultTtl !== undefined) definition.defaultTtl = spec.defaultTtl;

  if (options.indexingPolicy !== undefined) {
    if (options.indexingPolicy !== null) definition.indexingPolicy = options.indexingPolicy;
  } else {
    const excluded = [
      ...new Set([
        ...(spec.vector ? [`${jsonPath(spec.vector.field)}/*`] : []),
        ...(spec.unindexed ?? []).map((field) => `${jsonPath(field)}/*`),
        ETAG_PATH,
      ]),
    ];
    const policy: CosmosIndexingPolicy = {
      automatic: true,
      indexingMode: "consistent",
      includedPaths: [{ path: "/*" }],
      excludedPaths: excluded.map((path) => ({ path })),
    };
    if (spec.fullText) {
      policy.fullTextIndexes = spec.fullText.fields.map((field) => ({ path: jsonPath(field) }));
    }
    if (spec.vector) {
      const type = options.vectorIndexType ?? (spec.vector.dimensions <= 505 ? "flat" : "diskANN");
      policy.vectorIndexes = [{ path: jsonPath(spec.vector.field), type }];
    }
    definition.indexingPolicy = policy;
  }

  if (spec.vector) {
    definition.vectorEmbeddingPolicy = {
      vectorEmbeddings: [
        {
          path: jsonPath(spec.vector.field),
          dataType: spec.vector.dataType ?? "float32",
          dimensions: spec.vector.dimensions,
          distanceFunction: spec.vector.distance,
        },
      ],
    };
  }
  if (spec.fullText) {
    definition.fullTextPolicy = {
      defaultLanguage: spec.fullText.language,
      fullTextPaths: spec.fullText.fields.map((field) => ({ path: jsonPath(field), language: spec.fullText!.language })),
    };
  }
  return definition;
}
