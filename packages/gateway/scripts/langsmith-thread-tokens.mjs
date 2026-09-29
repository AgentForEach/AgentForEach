#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CosmosClient } from "@azure/cosmos";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const TOKENS_PER_MILLION = 1_000_000;
const PRICING_PER_MILLION_TOKENS = {
  input: 0.75,
  cachedInput: 0.075,
  output: 4.50,
};

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.thread) {
  printUsage();
  process.exit(args.help ? 0 : 1);
}

const config = loadJson(path.join(rootDir, "config", `${args.config}.json`));
const langsmithConfig = config?.observability?.langsmith ?? {};
const usageConfig = config?.usage ?? {};
const creditsConfig = config?.credits ?? {};
loadLocalSettings(args.settings ?? `local.settings.${args.config}.json`);

const apiKey =
  process.env.LANGSMITH_API_KEY ??
  process.env.LANGCHAIN_API_KEY ??
  resolveEnvValue(langsmithConfig.apiKey);

if (!apiKey) {
  console.error("Missing LANGSMITH_API_KEY or LANGCHAIN_API_KEY.");
  process.exit(1);
}

const apiUrl = trimTrailingSlash(
  args.apiUrl ??
    process.env.LANGSMITH_ENDPOINT ??
    process.env.LANGCHAIN_ENDPOINT ??
    resolveEnvValue(langsmithConfig.apiUrl) ??
    "https://api.smith.langchain.com",
);

const projectName =
  args.project ??
  process.env.LANGSMITH_PROJECT ??
  process.env.LANGCHAIN_PROJECT ??
  resolveEnvValue(langsmithConfig.project) ??
  "agentforeach";

const projectId = args.projectId ?? process.env.LANGSMITH_PROJECT_ID ?? await resolveProjectId({
  apiUrl,
  apiKey,
  projectName,
});

const runs = await fetchThreadRuns({
  apiUrl,
  apiKey,
  projectId,
  threadId: args.thread,
  limit: args.limit,
});

const runsWithUsage = runs
  .map((run) => ({ run, usage: extractUsageMetadata(run) }))
  .filter((item) => item.usage);

const selected = args.allRuns
  ? runsWithUsage
  : runsWithUsage.filter((item) => item.run.run_type === "llm");

const totals = selected.reduce(
  (acc, item) => {
    const usage = item.usage;
    acc.inputTokens += numberAt(usage, ["input_tokens", "prompt_tokens"]);
    acc.cacheTokens += numberAt(usage, [
      "input_token_details.cache_read",
      "input_token_details.cached_tokens",
      "prompt_tokens_details.cached_tokens",
      "cache_read_input_tokens",
      "cached_input_tokens",
    ]);
    acc.outputTokens += numberAt(usage, ["output_tokens", "completion_tokens"]);
    acc.totalTokens += numberAt(usage, ["total_tokens"]);
    return acc;
  },
  { inputTokens: 0, cacheTokens: 0, outputTokens: 0, totalTokens: 0 },
);

const computedTotal = totals.inputTokens + totals.outputTokens;
const pricing = calculatePricing(totals);

const byRunType = runs.reduce((acc, run) => {
  const type = run.run_type ?? "unknown";
  acc[type] = (acc[type] ?? 0) + 1;
  return acc;
}, {});

const reconciliation = args.reconcile
  ? await reconcileUsageRecords({
      config,
      usageConfig,
      creditsConfig,
      runs,
      selected,
      langSmithTotals: totals,
      langSmithPricing: pricing,
      threadId: args.thread,
    })
  : { enabled: false, skippedReason: "disabled_by_flag" };

const report = {
  threadId: args.thread,
  project: projectName,
  projectId,
  runs: runs.length,
  byRunType,
  summedRuns: selected.length,
  summedRunTypes: args.allRuns ? "all runs with usage" : "llm runs only",
  tokens: {
    input: totals.inputTokens,
    cache: totals.cacheTokens,
    billableInput: pricing.billableInputTokens,
    output: totals.outputTokens,
    totalFromUsage: totals.totalTokens || undefined,
    totalInputPlusOutput: computedTotal,
  },
  pricing,
  reconciliation,
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`LangSmith thread: ${report.threadId}`);
  console.log(`Project: ${report.project} (${report.projectId})`);
  console.log(`Runs fetched: ${report.runs} ${JSON.stringify(report.byRunType)}`);
  console.log(`Summed: ${report.summedRuns} ${report.summedRunTypes}`);
  console.log("");
  console.log(`Input tokens:  ${report.tokens.input}`);
  console.log(`Cache tokens:  ${report.tokens.cache}`);
  console.log(`Billable input tokens: ${report.tokens.billableInput}`);
  console.log(`Output tokens: ${report.tokens.output}`);
  if (report.tokens.totalFromUsage !== undefined) {
    console.log(`Total tokens:  ${report.tokens.totalFromUsage} (from usage metadata)`);
  }
  console.log(`Input+output:  ${report.tokens.totalInputPlusOutput}`);
  console.log("");
  console.log("Estimated pricing:");
  console.log(`Input:        ${formatUsd(report.pricing.inputCost)} (${report.tokens.billableInput} @ $${PRICING_PER_MILLION_TOKENS.input}/1M)`);
  console.log(`Cached input: ${formatUsd(report.pricing.cachedInputCost)} (${report.tokens.cache} @ $${PRICING_PER_MILLION_TOKENS.cachedInput}/1M)`);
  console.log(`Output:       ${formatUsd(report.pricing.outputCost)} (${report.tokens.output} @ $${PRICING_PER_MILLION_TOKENS.output}/1M)`);
  console.log(`Total cost:   ${formatUsd(report.pricing.totalCost)}`);

  printReconciliation(report.reconciliation);
}

function parseArgs(argv) {
  const parsed = {
    thread: undefined,
    project: undefined,
    projectId: undefined,
    apiUrl: undefined,
    config: "agentforeach",
    settings: undefined,
    limit: 100,
    allRuns: false,
    reconcile: true,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--thread":
        parsed.thread = argv[++index];
        break;
      case "--project":
        parsed.project = argv[++index];
        break;
      case "--project-id":
        parsed.projectId = argv[++index];
        break;
      case "--api-url":
        parsed.apiUrl = argv[++index];
        break;
      case "--config":
        parsed.config = argv[++index] ?? parsed.config;
        break;
      case "--settings":
        parsed.settings = argv[++index];
        break;
      case "--limit":
        parsed.limit = Number(argv[++index] ?? parsed.limit);
        break;
      case "--all-runs":
        parsed.allRuns = true;
        break;
      case "--no-reconcile":
        parsed.reconcile = false;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        if (!arg.startsWith("-") && !parsed.thread) {
          parsed.thread = arg;
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  npm run langsmith:tokens -- --thread <thread_id>
  node scripts/langsmith-thread-tokens.mjs <thread_id>

Options:
  --project <name>       LangSmith project name (default: config/env agentforeach)
  --project-id <uuid>    LangSmith project/session UUID, skips project lookup
  --config <name>        Config file name under config/, without .json (default: agentforeach)
  --settings <file>      Azure local settings file to load (default: local.settings.<config>.json)
  --limit <number>       Maximum runs to fetch (default: 100)
  --all-runs             Sum all runs with usage metadata instead of only llm runs
  --no-reconcile         Skip Cosmos usage-record reconciliation
  --json                 Print JSON
`);
}

function loadJson(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadLocalSettings(fileName) {
  const localSettings = loadJson(path.resolve(rootDir, fileName));
  const values = localSettings?.Values;
  if (!values || typeof values !== "object") return;

  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveEnvValue(value) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("$")) return value;
  return process.env[value.slice(1)];
}

function resolveOptionalEnvValue(value) {
  const resolved = resolveEnvValue(value);
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function resolveProjectId({ apiUrl, apiKey, projectName }) {
  const response = await requestJson({
    apiUrl,
    apiKey,
    path: "/sessions?limit=100",
    method: "GET",
  });

  const sessions = Array.isArray(response) ? response : response.sessions ?? response.items ?? [];
  const match = sessions.find((session) => session?.name === projectName);

  if (!match?.id) {
    throw new Error(`Could not find LangSmith project/session named "${projectName}".`);
  }

  return match.id;
}

async function fetchThreadRuns({ apiUrl, apiKey, projectId, threadId, limit }) {
  const baseBody = {
    session: [projectId],
    limit,
    select: ["id", "name", "run_type", "start_time", "status", "outputs", "extra"],
  };

  try {
    const response = await requestJson({
      apiUrl,
      apiKey,
      path: "/runs/query",
      method: "POST",
      body: {
        ...baseBody,
        filter: `eq(metadata_key, \\\"thread_id\\\") and eq(metadata_value, \\\"${escapeFilterValue(threadId)}\\\")`,
      },
    });

    return response.runs ?? [];
  } catch (error) {
    if (!String(error).includes("Unable to parse filter")) {
      throw error;
    }
  }

  const response = await requestJson({
    apiUrl,
    apiKey,
    path: "/runs/query",
    method: "POST",
    body: baseBody,
  });

  return (response.runs ?? []).filter((run) => getThreadId(run) === threadId);
}

async function requestJson({ apiUrl, apiKey, path, method, body }) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`LangSmith ${method} ${path} failed (${response.status}): ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

function escapeFilterValue(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function extractUsageMetadata(run) {
  return firstObject(
    run?.extra?.metadata?.usage_metadata,
    run?.outputs?.usage_metadata,
    run?.outputs?.outputs?.usage_metadata,
    run?.outputs?.llm_output?.token_usage,
    run?.outputs?.usage,
  );
}

function getThreadId(run) {
  return run?.extra?.metadata?.thread_id ?? run?.extra?.metadata?.threadId;
}

function getRunMetadata(run) {
  return firstObject(run?.extra?.metadata) ?? {};
}

function getMetadataValue(metadata, keys) {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value));
}

function numberAt(object, paths) {
  for (const pathValue of paths) {
    const value = pathValue.split(".").reduce((current, key) => current?.[key], object);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function calculatePricing(totals) {
  const billableInputTokens = Math.max(totals.inputTokens - totals.cacheTokens, 0);
  const inputCost = costForTokens(billableInputTokens, PRICING_PER_MILLION_TOKENS.input);
  const cachedInputCost = costForTokens(totals.cacheTokens, PRICING_PER_MILLION_TOKENS.cachedInput);
  const outputCost = costForTokens(totals.outputTokens, PRICING_PER_MILLION_TOKENS.output);

  return {
    ratesPerMillionTokens: PRICING_PER_MILLION_TOKENS,
    billableInputTokens,
    inputCost,
    cachedInputCost,
    outputCost,
    totalCost: inputCost + cachedInputCost + outputCost,
  };
}

async function reconcileUsageRecords({
  config,
  usageConfig,
  creditsConfig,
  runs,
  selected,
  langSmithTotals,
  langSmithPricing,
  threadId,
}) {
  const databaseConfig = resolveDatabaseConfig(config?.database ?? {});
  const containerId = resolveOptionalEnvValue(usageConfig.containerId) ?? "usage-records";

  if (!databaseConfig.endpoint || !databaseConfig.key || !databaseConfig.databaseId) {
    return {
      enabled: true,
      skippedReason: "missing_cosmos_config",
      metadata: extractThreadMetadata(runs, selected),
    };
  }

  const metadata = extractThreadMetadata(runs, selected);
  const userIds = metadata.userIds.length > 0 ? metadata.userIds : inferUserIdsFromThreadId(threadId);

  if (userIds.length === 0) {
    return {
      enabled: true,
      skippedReason: "missing_user_id_metadata",
      metadata,
    };
  }

  const client = new CosmosClient({
    endpoint: databaseConfig.endpoint,
    key: databaseConfig.key,
  });
  const container = client.database(databaseConfig.databaseId).container(containerId);

  const records = await fetchUsageRecordsForMetadata({
    container,
    metadata,
    userIds,
  });

  const cosmosTotals = summarizeUsageRecords(records);
  const langSmithByRunId = summarizeLangSmithByRunId(selected);
  const costMultiplier = numberOrDefault(resolveEnvValue(creditsConfig.costMultiplier), 100);
  const minimumCharge = numberOrDefault(resolveEnvValue(creditsConfig.minimumCharge), 1);
  const expectedCoinsIfChargedOnce = Math.max(
    minimumCharge,
    Math.round(cosmosTotals.estimatedCostUsd * costMultiplier),
  );
  const expectedCoinsPerRun = records.reduce((sum, record) => {
    const cost = numberOrDefault(record.estimatedCostUsd, 0);
    return sum + Math.max(minimumCharge, Math.round(cost * costMultiplier));
  }, 0);

  return {
    enabled: true,
    databaseId: databaseConfig.databaseId,
    containerId,
    metadata,
    matchedRecords: records.length,
    missingRunIds: metadata.runIds.filter(
      (runId) => !records.some((record) => record.runId === runId),
    ),
    langSmithRunIdsWithoutCosmos: [...langSmithByRunId.keys()].filter(
      (runId) => !records.some((record) => record.runId === runId),
    ),
    tokens: cosmosTotals.tokens,
    pricing: {
      estimatedCostUsd: roundMoney(cosmosTotals.estimatedCostUsd),
    },
    coins: {
      charged: cosmosTotals.coinsCharged,
      deductedRecords: cosmosTotals.deductedRecords,
      skippedRecords: cosmosTotals.skippedRecords,
      pendingRecords: cosmosTotals.pendingRecords,
      expectedFromCosmosCost: expectedCoinsPerRun,
      expectedIfChargedOnce: expectedCoinsIfChargedOnce,
      costMultiplier,
      minimumCharge,
      currencies: [...cosmosTotals.currencies].sort(),
    },
    deltas: {
      inputTokens: cosmosTotals.tokens.input - langSmithTotals.inputTokens,
      cacheTokens: cosmosTotals.tokens.cache - langSmithTotals.cacheTokens,
      outputTokens: cosmosTotals.tokens.output - langSmithTotals.outputTokens,
      totalTokens: cosmosTotals.tokens.totalInputPlusOutput - (langSmithTotals.inputTokens + langSmithTotals.outputTokens),
      estimatedCostUsd: roundMoney(cosmosTotals.estimatedCostUsd - langSmithPricing.totalCost),
    },
    records: records.map((record) => buildRecordReconciliation(record, langSmithByRunId)),
  };
}

function resolveDatabaseConfig(databaseSection) {
  return {
    endpoint:
      process.env.COSMOS_ENDPOINT ??
      resolveOptionalEnvValue(databaseSection.endpoint),
    key:
      process.env.COSMOS_KEY ??
      resolveOptionalEnvValue(databaseSection.key),
    databaseId:
      process.env.COSMOS_DATABASE ??
      resolveOptionalEnvValue(databaseSection.databaseId) ??
      "agentforeach",
  };
}

function extractThreadMetadata(runs, selected) {
  const relevantRuns = selected.length > 0 ? selected.map((item) => item.run) : runs;
  const metadataValues = relevantRuns.map(getRunMetadata);

  return {
    threadIds: unique(metadataValues.map((metadata) => getMetadataValue(metadata, ["thread_id", "threadId"]))),
    userIds: unique(metadataValues.map((metadata) => getMetadataValue(metadata, ["userId", "user_id"]))),
    sessionIds: unique(metadataValues.map((metadata) => getMetadataValue(metadata, ["sessionId", "session_id"]))),
    runIds: unique(metadataValues.map((metadata) => getMetadataValue(metadata, ["runId", "run_id"]))),
    agentIds: unique(metadataValues.map((metadata) => getMetadataValue(metadata, ["agentId", "agent_id"]))),
    channelNames: unique(metadataValues.map((metadata) => getMetadataValue(metadata, ["channelName", "channel_name"]))),
    sources: unique(metadataValues.map((metadata) => getMetadataValue(metadata, ["source"]))),
  };
}

function inferUserIdsFromThreadId(threadId) {
  const separatorIndex = threadId.indexOf(":");
  if (separatorIndex <= 0) return [];
  return [threadId.slice(0, separatorIndex)];
}

async function fetchUsageRecordsForMetadata({ container, metadata, userIds }) {
  const recordsById = new Map();

  for (const userId of userIds) {
    for (const runId of metadata.runIds) {
      const id = `${userId}:${runId}`;
      try {
        const { resource } = await container.item(id, userId).read();
        if (resource?.id) recordsById.set(resource.id, resource);
      } catch (error) {
        if (error?.code !== 404) throw error;
      }
    }

    if (metadata.sessionIds.length > 0) {
      const query = {
        query: "SELECT * FROM c WHERE c.userId = @userId AND ARRAY_CONTAINS(@sessionIds, c.sessionId)",
        parameters: [
          { name: "@userId", value: userId },
          { name: "@sessionIds", value: metadata.sessionIds },
        ],
      };
      const { resources } = await container.items
        .query(query, { partitionKey: userId })
        .fetchAll();

      for (const resource of resources) {
        if (metadata.runIds.length === 0 || metadata.runIds.includes(resource.runId)) {
          recordsById.set(resource.id, resource);
        }
      }
    }
  }

  return [...recordsById.values()].sort((left, right) => {
    return String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""));
  });
}

function summarizeUsageRecords(records) {
  const totals = {
    tokens: {
      input: 0,
      cache: 0,
      billableInput: 0,
      output: 0,
      totalFromUsage: 0,
      totalInputPlusOutput: 0,
    },
    estimatedCostUsd: 0,
    coinsCharged: 0,
    deductedRecords: 0,
    skippedRecords: 0,
    pendingRecords: 0,
    currencies: new Set(),
  };

  for (const record of records) {
    const input = numberOrDefault(record.inputTokens, 0);
    const cache = numberOrDefault(record.cachedInputTokens, 0);
    const output = numberOrDefault(record.outputTokens, 0);
    totals.tokens.input += input;
    totals.tokens.cache += cache;
    totals.tokens.output += output;
    totals.tokens.totalFromUsage += numberOrDefault(record.totalTokens, input + output);
    totals.estimatedCostUsd += numberOrDefault(record.estimatedCostUsd, 0);

    if (typeof record.coinsCharged === "number") {
      totals.coinsCharged += record.coinsCharged;
    }
    if (record.coinCurrencyCode) totals.currencies.add(record.coinCurrencyCode);

    if (record.coinChargeStatus === "deducted") {
      totals.deductedRecords += 1;
    } else if (record.coinChargeStatus === "skipped") {
      totals.skippedRecords += 1;
    } else {
      totals.pendingRecords += 1;
    }
  }

  totals.tokens.billableInput = Math.max(totals.tokens.input - totals.tokens.cache, 0);
  totals.tokens.totalInputPlusOutput = totals.tokens.input + totals.tokens.output;
  return totals;
}

function summarizeLangSmithByRunId(selected) {
  const byRunId = new Map();

  for (const item of selected) {
    const metadata = getRunMetadata(item.run);
    const runId = getMetadataValue(metadata, ["runId", "run_id"]);
    if (!runId) continue;

    const existing = byRunId.get(runId) ?? {
      llmRuns: 0,
      tokens: {
        input: 0,
        cache: 0,
        billableInput: 0,
        output: 0,
        totalFromUsage: 0,
        totalInputPlusOutput: 0,
      },
      pricing: {
        totalCost: 0,
      },
    };

    const usage = item.usage;
    existing.llmRuns += 1;
    existing.tokens.input += numberAt(usage, ["input_tokens", "prompt_tokens"]);
    existing.tokens.cache += numberAt(usage, [
      "input_token_details.cache_read",
      "input_token_details.cached_tokens",
      "prompt_tokens_details.cached_tokens",
      "cache_read_input_tokens",
      "cached_input_tokens",
    ]);
    existing.tokens.output += numberAt(usage, ["output_tokens", "completion_tokens"]);
    existing.tokens.totalFromUsage += numberAt(usage, ["total_tokens"]);
    existing.tokens.billableInput = Math.max(existing.tokens.input - existing.tokens.cache, 0);
    existing.tokens.totalInputPlusOutput = existing.tokens.input + existing.tokens.output;
    existing.pricing = calculatePricing({
      inputTokens: existing.tokens.input,
      cacheTokens: existing.tokens.cache,
      outputTokens: existing.tokens.output,
      totalTokens: existing.tokens.totalFromUsage,
    });

    byRunId.set(runId, existing);
  }

  return byRunId;
}

function buildRecordReconciliation(record, langSmithByRunId) {
  const langSmith = langSmithByRunId.get(record.runId) ?? {
    llmRuns: 0,
    tokens: {
      input: 0,
      cache: 0,
      billableInput: 0,
      output: 0,
      totalFromUsage: 0,
      totalInputPlusOutput: 0,
    },
    pricing: { totalCost: 0 },
  };

  const cosmos = {
    inputTokens: record.inputTokens ?? 0,
    cachedInputTokens: record.cachedInputTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
    totalTokens: record.totalTokens ?? 0,
    estimatedCostUsd: record.estimatedCostUsd ?? 0,
  };

  return {
    id: record.id,
    runId: record.runId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    model: record.model,
    langSmith: {
      llmRuns: langSmith.llmRuns,
      inputTokens: langSmith.tokens.input,
      cachedInputTokens: langSmith.tokens.cache,
      outputTokens: langSmith.tokens.output,
      totalTokens: langSmith.tokens.totalInputPlusOutput,
      estimatedCostUsd: roundMoney(langSmith.pricing.totalCost),
    },
    cosmos,
    deltas: {
      inputTokens: cosmos.inputTokens - langSmith.tokens.input,
      cachedInputTokens: cosmos.cachedInputTokens - langSmith.tokens.cache,
      outputTokens: cosmos.outputTokens - langSmith.tokens.output,
      totalTokens: cosmos.inputTokens + cosmos.outputTokens - langSmith.tokens.totalInputPlusOutput,
      estimatedCostUsd: roundMoney(cosmos.estimatedCostUsd - langSmith.pricing.totalCost),
    },
    coinsCharged: record.coinsCharged,
    coinCurrencyCode: record.coinCurrencyCode,
    coinChargeStatus: record.coinChargeStatus,
    coinBalanceAfter: record.coinBalanceAfter,
    coinChargedAt: record.coinChargedAt,
  };
}

function printReconciliation(reconciliation) {
  console.log("");
  console.log("Cosmos reconciliation:");

  if (!reconciliation.enabled) {
    console.log(`Skipped: ${reconciliation.skippedReason}`);
    return;
  }

  if (reconciliation.skippedReason) {
    console.log(`Skipped: ${reconciliation.skippedReason}`);
    if (reconciliation.metadata) {
      console.log(`Metadata: ${formatMetadataSummary(reconciliation.metadata)}`);
    }
    return;
  }

  console.log(`Container: ${reconciliation.databaseId}/${reconciliation.containerId}`);
  console.log(`Metadata: ${formatMetadataSummary(reconciliation.metadata)}`);
  console.log(`Matched usage records: ${reconciliation.matchedRecords}`);
  if (reconciliation.missingRunIds.length > 0) {
    console.log(`Missing runIds: ${reconciliation.missingRunIds.join(", ")}`);
  }
  if (reconciliation.langSmithRunIdsWithoutCosmos.length > 0) {
    console.log(`LangSmith runIds without Cosmos: ${reconciliation.langSmithRunIdsWithoutCosmos.join(", ")}`);
  }
  console.log(`Cosmos input tokens:  ${reconciliation.tokens.input} (delta ${formatSigned(reconciliation.deltas.inputTokens)})`);
  console.log(`Cosmos cache tokens:  ${reconciliation.tokens.cache} (delta ${formatSigned(reconciliation.deltas.cacheTokens)})`);
  console.log(`Cosmos output tokens: ${reconciliation.tokens.output} (delta ${formatSigned(reconciliation.deltas.outputTokens)})`);
  console.log(`Cosmos total tokens:  ${reconciliation.tokens.totalInputPlusOutput} (delta ${formatSigned(reconciliation.deltas.totalTokens)})`);
  console.log(`Cosmos cost:          ${formatUsd(reconciliation.pricing.estimatedCostUsd)} (delta ${formatSignedUsd(reconciliation.deltas.estimatedCostUsd)})`);
  console.log(`Coins charged:        ${reconciliation.coins.charged} ${reconciliation.coins.currencies.join(", ") || ""}`.trim());
  console.log(`Coin records:         ${reconciliation.coins.deductedRecords} deducted, ${reconciliation.coins.skippedRecords} skipped, ${reconciliation.coins.pendingRecords} pending`);
  console.log(`Expected coins:       ${reconciliation.coins.expectedFromCosmosCost} per run (${reconciliation.coins.costMultiplier}x, min ${reconciliation.coins.minimumCharge})`);
  console.log(`If charged once:      ${reconciliation.coins.expectedIfChargedOnce} for aggregate thread cost`);

  if (reconciliation.records.length > 0) {
    console.log("");
    console.log("Per runId:");
    for (const record of reconciliation.records) {
      const coinStatus = record.coinChargeStatus ?? "pending";
      const coins = typeof record.coinsCharged === "number" ? record.coinsCharged : "n/a";
      console.log(
        `- ${record.runId}: ` +
          `LS ${record.langSmith.totalTokens} tok ${formatUsd(record.langSmith.estimatedCostUsd)}, ` +
          `Cosmos ${record.cosmos.inputTokens + record.cosmos.outputTokens} tok ${formatUsd(record.cosmos.estimatedCostUsd)}, ` +
          `delta ${formatSigned(record.deltas.totalTokens)} tok ${formatSignedUsd(record.deltas.estimatedCostUsd)}, ` +
          `coins ${coins} ${coinStatus}`,
      );
    }
  }
}

function formatMetadataSummary(metadata) {
  return [
    `users=${metadata.userIds.join(",") || "none"}`,
    `sessions=${metadata.sessionIds.join(",") || "none"}`,
    `runIds=${metadata.runIds.length}`,
    `agents=${metadata.agentIds.join(",") || "none"}`,
    `channels=${metadata.channelNames.join(",") || "none"}`,
  ].join(" ");
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function numberOrDefault(value, fallback) {
  const numberValue = typeof value === "string" ? Number(value) : value;
  return typeof numberValue === "number" && Number.isFinite(numberValue) ? numberValue : fallback;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatSigned(value) {
  return value >= 0 ? `+${value}` : String(value);
}

function formatSignedUsd(value) {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatUsd(Math.abs(value))}`;
}

function costForTokens(tokens, dollarsPerMillionTokens) {
  return (tokens / TOKENS_PER_MILLION) * dollarsPerMillionTokens;
}

function formatUsd(value) {
  return `$${value.toFixed(6)}`;
}
