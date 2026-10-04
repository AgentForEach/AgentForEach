/**
 * AgentForEach WebSocket Provider — Cloudflare Durable Objects
 *
 * Registers the "cloudflare" provider (protocol v1 on the UserSocket and
 * Relay Durable Objects of @agentforeach/platform-cloudflare). The Worker
 * entry calls this with its bindings; the Azure entry never imports it.
 *
 *   installCloudflareRealtime({
 *     userSockets: env.REALTIME_USER_SOCKET,
 *     relays: env.REALTIME_RELAY,
 *     signingKey: env.REALTIME_SIGNING_KEY,
 *   });
 *
 * Select it with WEBSOCKET_PROVIDER=cloudflare (or websocket.provider).
 */

import { CloudflareRealtime, RELAY_PATH, type CloudflareRealtimeOptions } from "@agentforeach/platform-cloudflare";
import { hostInfo } from "../../runtime/host.js";
import { resolveHub } from "../config.js";
import { registerWebSocketProvider } from "./index.js";

export type InstallCloudflareRealtimeOptions = Omit<CloudflareRealtimeOptions, "publicBaseUrl" | "hub"> & {
  /** Default: the host's public base URL. */
  publicBaseUrl?: string;
  /** Default: the configured hub. */
  hub?: string;
};

export function installCloudflareRealtime(options: InstallCloudflareRealtimeOptions): void {
  const publicBaseUrl = (): string => {
    const url = options.publicBaseUrl ?? hostInfo().publicBaseUrl;
    if (!url) throw new Error("The Cloudflare realtime provider needs the host's public base URL");
    return url;
  };
  registerWebSocketProvider(
    "cloudflare",
    () => new CloudflareRealtime({ ...options, publicBaseUrl: publicBaseUrl(), hub: options.hub ?? resolveHub() }),
    {
      capabilities: () => ({ push: true, relay: true }),
      relayHost: () => {
        const url = options.publicBaseUrl ?? hostInfo().publicBaseUrl;
        return url ? new URL(url).host : undefined;
      },
      // The relay shares the Worker's host with every gateway route.
      relayPath: () => RELAY_PATH,
      // Client events run in the UserSocket object, so the Web PubSub webhooks aren't served.
      upstreamWebhooks: false,
    },
  );
}
