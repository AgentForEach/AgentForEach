#!/usr/bin/env node

/**
 * Ingest Knowledge Documents into Azure AI Search
 *
 * Uses the FULL Azure AI Search integrated pipeline:
 *   1. Upload raw files to Blob Storage
 *   2. Data Source → Indexer → Skillset → Index
 *   3. Azure handles cracking, chunking (TextSplitSkill), embedding
 *      (AzureOpenAIEmbeddingSkill), and indexing automatically
 *
 * The script creates/updates all data-plane resources (index, data source,
 * skillset, indexer) and uploads files to the blob container. The indexer
 * then processes everything end-to-end.
 *
 * Usage:
 *   # Set up the full pipeline (index + data source + skillset + indexer):
 *   node scripts/ingest-knowledge.mjs --ensure-pipeline
 *
 *   # Upload a single file to blob → indexer picks it up automatically:
 *   node scripts/ingest-knowledge.mjs ingest --file ./docs/companies-act.md
 *
 *   # Upload from a manifest (batch):
 *   node scripts/ingest-knowledge.mjs ingest --manifest ./knowledge-manifest.json
 *
 *   # Trigger the indexer to run now (without waiting for schedule):
 *   node scripts/ingest-knowledge.mjs run-indexer
 *
 *   # Check indexer status:
 *   node scripts/ingest-knowledge.mjs indexer-status
 *
 *   # Delete all chunks for a source:
 *   node scripts/ingest-knowledge.mjs delete --source "Companies Act 2013"
 *
 * Environment:
 *   SEARCH_ENDPOINT              — Azure AI Search endpoint URL
 *   SEARCH_API_KEY               — Admin API key
 *   STORAGE_CONNECTION_STRING    — Azure Storage connection string
 *   STORAGE_CONTAINER            — Blob container name (default: knowledge-docs)
 *   AZURE_OPENAI_ENDPOINT        — Azure OpenAI endpoint for embedding
 *   AZURE_OPENAI_API_KEY         — Azure OpenAI API key
 *   AZURE_OPENAI_EMBEDDING_DEPLOYMENT — Embedding deployment (default: text-embedding-3-small)
 *   AZURE_OPENAI_EMBEDDING_MODEL — Embedding model name (default: text-embedding-3-small)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(
  __dirname,
  "../gateway/config/agentforeach.json",
);

// ============================================================================
// Configuration
// ============================================================================

function loadConfig() {
  // Try env vars first
  let endpoint = process.env.SEARCH_ENDPOINT;
  let apiKey = process.env.SEARCH_API_KEY;
  let indexName = process.env.SEARCH_INDEX_NAME || "knowledge-base";
  const apiVersion = "2024-07-01";

  // Fallback to agentforeach.json
  if (!endpoint || !apiKey) {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const cfg = JSON.parse(raw);
      const k = cfg.knowledge ?? {};
      if (!endpoint && k.endpoint) {
        endpoint = k.endpoint.startsWith("$")
          ? process.env[k.endpoint.slice(1)]
          : k.endpoint;
      }
      if (!apiKey && k.apiKey) {
        apiKey = k.apiKey.startsWith("$")
          ? process.env[k.apiKey.slice(1)]
          : k.apiKey;
      }
      if (k.indexName) indexName = k.indexName;
    } catch {
      // Config file not found — rely on env vars
    }
  }

  if (!endpoint || !apiKey) {
    console.error(
      "ERROR: SEARCH_ENDPOINT and SEARCH_API_KEY must be set (env vars or agentforeach.json).",
    );
    process.exit(1);
  }

  // Storage config
  const storageConnectionString = process.env.STORAGE_CONNECTION_STRING;
  const storageContainer = process.env.STORAGE_CONTAINER || "knowledge-docs";

  // Azure OpenAI config
  const aoaiEndpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
  const aoaiApiKey = process.env.AZURE_OPENAI_API_KEY || "";
  const aoaiDeployment =
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-3-small";
  const aoaiModel =
    process.env.AZURE_OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";

  return {
    endpoint,
    apiKey,
    indexName,
    apiVersion,
    storageConnectionString,
    storageContainer,
    aoaiEndpoint,
    aoaiApiKey,
    aoaiDeployment,
    aoaiModel,
  };
}

// ============================================================================
// Index Schema — designed for integrated vectorization (indexer + skillset)
// ============================================================================

/**
 * Index schema for the integrated pipeline:
 *   - chunk_id:     unique key per chunk (auto-set by index projections, keyword analyzer)
 *   - parent_id:    groups chunks from the same blob (set by index projections)
 *   - chunk:        the text content (set by TextSplitSkill pages)
 *   - chunkVector:  vector embedding (set by AzureOpenAIEmbeddingSkill)
 *   - title:        blob filename, mapped from metadata_storage_name
 *   - source:       blob path, mapped from metadata_storage_path
 *
 * Per MS docs, the key field MUST use the "keyword" analyzer for index projections.
 */
function buildIndexSchema(config) {
  return {
    name: config.indexName,
    fields: [
      {
        name: "chunk_id",
        type: "Edm.String",
        key: true,
        filterable: true,
        searchable: true,
        analyzer: "keyword",
      },
      {
        name: "parent_id",
        type: "Edm.String",
        filterable: true,
        searchable: false,
      },
      {
        name: "chunk",
        type: "Edm.String",
        searchable: true,
        retrievable: true,
      },
      {
        name: "title",
        type: "Edm.String",
        searchable: true,
        retrievable: true,
        filterable: true,
        facetable: true,
      },
      {
        name: "source",
        type: "Edm.String",
        searchable: false,
        retrievable: true,
        filterable: true,
        facetable: true,
      },
      {
        name: "chunkVector",
        type: "Collection(Edm.Single)",
        searchable: true,
        retrievable: false,
        stored: false,
        dimensions: 1536,
        vectorSearchProfile: "default-vector-profile",
      },
    ],
    vectorSearch: {
      algorithms: [
        {
          name: "hnsw-algorithm",
          kind: "hnsw",
          hnswParameters: {
            m: 4,
            efConstruction: 400,
            efSearch: 500,
            metric: "cosine",
          },
        },
      ],
      profiles: [
        {
          name: "default-vector-profile",
          algorithm: "hnsw-algorithm",
          vectorizer: "text-vectorizer",
        },
      ],
      vectorizers: [
        {
          name: "text-vectorizer",
          kind: "azureOpenAI",
          azureOpenAIParameters: {
            resourceUri: config.aoaiEndpoint,
            deploymentId: config.aoaiDeployment,
            apiKey: config.aoaiApiKey,
            modelName: config.aoaiModel,
          },
        },
      ],
    },
    semantic: {
      configurations: [
        {
          name: "default",
          prioritizedFields: {
            titleField: { fieldName: "title" },
            prioritizedContentFields: [{ fieldName: "chunk" }],
            prioritizedKeywordsFields: [{ fieldName: "source" }],
          },
        },
      ],
    },
  };
}

// ============================================================================
// Skillset — TextSplitSkill + AzureOpenAIEmbeddingSkill + IndexProjections
// ============================================================================

function buildSkillset(config) {
  return {
    name: `${config.indexName}-skillset`,
    description:
      "Chunks documents with TextSplitSkill, embeds with Azure OpenAI, projects to index",
    skills: [
      {
        "@odata.type": "#Microsoft.Skills.Text.SplitSkill",
        name: "text-split-skill",
        description: "Split documents into chunks of ~2000 chars with 500 overlap",
        context: "/document",
        defaultLanguageCode: "en",
        textSplitMode: "pages",
        maximumPageLength: 2000,
        pageOverlapLength: 500,
        maximumPagesToTake: 0,
        inputs: [
          {
            name: "text",
            source: "/document/content",
          },
        ],
        outputs: [
          {
            name: "textItems",
            targetName: "pages",
          },
        ],
      },
      {
        "@odata.type": "#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill",
        name: "embedding-skill",
        description: "Generate embeddings for each chunk using Azure OpenAI",
        context: "/document/pages/*",
        resourceUri: config.aoaiEndpoint,
        deploymentId: config.aoaiDeployment,
        modelName: config.aoaiModel,
        apiKey: config.aoaiApiKey,
        inputs: [
          {
            name: "text",
            source: "/document/pages/*",
          },
        ],
        outputs: [
          {
            name: "embedding",
            targetName: "chunk_vector",
          },
        ],
      },
    ],
    indexProjections: {
      selectors: [
        {
          targetIndexName: config.indexName,
          parentKeyFieldName: "parent_id",
          sourceContext: "/document/pages/*",
          mappings: [
            {
              name: "chunk",
              source: "/document/pages/*",
            },
            {
              name: "chunkVector",
              source: "/document/pages/*/chunk_vector",
            },
            {
              name: "title",
              source: "/document/metadata_storage_name",
            },
            {
              name: "source",
              source: "/document/metadata_storage_path",
            },
          ],
        },
      ],
      parameters: {
        projectionMode: "skipIndexingParentDocuments",
      },
    },
  };
}

// ============================================================================
// Data Source — Azure Blob Storage
// ============================================================================

function buildDataSource(config) {
  if (!config.storageConnectionString) {
    console.error(
      "ERROR: STORAGE_CONNECTION_STRING must be set for the integrated pipeline.",
    );
    process.exit(1);
  }
  return {
    name: `${config.indexName}-datasource`,
    type: "azureblob",
    credentials: {
      connectionString: config.storageConnectionString,
    },
    container: {
      name: config.storageContainer,
    },
  };
}

// ============================================================================
// Indexer — Orchestrates the pipeline
// ============================================================================

function buildIndexer(config) {
  return {
    name: `${config.indexName}-indexer`,
    dataSourceName: `${config.indexName}-datasource`,
    targetIndexName: config.indexName,
    skillsetName: `${config.indexName}-skillset`,
    schedule: {
      interval: "PT2H",
    },
    parameters: {
      batchSize: 10,
      maxFailedItems: -1,
      maxFailedItemsPerBatch: -1,
      configuration: {
        dataToExtract: "contentAndMetadata",
        parsingMode: "default",
      },
    },
  };
}

// ============================================================================
// REST Helpers
// ============================================================================

async function searchRequest(config, method, path, body) {
  const url = `${config.endpoint}${path}?api-version=${config.apiVersion}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Azure AI Search ${method} ${path} failed (${res.status}): ${text}`,
    );
  }

  if (res.status === 204) return null;
  return res.json();
}

/**
 * Create or update a resource via PUT (idempotent upsert).
 * Falls back to POST for resources that don't exist yet.
 */
async function createOrUpdateResource(config, path, body) {
  const url = `${config.endpoint}${path}?api-version=${config.apiVersion}`;

  // Try PUT first (update existing)
  let res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (res.ok) {
    if (res.status === 204) return null;
    return res.json();
  }

  // If PUT fails (resource doesn't exist), try POST to the collection
  const putErrText = await res.text();
  const parts = path.split("/");
  parts.pop(); // Remove resource name, keep collection path
  const collectionPath = parts.join("/");

  const postRes = await fetch(
    `${config.endpoint}${collectionPath}?api-version=${config.apiVersion}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": config.apiKey,
      },
      body: JSON.stringify(body),
    },
  );

  if (postRes.ok) {
    if (postRes.status === 204) return null;
    return postRes.json();
  }

  const postErrText = await postRes.text();
  throw new Error(
    `Azure AI Search create/update ${path} failed.\n  PUT (${res.status}): ${putErrText.slice(0, 300)}\n  POST (${postRes.status}): ${postErrText.slice(0, 300)}`,
  );
}

// ============================================================================
// Blob Upload (Azure Storage REST API with SharedKey auth)
// ============================================================================

/**
 * Parse a storage connection string into components.
 */
function parseConnectionString(connStr) {
  const parts = {};
  for (const segment of connStr.split(";")) {
    const idx = segment.indexOf("=");
    if (idx > 0) {
      parts[segment.slice(0, idx)] = segment.slice(idx + 1);
    }
  }
  return parts;
}

/**
 * Build a SharedKey Authorization header for Azure Storage REST API.
 */
function buildSharedKeyAuth({
  method,
  accountName,
  accountKey,
  blobPath,
  contentLength,
  contentType,
  xMsDate,
  xMsVersion,
  extraHeaders,
}) {
  // Canonicalized headers (sorted, lowercase)
  const allHeaders = {
    ...(extraHeaders || {}),
    "x-ms-date": xMsDate,
    "x-ms-version": xMsVersion,
  };
  const canonicalizedHeaders = Object.keys(allHeaders)
    .sort()
    .map((k) => `${k}:${allHeaders[k]}`)
    .join("\n");

  const canonicalizedResource = `/${accountName}${blobPath}`;

  const stringToSign = [
    method,
    "", // Content-Encoding
    "", // Content-Language
    contentLength !== undefined ? contentLength.toString() : "",
    "", // Content-MD5
    contentType || "", // Content-Type
    "", // Date (empty when x-ms-date is set)
    "", // If-Modified-Since
    "", // If-Match
    "", // If-None-Match
    "", // If-Unmodified-Since
    "", // Range
    canonicalizedHeaders,
    canonicalizedResource,
  ].join("\n");

  const signature = createHmac("sha256", Buffer.from(accountKey, "base64"))
    .update(stringToSign, "utf-8")
    .digest("base64");

  return `SharedKey ${accountName}:${signature}`;
}

/**
 * Upload content to Azure Blob Storage using the PUT Blob REST API.
 */
async function uploadToBlob(config, blobName, content, contentType) {
  const parsed = parseConnectionString(config.storageConnectionString);
  const accountName = parsed.AccountName;
  const accountKey = parsed.AccountKey;
  const blobEndpoint =
    (parsed.BlobEndpoint || `https://${accountName}.blob.core.windows.net`).replace(/\/+$/, "");

  const blobPath = `/${config.storageContainer}/${blobName}`;
  const url = `${blobEndpoint}${blobPath}`;
  const xMsDate = new Date().toUTCString();
  const xMsVersion = "2023-11-03";
  const contentLength = Buffer.byteLength(content);

  const authHeader = buildSharedKeyAuth({
    method: "PUT",
    accountName,
    accountKey,
    blobPath,
    contentLength,
    contentType: contentType || "application/octet-stream",
    xMsDate,
    xMsVersion,
    extraHeaders: { "x-ms-blob-type": "BlockBlob" },
  });

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: authHeader,
      "Content-Type": contentType || "application/octet-stream",
      "Content-Length": contentLength.toString(),
      "x-ms-blob-type": "BlockBlob",
      "x-ms-date": xMsDate,
      "x-ms-version": xMsVersion,
    },
    body: content,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Blob upload failed for "${blobName}" (${res.status}): ${text}`,
    );
  }
}

// ============================================================================
// Pipeline Setup
// ============================================================================

/**
 * Ensure the full integrated pipeline exists:
 *   1. Index (with vectorizer + semantic config)
 *   2. Data Source (blob container)
 *   3. Skillset (TextSplit + AzureOpenAIEmbedding + IndexProjections)
 *   4. Indexer (orchestrates the pipeline)
 */
async function ensurePipeline(config) {
  // 1. Create or update the index
  console.log("Setting up index...");
  const indexSchema = buildIndexSchema(config);
  await createOrUpdateResource(
    config,
    `/indexes/${config.indexName}`,
    indexSchema,
  );
  console.log(`  Index "${config.indexName}" ready.`);

  // 2. Create or update the data source
  console.log("Setting up data source...");
  const dataSource = buildDataSource(config);
  await createOrUpdateResource(
    config,
    `/datasources/${dataSource.name}`,
    dataSource,
  );
  console.log(`  Data source "${dataSource.name}" ready.`);

  // 3. Create or update the skillset
  console.log("Setting up skillset...");
  const skillset = buildSkillset(config);
  await createOrUpdateResource(
    config,
    `/skillsets/${skillset.name}`,
    skillset,
  );
  console.log(`  Skillset "${skillset.name}" ready.`);

  // 4. Create or update the indexer
  console.log("Setting up indexer...");
  const indexer = buildIndexer(config);
  await createOrUpdateResource(
    config,
    `/indexers/${indexer.name}`,
    indexer,
  );
  console.log(`  Indexer "${indexer.name}" ready.`);

  console.log("\nFull integrated pipeline is set up.");
}

// ============================================================================
// Indexer Operations
// ============================================================================

async function runIndexer(config) {
  const indexerName = `${config.indexName}-indexer`;
  console.log(`Running indexer "${indexerName}"...`);

  const url = `${config.endpoint}/indexers/${indexerName}/run?api-version=${config.apiVersion}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": config.apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    // 409 means indexer is already running
    if (res.status === 409) {
      console.log("Indexer is already running. Waiting for it to finish...");
      return;
    }
    throw new Error(`Failed to run indexer (${res.status}): ${text}`);
  }

  console.log("Indexer run triggered successfully.");
}

async function resetIndexer(config) {
  const indexerName = `${config.indexName}-indexer`;
  console.log(`Resetting indexer "${indexerName}"...`);

  const url = `${config.endpoint}/indexers/${indexerName}/reset?api-version=${config.apiVersion}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": config.apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to reset indexer (${res.status}): ${text}`);
  }

  console.log("Indexer reset. Next run will reprocess all documents.");
}

async function getIndexerStatus(config) {
  const indexerName = `${config.indexName}-indexer`;
  const data = await searchRequest(
    config,
    "GET",
    `/indexers/${indexerName}/status`,
  );

  console.log(`Indexer: ${indexerName}`);
  console.log(`  Status: ${data.status}`);

  const last = data.lastResult;
  if (last) {
    console.log(`  Last run: ${last.status}`);
    console.log(`  Start time: ${last.startTime}`);
    console.log(`  End time: ${last.endTime}`);
    console.log(
      `  Items processed: ${last.itemsProcessed} / ${last.itemCount}`,
    );
    console.log(`  Items failed: ${last.failedItemCount}`);
    if (last.errors?.length > 0) {
      console.log(`  Errors:`);
      for (const err of last.errors.slice(0, 5)) {
        console.log(`    - ${err.message}`);
      }
    }
    if (last.warnings?.length > 0) {
      console.log(`  Warnings:`);
      for (const w of last.warnings.slice(0, 5)) {
        console.log(`    - ${w.message}`);
      }
    }
  } else {
    console.log("  No runs yet.");
  }
}

/**
 * Wait for the indexer to finish its current run (polling).
 */
async function waitForIndexer(config, timeoutMs = 120_000) {
  const indexerName = `${config.indexName}-indexer`;
  const start = Date.now();
  const pollInterval = 5000;

  while (Date.now() - start < timeoutMs) {
    const data = await searchRequest(
      config,
      "GET",
      `/indexers/${indexerName}/status`,
    );

    const last = data.lastResult;
    if (data.status === "running" && last?.status === "inProgress") {
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    // Indexer finished (or hasn't started)
    if (last?.status === "success") {
      console.log(
        `\nIndexer completed: ${last.itemsProcessed} items processed, ${last.failedItemCount} failed.`,
      );
      return true;
    }

    if (last?.status === "transientFailure" || last?.status === "persistentFailure") {
      console.error(`\nIndexer failed: ${last.status}`);
      if (last.errors?.length > 0) {
        for (const err of last.errors.slice(0, 5)) {
          console.error(`  - ${err.message}`);
        }
      }
      return false;
    }

    // Might still be starting up
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  console.warn("\nTimeout waiting for indexer to complete.");
  return false;
}

// ============================================================================
// Ingest (upload to blob + run indexer)
// ============================================================================

function getContentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  const types = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".html": "text/html",
    ".htm": "text/html",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".csv": "text/csv",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return types[ext] || "application/octet-stream";
}

async function ingestFile(config, filePath) {
  if (!existsSync(filePath)) {
    console.error(`ERROR: File not found: ${filePath}`);
    process.exit(1);
  }

  if (!config.storageConnectionString) {
    console.error("ERROR: STORAGE_CONNECTION_STRING must be set for ingest.");
    process.exit(1);
  }

  // Raw bytes: PDFs and Office documents are binary.
  const content = readFileSync(filePath);
  const blobName = basename(filePath);
  const contentType = getContentType(filePath);

  console.log(
    `Uploading "${blobName}" to blob container "${config.storageContainer}"...`,
  );
  await uploadToBlob(config, blobName, content, contentType);
  console.log(`  Uploaded: ${blobName} (${content.length} chars)`);
}

async function ingestManifest(config, manifestPath) {
  if (!existsSync(manifestPath)) {
    console.error(`ERROR: Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const entries = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (!Array.isArray(entries)) {
    console.error("ERROR: Manifest must be a JSON array.");
    process.exit(1);
  }

  console.log(`Uploading ${entries.length} files from manifest...`);

  for (const entry of entries) {
    const filePath = resolve(dirname(manifestPath), entry.file);
    await ingestFile(config, filePath);
  }

  console.log(`All ${entries.length} files uploaded to blob storage.`);
}

// ============================================================================
// Delete
// ============================================================================

async function deleteBySource(config, source) {
  // Search for all chunks with this source
  const results = await searchRequest(
    config,
    "POST",
    `/indexes/${config.indexName}/docs/search`,
    {
      filter: `source eq '${source.replace(/'/g, "''")}'`,
      select: "chunk_id",
      top: 1000,
    },
  );

  const ids = results.value?.map((doc) => doc.chunk_id) ?? [];

  if (ids.length === 0) {
    console.log(`No chunks found for source "${source}".`);
    return;
  }

  console.log(`Deleting ${ids.length} chunks for source "${source}"...`);

  const BATCH_SIZE = 100;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    await searchRequest(
      config,
      "POST",
      `/indexes/${config.indexName}/docs/index`,
      {
        value: batch.map((id) => ({
          "@search.action": "delete",
          chunk_id: id,
        })),
      },
    );
    console.log(
      `  Deleted ${Math.min(i + BATCH_SIZE, ids.length)}/${ids.length}`,
    );
  }

  console.log(`Deleted all chunks for source "${source}".`);
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  if (
    args.includes("--ensure-pipeline") ||
    args[0] === "ensure-pipeline" ||
    args.includes("--ensure-index")
  ) {
    await ensurePipeline(config);
    return;
  }

  const command = args[0];

  if (command === "ingest") {
    const manifestIdx = args.indexOf("--manifest");
    if (manifestIdx !== -1) {
      await ensurePipeline(config);
      await ingestManifest(config, resolve(args[manifestIdx + 1]));
      console.log("\nTriggering indexer to process uploaded files...");
      await runIndexer(config);
      console.log("Waiting for indexer to complete...");
      await waitForIndexer(config);
      return;
    }

    const fileIdx = args.indexOf("--file");
    if (fileIdx === -1) {
      console.error("ERROR: --file or --manifest required for ingest command.");
      process.exit(1);
    }

    await ensurePipeline(config);
    await ingestFile(config, resolve(args[fileIdx + 1]));
    console.log("\nTriggering indexer to process uploaded file...");
    await runIndexer(config);
    console.log("Waiting for indexer to complete...");
    await waitForIndexer(config);
    return;
  }

  if (command === "run-indexer") {
    await runIndexer(config);
    return;
  }

  if (command === "reset-indexer") {
    await resetIndexer(config);
    return;
  }

  if (command === "indexer-status") {
    await getIndexerStatus(config);
    return;
  }

  if (command === "delete") {
    const sourceIdx = args.indexOf("--source");
    if (sourceIdx === -1) {
      console.error("ERROR: --source required for delete command.");
      process.exit(1);
    }
    await deleteBySource(config, args[sourceIdx + 1]);
    return;
  }

  console.log(`
AgentForEach Knowledge Base — Integrated Pipeline Tool

Usage:
  node scripts/ingest-knowledge.mjs --ensure-pipeline          Set up index + data source + skillset + indexer
  node scripts/ingest-knowledge.mjs ingest --file <path>       Upload file to blob → indexer processes it
  node scripts/ingest-knowledge.mjs ingest --manifest <json>   Upload files from manifest → indexer processes them
  node scripts/ingest-knowledge.mjs run-indexer                Trigger the indexer to run now
  node scripts/ingest-knowledge.mjs reset-indexer              Reset indexer (reprocesses all docs on next run)
  node scripts/ingest-knowledge.mjs indexer-status             Check indexer run status
  node scripts/ingest-knowledge.mjs delete --source <name>     Delete chunks by source

Environment:
  SEARCH_ENDPOINT                    Azure AI Search endpoint URL
  SEARCH_API_KEY                     Admin API key
  STORAGE_CONNECTION_STRING          Azure Storage connection string (for blob upload)
  STORAGE_CONTAINER                  Blob container name (default: knowledge-docs)
  AZURE_OPENAI_ENDPOINT              Azure OpenAI endpoint for embedding
  AZURE_OPENAI_API_KEY               Azure OpenAI API key
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT  Embedding deployment name (default: text-embedding-3-small)
  AZURE_OPENAI_EMBEDDING_MODEL       Embedding model name (default: text-embedding-3-small)
`);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
