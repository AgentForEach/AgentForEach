/**
 * AgentForEach Knowledge Layer — Azure AI Search Client
 *
 * Thin wrapper around the Azure AI Search REST API for hybrid search
 * (BM25 + vector + semantic reranker).
 *
 * Uses the `@azure/search-documents` SDK for type-safe interactions.
 * Falls back to raw REST if the SDK is unavailable (e.g., edge runtimes).
 *
 * The client is completely domain-agnostic — it searches an index with
 * a fixed generic schema and returns chunks with metadata.
 */

import type {
  KnowledgeConfig,
  KnowledgeChunk,
  KnowledgeSearchOptions,
  KnowledgeSearchResult,
  KnowledgeFacet,
} from "./types.js";

const SEARCH_TIMEOUT_MS = 15_000;

// ============================================================================
// Search Client
// ============================================================================

/**
 * Azure AI Search client for the knowledge base index.
 *
 * Constructed with a resolved `KnowledgeConfig`. Performs hybrid queries
 * combining keyword (BM25), vector, and optional semantic reranking.
 */
export class KnowledgeSearchClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly indexName: string;
  private readonly semanticConfig: string;
  private readonly queryType: "simple" | "semantic";
  private readonly apiVersion: string;

  constructor(config: KnowledgeConfig) {
    if (!config.endpoint) throw new Error("knowledge: endpoint is required");
    if (!config.apiKey) throw new Error("knowledge: apiKey is required");

    // Normalize endpoint — ensure it has https:// prefix and no trailing slash
    let endpoint = config.endpoint.trim();
    if (!endpoint.startsWith("https://")) {
      endpoint = `https://${endpoint}`;
    }
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.indexName = config.indexName;
    this.semanticConfig = config.semanticConfig;
    this.queryType = config.queryType ?? "semantic";
    this.apiVersion = config.apiVersion;
  }

  /**
   * Perform a hybrid search (BM25 + vector + semantic reranker).
   *
   * Uses the Azure AI Search REST API directly for maximum control
   * over the query shape (vectorQueries, semantic config, filters).
   */
  async search(options: KnowledgeSearchOptions): Promise<KnowledgeSearchResult> {
    const top = options.top ?? 5;
    const queryType = options.queryType ?? this.queryType;

    // Build OData filter expression
    const filterParts: string[] = [];

    // Title filter — full-text match using search.ismatch (not exact eq)
    // e.g. search.ismatch('income tax', 'title', 'simple', 'all')
    if (options.title?.trim()) {
      filterParts.push(
        `search.ismatch('${escapeOData(options.title.trim())}', 'title', 'simple', 'all')`,
      );
    }

    if (options.sources?.length) {
      const sourceFilters = options.sources
        .map((s) => `source eq '${escapeOData(s)}'`)
        .join(" or ");
      filterParts.push(`(${sourceFilters})`);
    }

    if (options.parentId) {
      filterParts.push(`parent_id eq '${escapeOData(options.parentId)}'`);
    }

    const filter = filterParts.length > 0 ? filterParts.join(" and ") : undefined;

    let response = await this.executeSearch(options.query, queryType, top, filter);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");

      // Graceful degradation: semantic ranking is unavailable on some
      // service tiers (e.g. Free). Retry once as a plain hybrid query.
      if (
        queryType === "semantic" &&
        response.status === 400 &&
        /semantic/i.test(errorText)
      ) {
        response = await this.executeSearch(options.query, "simple", top, filter);
        if (!response.ok) {
          const retryText = await response.text().catch(() => "");
          throw new Error(
            `knowledge: search failed (${response.status}): ${retryText.slice(0, 500)}`,
          );
        }
      } else {
        throw new Error(
          `knowledge: search failed (${response.status}): ${errorText.slice(0, 500)}`,
        );
      }
    }

    const data = (await response.json()) as SearchResponse;
    return {
      chunks: mapSearchResults(data),
      titleFacets: mapFacets(data, "title"),
    };
  }

  /**
   * Execute a single search request with the given query type.
   * Hybrid (BM25 + vector) is used for both "simple" and "semantic";
   * semantic adds the L2 reranker, captions and answers on top.
   */
  private async executeSearch(
    query: string,
    queryType: "simple" | "semantic",
    top: number,
    filter: string | undefined,
  ): Promise<Response> {
    const body: Record<string, unknown> = {
      search: query,
      queryType,
      top,
      select: "chunk_id,parent_id,chunk,title,source",
      highlight: "chunk",
      highlightPreTag: "<mark>",
      highlightPostTag: "</mark>",
      count: true,
      // Always request title facets so the tool handler can show available docs
      facets: ["title,count:50,sort:value"],
      // Vector query for hybrid search (integrated vectorizer) — works on
      // all tiers, independent of semantic reranking
      vectorQueries: [
        {
          text: query,
          fields: "chunkVector",
          kind: "text",
          k: top * 2,
        },
      ],
    };

    if (filter) {
      body.filter = filter;
    }

    // Enable semantic configuration for L2 reranking (Basic tier and above)
    if (queryType === "semantic") {
      body.semanticConfiguration = this.semanticConfig;
      // Extractive captions + answers for best semantic ranking
      body.captions = "extractive|highlight-true";
      body.answers = "extractive|count-3";
    }

    const url = `${this.endpoint}/indexes/${encodeURIComponent(this.indexName)}/docs/search?api-version=${this.apiVersion}`;

    return fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  }
}

// ============================================================================
// Response Mapping
// ============================================================================

interface SearchResponse {
  "@odata.count"?: number;
  "@search.facets"?: Record<string, Array<{ value: string; count: number }>>;
  value: SearchResult[];
}

interface SearchResult {
  "@search.score"?: number;
  "@search.rerankerScore"?: number;
  "@search.highlights"?: Record<string, string[]>;
  "@search.captions"?: Array<{ text?: string; highlights?: string }>;
  chunk_id?: string;
  parent_id?: string;
  chunk?: string;
  title?: string;
  source?: string;
}

function mapSearchResults(data: SearchResponse): KnowledgeChunk[] {
  return (data.value ?? []).map((result) => ({
    chunkId: result.chunk_id ?? "",
    parentId: result.parent_id ?? "",
    chunk: result.chunk ?? "",
    title: result.title ?? "",
    source: result.source ?? "",
    // Prefer reranker score (semantic L2), fall back to BM25 score
    score: result["@search.rerankerScore"] ?? result["@search.score"] ?? 0,
    highlights: result["@search.highlights"]?.chunk,
    captions: result["@search.captions"]
      ?.map((c) => c.highlights || c.text)
      .filter((t): t is string => Boolean(t)),
  }));
}

/**
 * Extract facet buckets for a specific field from the search response.
 * Azure AI Search returns facets under `@search.facets.<fieldName>`.
 */
function mapFacets(
  data: SearchResponse,
  fieldName: string,
): KnowledgeFacet[] | undefined {
  const raw = data["@search.facets"]?.[fieldName];
  if (!raw?.length) return undefined;
  return raw.map((f) => ({ value: f.value, count: f.count }));
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Escape a string for use in OData filter expressions.
 * Single quotes are escaped by doubling them.
 */
function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}
