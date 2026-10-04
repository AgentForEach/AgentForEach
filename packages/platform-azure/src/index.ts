/**
 * @agentforeach/platform-azure: the Azure platform pack.
 */

export { currentInvocationContext, registerFunctions, type FunctionsApp } from "./host.js";

// Object store: Azure Blob Storage.
export { AzureBlobObjectStore, type AzureBlobObjectStoreOptions, type AzureStorageIdentity } from "./objects/azure-blob.js";

// Realtime: Azure Web PubSub.
export { WebPubSubRealtime, webPubSubRelay, webPubSubHost, type WebPubSubRealtimeOptions } from "./realtime/web-pubsub.js";

// Durable port: Durable Functions orchestrations for jobs, waits and alarms.
export {
  AzureDurable,
  registerDurable,
  ORCHESTRATIONS,
  MAX_TIMER_MS,
  type AzureDurableOptions,
  type DurableApp,
  type DurableClientLike,
} from "./durable/durable.js";
export { registerLegacyOrchestrations, LEGACY_KINDS } from "./durable/legacy.js";
export { durableHistoryPurge, withDurableMaintenance } from "./durable/maintenance.js";
