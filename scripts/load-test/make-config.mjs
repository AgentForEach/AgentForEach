#!/usr/bin/env node
/**
 * Write packages/gateway/config/agentforeach.loadtest.json: agentforeach.json with
 * HS256 JWT auth (the secret is read from LOADTEST_JWT_SECRET at runtime), so
 * run.mjs can act as any number of users. Deploy it with the app and set
 * CONFIG_FILE_JSON=agentforeach.loadtest.json and LOADTEST_JWT_SECRET on the
 * scratch stack (agentforeach:extraAppSettings). Never on a real deployment.
 *
 *   node scripts/load-test/make-config.mjs [--mock-llm-url https://<mock>/v1] [--model gpt-5.6-luna]
 *     [--openai-base-url https://<resource>.openai.azure.com/openai/v1/]
 *     [--embedding-base-url https://<resource>.openai.azure.com/openai/v1/ --embedding-api-key-env NAME]
 *
 * --openai-base-url sends model calls to an OpenAI-compatible endpoint such
 * as Azure OpenAI in Foundry (the deployment name is the model name; the
 * key is OPENAI_API_KEY). Embeddings can use another resource and key.
 *
 * With --mock-llm-url, model and embedding calls go to mock-llm.mjs, and
 * features the scratch stack doesn't deploy (Anthropic failover, knowledge
 * search) are off: the run then measures the platform, not a provider.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../packages/gateway/config/", import.meta.url));
const config = JSON.parse(readFileSync(`${dir}agentforeach.json`, "utf8"));

config.auth = {
  ...config.auth,
  providers: [
    {
      type: "jwt",
      enabled: true,
      algorithm: "HS256",
      secret: "$LOADTEST_JWT_SECRET",
      issuer: "agentforeach-loadtest",
      audience: "agentforeach",
      userIdClaim: "sub",
    },
  ],
};
// Measure the platform, not a sales funnel.
config.credits = { ...config.credits, enabled: false };
// The scratch stack has no AI Search.
config.knowledge = { ...config.knowledge, enabled: false };

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (arg("--openai-base-url")) {
  config.llms.providers.openai = { ...config.llms.providers.openai, baseUrl: arg("--openai-base-url") };
  // No Anthropic key on a scratch stack: failing over would only add errors.
  config.llms.providers.anthropic = { ...config.llms.providers.anthropic, enabled: false };
  config.llms.failover = { ...config.llms.failover, enabled: false };
  console.log(`model calls go to ${arg("--openai-base-url")}`);
}
if (arg("--embedding-base-url")) {
  config.llms.embedding = {
    ...config.llms.embedding,
    baseUrl: arg("--embedding-base-url"),
    ...(arg("--embedding-api-key-env") ? { apiKey: `$${arg("--embedding-api-key-env")}` } : {}),
  };
  console.log(`embedding calls go to ${arg("--embedding-base-url")}`);
}

const modelIndex = process.argv.indexOf("--model");
if (modelIndex > 0) {
  const model = process.argv[modelIndex + 1];
  config.llms.providers.openai = { ...config.llms.providers.openai, defaultModel: model };
  console.log(`default model: ${model}`);
}

const mockIndex = process.argv.indexOf("--mock-llm-url");
if (mockIndex > 0) {
  const url = process.argv[mockIndex + 1];
  config.llms.providers.openai = { ...config.llms.providers.openai, baseUrl: url };
  config.llms.providers.anthropic = { ...config.llms.providers.anthropic, enabled: false };
  config.llms.failover = { ...config.llms.failover, enabled: false };
  config.llms.embedding = { ...config.llms.embedding, baseUrl: url };
  console.log(`model and embedding calls go to ${url}`);
}

writeFileSync(`${dir}agentforeach.loadtest.json`, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${dir}agentforeach.loadtest.json`);
