/**
 * AgentForEach Infrastructure — Azure AI Search
 *
 * Provisions the Azure AI Search service for the knowledge base module.
 *
 * The search index, data source, skillset, and indexer are managed via
 * the Azure AI Search REST management API at deploy time (or via the
 * ingest-knowledge script at runtime).  Pulumi provisions only the
 * service itself and retrieves the admin key — the index schema is
 * created/updated by the ingest script to allow iteration without
 * re-deploying infrastructure.
 *
 * NOTE: Azure AI Search does NOT have Pulumi-native resources for
 * indexes, indexers, data sources, or skillsets.  Those are data-plane
 * operations managed via REST.  The ingest-knowledge.mjs script
 * performs index creation / schema updates.
 */

import * as search from "@pulumi/azure-native/search/v20231101";
import * as enums from "@pulumi/azure-native/types/enums/search/v20231101";
import * as pulumi from "@pulumi/pulumi";

// ============================================================================
// Search Service
// ============================================================================

/**
 * Create an Azure AI Search service.
 *
 * For development, "free" or "basic" SKU is sufficient.
 * Free: 50 MB, 3 indexes, no semantic ranker.
 * Basic: 2 GB, 15 indexes, semantic ranker available.
 *
 * Semantic search (hybrid + reranker) requires Basic or higher and
 * is enabled automatically when available on the SKU.
 */
export function createSearchService(args: {
  resourceGroupName: pulumi.Input<string>;
  location: pulumi.Input<string>;
  serviceName: string;
  /** SKU: "free", "basic", or "standard". Default: "basic". */
  sku?: string;
  /**
   * Semantic search tier: "disabled", "free", or "standard".
   * - "disabled" — no semantic ranker (default for Free SKU).
   * - "free"     — up to 1 000 semantic queries/month at no cost (Basic+).
   * - "standard" — unlimited semantic queries, billed per 1 000 queries.
   * Default: "free" (cheapest option that enables L2 semantic reranking).
   */
  semanticSearchTier?: string;
  replicaCount?: number;
  partitionCount?: number;
  tags: Record<string, string>;
}) {
  const sku = args.sku ?? "basic";
  const semanticSearch = args.semanticSearchTier ?? "free";

  return new search.Service(args.serviceName, {
    searchServiceName: args.serviceName,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: {
      name: sku as enums.SkuName,
    },
    semanticSearch: semanticSearch as enums.SearchSemanticSearch,
    replicaCount: args.replicaCount ?? 1,
    partitionCount: args.partitionCount ?? 1,
    hostingMode: enums.HostingMode.Default,
    tags: args.tags,
  });
}

// ============================================================================
// Query Key
// ============================================================================

/**
 * Retrieve a query key for the Search service. The runtime only searches
 * (knowledge/client.ts calls /docs/search), so it gets a query key, not the
 * admin key that can modify or delete indexes.
 */
export function getSearchQueryKey(args: {
  resourceGroupName: pulumi.Input<string>;
  serviceName: pulumi.Input<string>;
}): pulumi.Output<string> {
  return pulumi
    .all([args.resourceGroupName, args.serviceName])
    .apply(([rg, svc]) =>
      search.listQueryKeyBySearchService({ resourceGroupName: rg, searchServiceName: svc }),
    )
    .apply((result) => {
      const key = result.value?.[0]?.key;
      // Every service is created with a query key; an empty one would only
      // surface later as 403s on every knowledge search.
      if (!key) throw new Error("Search service has no query key; create one in the portal");
      return pulumi.secret(key);
    });
}

// ============================================================================
// Blob Container for Knowledge Documents
// ============================================================================

// The blob container for raw knowledge documents (PDFs, HTML, etc.)
// is created in functions.ts using the existing Storage Account.
// See createKnowledgeBlobContainer() in functions.ts.
