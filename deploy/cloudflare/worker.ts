/**
 * AgentForEach on Cloudflare Workers: the entry point (wrangler.jsonc `main`).
 *
 * It serves the gateway's route and schedule table with the Worker host
 * (@agentforeach/platform-cloudflare), plus one schedule only hosts without
 * a long-lived process need: deleting expired database rows, which a
 * Postgres adapter otherwise does on a timer. It also exports the Durable
 * Object classes the platform pack runs on, each bound in wrangler.jsonc:
 * - DurableInstance: one per durable job, wait or alarm (chat turns, HITL
 *   waits, cron runs), driven by its alarm;
 * - UserSocket and Relay: realtime protocol v1 (a user's sockets, and the
 *   browser live view's relay groups);
 * - ContainerSandbox: one per sandbox, running its container (and
 *   SandboxEgress, the entrypoint its outbound traffic goes through).
 */

// First: config and host, before any gateway module loads.
import "./setup.js";

import { env } from "cloudflare:workers";
import {
  CLOUDFLARE_CONTAINERS_PROVIDER,
  CloudflareContainersSandbox,
  CloudflareDurable,
  createWorkerHandler,
  handleRealtimeUpgrade,
  namespaceResolver,
  type ObjectNamespace,
  type UserSocketRpc,
} from "@agentforeach/platform-cloudflare";
import { defineDurableInstance } from "@agentforeach/platform-cloudflare/durable/objects";
import { defineUserSocket, Relay } from "@agentforeach/platform-cloudflare/realtime/objects";
import { ContainerSandbox, SandboxEgress } from "@agentforeach/platform-cloudflare/sandbox/objects";
import { buildRouteTable } from "../../gateway/routes.js";
import { databaseSweepSchedule } from "../../gateway/database/catalog.js";
import { workflows } from "../../gateway/workflows.js";
import { installDurable } from "../../gateway/runtime/durable.js";
import { installDatabaseUrlSource } from "../../gateway/database/config.js";
import { realtimeClientEvents } from "../../gateway/handlers/client-events.js";
import { installCloudflareRealtime } from "../../gateway/websocket/providers/cloudflare.js";
import { containersSandboxOptions, registerSandboxProvider } from "../../gateway/skills/sandbox/index.js";

/** The Worker's bindings (wrangler.jsonc). */
export interface Env {
  /** Hyperdrive in front of the deployment's Postgres. */
  HYPERDRIVE?: { connectionString: string };
  DURABLE_INSTANCES: DurableObjectNamespace;
  REALTIME_USER_SOCKET: ObjectNamespace<UserSocketRpc>;
  REALTIME_RELAY: ObjectNamespace;
  /** A secret: signs realtime connection tokens. */
  REALTIME_SIGNING_KEY: string;
  SANDBOX: DurableObjectNamespace<ContainerSandbox>;
  /** Optional secrets: with both, sandbox snapshots are deleted from the registry when superseded or erased. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_IMAGES_API_TOKEN?: string;
}

const bindings = env as unknown as Env;

// The database is reached through Hyperdrive. Installed here, for every handler (a Durable
// Object's alarm can run in an isolate that has served no fetch); read when the database
// config loads, inside a handler, since global scope can't read the binding.
installDatabaseUrlSource(() => bindings.HYPERDRIVE?.connectionString);

// Durable work: a Durable Object per instance, named by its id.
export const DurableInstance = defineDurableInstance<Env>(workflows);
installDurable(new CloudflareDurable(namespaceResolver(() => bindings.DURABLE_INSTANCES)));

// Realtime: the client and relay sockets live in Durable Objects; client events run the gateway's handler.
export const UserSocket = defineUserSocket<Env>({ onEvent: (_env, ctx) => realtimeClientEvents((work) => ctx.waitUntil(work)) });
export { Relay };
const realtime = () => ({
  userSockets: bindings.REALTIME_USER_SOCKET,
  relays: bindings.REALTIME_RELAY,
  signingKey: bindings.REALTIME_SIGNING_KEY,
});
installCloudflareRealtime(realtime());

// Sandboxes: a Durable Object per sandbox running its container (skills.sandbox.provider
// "cloudflare-containers", set by SANDBOX_PROVIDER in wrangler.jsonc). Without the snapshot
// deletion secrets, snapshots expire after 30 days unused.
export { ContainerSandbox, SandboxEgress };
registerSandboxProvider(CLOUDFLARE_CONTAINERS_PROVIDER, (config) => {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_IMAGES_API_TOKEN: apiToken } = bindings;
  return new CloudflareContainersSandbox(bindings.SANDBOX, {
    ...containersSandboxOptions(config),
    snapshotDeletion: accountId && apiToken ? { accountId, apiToken } : undefined,
  });
});

export default createWorkerHandler<Env>({
  table: () => {
    const table = buildRouteTable();
    return { routes: table.routes, schedules: [...table.schedules, databaseSweepSchedule] };
  },
  // The realtime WebSocket upgrades (/realtime/client, /realtime/relay) are outside the route table;
  // their token is the auth, so no CORS or route handling applies.
  intercept: (request) => handleRealtimeUpgrade(request, realtime()),
});
