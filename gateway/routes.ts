/**
 * AgentForEach Gateway — Route and schedule table
 *
 * Every HTTP route and recurring schedule the gateway serves, as data. Each
 * platform's entry point hands this table to its host (Azure Functions,
 * a Cloudflare Worker, ...), which serves it.
 */

import type { RouteDef, ScheduleDef } from "@agentforeach/platform";
import { routes as wsConnectRoutes } from "./handlers/ws-connect.js";
import { routes as wsMessageRoutes } from "./handlers/ws-message.js";
import { routes as wsDisconnectRoutes } from "./handlers/ws-disconnect.js";
import { routes as apiRoutes } from "./handlers/api.js";
import { routes as browserViewRoutes } from "./handlers/browser-view.js";
import { routes as accountRoutes } from "./account/handlers.js";
import { schedules as cronSchedulerSchedules } from "./cron/orchestrator.js";
import { routes as cronApiRoutes } from "./cron/api.js";
import { routes as channelWebhookRoutes } from "./handlers/channel-webhook.js";
import { isCronApiEnabled } from "./cron/config.js";
import { realtimeUpstreamWebhooks } from "./websocket/providers/index.js";

export interface RouteTable {
  routes: RouteDef[];
  schedules: ScheduleDef[];
}

/**
 * Build the table from the current configuration: the cron API can be turned
 * off, and the ws/* webhooks are served only for a realtime provider that
 * sends them (Azure Web PubSub's upstream; elsewhere they'd only be a way in).
 */
export function buildRouteTable(): RouteTable {
  // negotiate lives beside the webhooks but serves every provider.
  const webhooks = realtimeUpstreamWebhooks();
  const realtimeRoutes = [...wsConnectRoutes, ...wsMessageRoutes, ...wsDisconnectRoutes].filter(
    (r) => webhooks || !r.route.startsWith("ws/"),
  );
  return {
    routes: [
      ...realtimeRoutes,
      ...apiRoutes,
      ...browserViewRoutes,
      ...accountRoutes,
      ...(isCronApiEnabled() ? cronApiRoutes : []),
      ...channelWebhookRoutes,
    ],
    schedules: [...cronSchedulerSchedules],
  };
}
