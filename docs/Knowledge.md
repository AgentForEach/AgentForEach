# Knowledge base

An optional, deployment-wide library of reference documents (manuals, policies, guides) that the agent can search. It is backed by **Azure AI Search** using its integrated pipeline: you upload raw files to a blob container, and an AI Search indexer cracks, chunks, embeds and indexes them. AgentForEach itself only runs queries (hybrid BM25 + vector, with the semantic reranker when the service tier has it).

The index is **shared by every user of a deployment** and searches are not filtered by user. Put reference material in it, never user-private data. Per-user facts belong in memory (see [Architecture](Architecture.md)).

## How it works

```
Operator machine                         Azure
────────────────                         ─────
scripts/ingest-knowledge.mjs ──upload──▶ Blob container "knowledge-docs"
        │                                        │
        └── creates/updates ──▶ AI Search: data source ─▶ indexer ─▶ skillset ─▶ index
                                            (TextSplitSkill + AzureOpenAIEmbeddingSkill)

Function App (per turn)
  runner ──▶ auto-recall: hybrid search on the user's message ──▶ "## Recalled Knowledge" prompt section
         └─▶ knowledge_search tool: the model searches on demand
```

The runtime uses the index in two ways:

1. **Auto-recall (passive).** Before the model is called, the runner searches the index with the user's message (skipped for messages under 10 characters and for turns without a real user message, such as cron wake-ups). Up to `recallLimit` chunks scoring at least `minScore` are XML-escaped, cut to 1,500 characters each, wrapped in a `<relevant-knowledge>` block and added to the system prompt under **Recalled Knowledge**, with a warning not to treat the content as instructions. A failed recall is logged and the turn continues without it.
2. **`knowledge_search` tool (active).** Offered to the model whenever the knowledge layer is enabled, and on the allowlist for scheduled (cron) runs. Parameters: `query` (required; `q` is an alias), `title` (fuzzy filter on the document title via `search.ismatch`), `source` (exact filter), `limit` (1–10, default `searchLimit`). Each result is wrapped with `wrapExternalContent()` as untrusted content and cut to 2,000 characters. The response ends with an "Available documents" list built from title facets, so the model can narrow a follow-up search with `title`.

The code is in `gateway/knowledge/`:

| File | Purpose |
|---|---|
| `config.ts` | Loads the `knowledge` section of `agentforeach.json` and applies defaults |
| `client.ts` | REST client for `POST /indexes/{index}/docs/search`; falls back from `semantic` to `simple` if the service rejects semantic ranking |
| `auto-recall.ts` | Auto-recall and the `<relevant-knowledge>` formatting |
| `tools.ts` | `knowledge_search` definition and handler |
| `index.ts` | `createKnowledgeLayer()`, wired in `client/client.ts` and used by `client/runner.ts` |

The prompt section is built by `prompt/sections/knowledge.ts`; its header, intro and trust warning are in `agentforeach.json` under `prompt.knowledge`.

## Configuration

`gateway/config/agentforeach.json`:

```json
"knowledge": {
  "enabled": true,
  "endpoint": "$SEARCH_ENDPOINT",
  "apiKey": "$SEARCH_API_KEY",
  "indexName": "knowledge-base",
  "autoRecall": true,
  "recallLimit": 3,
  "searchLimit": 5,
  "minScore": 0.02,
  "semanticConfig": "default",
  "apiVersion": "2024-07-01"
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` if the section is missing | Turns the module on |
| `endpoint`, `apiKey` | `SEARCH_ENDPOINT`, `SEARCH_API_KEY` env vars | `$VAR` values are read from the environment |
| `indexName` | `knowledge-base` | Index to query |
| `autoRecall` | `true` | Passive recall on each user message |
| `recallLimit` | `3` | Chunks injected by auto-recall |
| `searchLimit` | `5` | Default result count for `knowledge_search` |
| `minScore` | `0.02` | Results below this score are dropped (reranker score when semantic ranking ran, otherwise the search score) |
| `semanticConfig` | `default` | Semantic configuration name in the index |
| `queryType` | `semantic` | `semantic` or `simple`; both are hybrid (BM25 + vector) |
| `apiVersion` | `2024-07-01` | Search REST API version |

The module is active only when `enabled` is true **and** both an endpoint and a key resolve. With `searchEnabled` off in Pulumi, neither app setting exists, so the shipped `"enabled": true` is harmless.

## Infrastructure

Set `agentforeach:searchEnabled: "true"` in your Pulumi stack (see `infra/Pulumi.example.yaml`). Related settings in `infra/config.ts`: `searchSku` (`free`, `basic` or `standard`; default `basic`), `searchSemanticTier` (`disabled`, `free` or `standard`; default `free`) and `searchReplicaCount` (default 1). The Free SKU has no semantic ranker; the client then falls back to plain hybrid queries.

With it on, Pulumi creates:

- the AI Search service (`infra/search.ts`);
- a `knowledge-docs` blob container in the Function App's storage account (`createKnowledgeBlobContainer` in `infra/functions.ts`);
- the `SEARCH_ENDPOINT` and `SEARCH_API_KEY` app settings. `SEARCH_API_KEY` is a **query key** (search only), stored in Key Vault; the admin key is never given to the Function App.

Pulumi does **not** create the index, data source, skillset or indexer (they are data-plane resources; the ingest script creates them) or an embedding model. Bring an Azure OpenAI resource with an embedding deployment (default name `text-embedding-3-small`, 1,536 dimensions).

## Ingesting documents

`scripts/ingest-knowledge.mjs` runs on an operator's machine. It needs:

| Variable | Purpose |
|---|---|
| `SEARCH_ENDPOINT` | `https://<your-search>.search.windows.net` |
| `SEARCH_API_KEY` | The **admin** key (`az search admin-key show`), not the runtime's query key |
| `SEARCH_INDEX_NAME` | Optional; defaults to `knowledge.indexName` in `agentforeach.json`, then `knowledge-base` |
| `STORAGE_CONNECTION_STRING` | Connection string of the storage account holding `knowledge-docs` |
| `STORAGE_CONTAINER` | Optional; default `knowledge-docs` |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` | Embedding resource used by the skillset and the query-time vectorizer |
| `AZURE_OPENAI_EMBEDDING_DEPLOYMENT`, `AZURE_OPENAI_EMBEDDING_MODEL` | Optional; both default to `text-embedding-3-small` |

Commands:

```bash
node scripts/ingest-knowledge.mjs --ensure-pipeline          # create/update index, data source, skillset, indexer
node scripts/ingest-knowledge.mjs ingest --file <path>       # upload one file, run the indexer, wait for it
node scripts/ingest-knowledge.mjs ingest --manifest <json>   # upload every file in a manifest, run, wait
node scripts/ingest-knowledge.mjs run-indexer                # run the indexer now
node scripts/ingest-knowledge.mjs reset-indexer              # reprocess every blob on the next run
node scripts/ingest-knowledge.mjs indexer-status             # last run status
node scripts/ingest-knowledge.mjs delete --source <value>    # delete chunks whose `source` equals <value>
```

`ingest` also runs `--ensure-pipeline` first. A manifest is a JSON array of objects; only `file` (a path relative to the manifest) is used. `scripts/test-knowledge/` has a sample manifest and two sample Markdown documents.

Notes:

- The script reads files as UTF-8 text before uploading, so use it for text formats (`.md`, `.txt`, `.html`, `.csv`, `.json`). Upload binary files (PDF, DOCX, XLSX, PPTX) to the container with another tool (for example `az storage blob upload`) and then run `run-indexer`; the indexer cracks them itself.
- The blob name is the file's base name, so uploading a file with the same name replaces the earlier document.
- `title` in the index is the blob name and `source` is the full blob URL, so `delete --source` needs the blob URL. Delete the blob as well, or a later `reset-indexer` will index it again.
- The indexer also runs on its own every 2 hours and only reprocesses changed blobs.

## Index and pipeline

Created by `--ensure-pipeline` (names derive from `indexName`):

| Resource | Name | Notes |
|---|---|---|
| Index | `knowledge-base` | Fields below; HNSW vector profile with an Azure OpenAI vectorizer for query-time embedding; semantic configuration `default` (title `title`, content `chunk`, keywords `source`) |
| Data source | `knowledge-base-datasource` | Blob container |
| Skillset | `knowledge-base-skillset` | `SplitSkill` (pages of 2,000 characters, 500 overlap) then `AzureOpenAIEmbeddingSkill`; index projections with `skipIndexingParentDocuments`, so only chunks are indexed |
| Indexer | `knowledge-base-indexer` | Every 2 hours; `contentAndMetadata`; failed items don't stop a run |

| Field | Type | Source |
|---|---|---|
| `chunk_id` | string, key, `keyword` analyzer (required for index projections) | Generated by the projection |
| `parent_id` | string, filterable | The source blob |
| `chunk` | string, searchable | Chunk text |
| `title` | string, searchable, filterable, facetable | `metadata_storage_name` |
| `source` | string, filterable, facetable | `metadata_storage_path` |
| `chunkVector` | 1,536-dim vector, not stored | Embedding |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No `knowledge_search` tool and no recall | `enabled` is false, or `SEARCH_ENDPOINT` / `SEARCH_API_KEY` is not set on the Function App |
| Search returns nothing | Index empty or a different `indexName`; check `indexer-status` |
| Indexer shows transient failures | Embedding rate limits; retry or raise the deployment's quota |
| Auto-recall never adds anything | `minScore` too high for your scores, or `autoRecall` is false |
| Ingest fails with 403 | Using the runtime's query key; the script needs the admin key |
