/**
 * AgentForEach Gateway — Azure Functions Entry Point
 *
 * Loads every module (some register delivery adapters or channel plugins
 * when they load), registers the gateway's durable work (workflows.ts) as
 * Durable Functions orchestrations, then hands the route and schedule table
 * (routes.ts) to the Azure host, which registers each entry with app.http()
 * / app.timer().
 */

// — Node.js v24+ polyfills (must be first import) —
import "./polyfills.js";

// — safeFetch connects with undici, checking the address each socket uses —
import "./utils/safe-fetch-node.js";

// — WebSocket handlers (Web PubSub CloudEvents) —
import "./handlers/ws-connect.js";
import "./handlers/ws-message.js";
import "./handlers/ws-disconnect.js";

// — HTTP API handler —
import "./handlers/api.js";
import "./handlers/browser-view.js";
import "./account/handlers.js";

// — Cron system (scheduler alarm, runs, health check, HTTP API) —
import "./cron/orchestrator.js";
import "./cron/api.js";

// — HITL system (the durable wait for a user's answer) —
import "./hitl/orchestrator.js";

// — Delivery adapter registration (push adapter for cron → Web PubSub delivery) —
import "./websocket/push-adapter.js";

// — Channel plugins (auto-registers enabled channels + delivery adapters) —
import "./channels/index.js";

// — Channel webhook handler —
import "./handlers/channel-webhook.js";

// — Object storage on Azure Blob Storage, built when a store is opened —
import {
  AzureBlobObjectStore,
  registerDurable,
  registerFunctions,
  registerLegacyOrchestrations,
  withDurableMaintenance,
} from "@agentforeach/platform-azure";
import { installAzureBlob } from "./objects/index.js";

installAzureBlob((storage, container, options) => new AzureBlobObjectStore(storage, container, options));

// — Durable work on Durable Functions (plus last release's orchestrations, so in-flight ones finish) —
import { workflows } from "./workflows.js";
import { installDurable } from "./runtime/durable.js";

installDurable(registerDurable(workflows));
registerLegacyOrchestrations(workflows);

// — Serve the route and schedule table on Azure Functions —
import { buildRouteTable } from "./routes.js";

registerFunctions(withDurableMaintenance(buildRouteTable()));
