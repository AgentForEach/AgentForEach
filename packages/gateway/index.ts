/**
 * AgentForEach Gateway — Azure Functions Entry Point
 *
 * Registers all Azure Function handlers via side-effect imports.
 * The Azure Functions Node.js v4 runtime discovers functions through
 * the app.http() / app.timer() registrations in these modules.
 *
 * This mirrors the gateway pattern from @serverless-openclaw/gateway:
 *   - WebSocket lifecycle (connect, message, disconnect)
 *   - HTTP API (chat, sessions, token generation)
 */

// — Node.js v24+ polyfills (must be first import) —
import "./polyfills.js";

// — WebSocket handlers (Web PubSub CloudEvents) —
import "./handlers/ws-connect.js";
import "./handlers/ws-message.js";
import "./handlers/ws-disconnect.js";

// — HTTP API handler —
import "./handlers/api.js";
import "./handlers/durable-purge.js";
import "./account/handlers.js";

// — Cron system (Durable Functions orchestrator, activities, timers, HTTP API) —
import "./cron/orchestrator.js";
import "./cron/api.js";

// — HITL system (Durable Functions orchestrator + activities for human-in-the-loop) —
import "./hitl/orchestrator.js";

// — Delivery adapter registration (push adapter for cron → Web PubSub delivery) —
import "./websocket/push-adapter.js";

// — Channel plugins (auto-registers enabled channels + delivery adapters) —
import "./channels/index.js";

// — Channel webhook handler —
import "./handlers/channel-webhook.js";
