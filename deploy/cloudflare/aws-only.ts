/**
 * Stands in for an AWS-only module in the Worker bundle, as azure-only.ts
 * does for Azure.
 *
 * The gateway loads the Bedrock runtime SDK only through `await import()`,
 * the first time the `bedrock` model provider or Bedrock embeddings are used
 * (gateway/llms/providers/bedrock.ts). wrangler.jsonc aliases it here, so the
 * AWS SDK is never bundled into the Worker, and a configuration that selects
 * Bedrock fails with a clear error. scripts/check-bundle.mjs fails if the
 * Worker reaches AWS SDK code another way.
 */

import { unavailableModule } from "../shared/unavailable.js";

const stub = unavailableModule(
  (name) =>
    `${name} is AWS-only and isn't available on Cloudflare Workers. ` +
    "Choose a model provider with an API key (openai, anthropic or an OpenAI-compatible one), and OpenAI-compatible embeddings.",
);

export default stub;
export const BedrockRuntimeClient = stub.BedrockRuntimeClient;
export const ConverseCommand = stub.ConverseCommand;
export const ConverseStreamCommand = stub.ConverseStreamCommand;
export const InvokeModelCommand = stub.InvokeModelCommand;
