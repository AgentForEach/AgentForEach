/**
 * Stands in for an Azure-only module in the Lambda bundle, as
 * deploy/cloudflare/azure-only.ts does in the Worker's.
 *
 * The gateway reaches Azure-only code (Cosmos, Blob Storage, Web PubSub,
 * Entra ID tokens, the ACA sandbox clients) only through `await import()` or
 * on paths a deployment's configuration selects. scripts/lambda-bundle.mjs
 * aliases each such module here, so the Azure SDKs are never bundled into
 * the Lambda package, and a configuration that selects one anyway fails with
 * a clear error. scripts/check-lambda-bundle.mjs fails if the bundle reaches
 * Azure (or Cloudflare) code another way.
 */

import { unavailableModule } from "../shared/unavailable.js";

const stub = unavailableModule(
  (name) =>
    `${name} is Azure-only and isn't available on AWS Lambda. ` +
    "Choose a provider this platform supports (database: postgres; objects: s3; realtime: AppSync Events).",
);

export default stub;
export const CosmosStorage = stub.CosmosStorage;
export const AzureBlobObjectStore = stub.AzureBlobObjectStore;
export const WebPubSubRealtime = stub.WebPubSubRealtime;
export const webPubSubRelay = stub.webPubSubRelay;
export const webPubSubHost = stub.webPubSubHost;
export const createAzureTokenCredential = stub.createAzureTokenCredential;
export const createDefaultTokenProvider = stub.createDefaultTokenProvider;
export const AcaSandboxesClient = stub.AcaSandboxesClient;
export const DynamicSessionsClient = stub.DynamicSessionsClient;
