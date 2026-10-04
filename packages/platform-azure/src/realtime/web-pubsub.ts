/**
 * AgentForEach Platform Azure — Azure Web PubSub realtime provider
 *
 * The realtime port on Azure Web PubSub, which speaks protocol v1 natively
 * (it is the `json.webpubsub.azure.v1` subprotocol). Moved from the
 * gateway's websocket providers with the same calls:
 *
 *   - pushes: `sendToUser`, plus the group and broadcast operations the
 *     gateway's emitter still exposes;
 *   - presence and disconnect: `userExists`, `closeUserConnections`;
 *   - client tokens: `getClientAccessToken` with the caller's groups and roles;
 *   - relay: a client on the relay hub issues tokens that can only join and
 *     send to one group. That hub has no event handlers, so relay traffic
 *     never reaches the gateway.
 */

import { WebPubSubServiceClient } from "@azure/web-pubsub";
import { roles, type ClientAccess, type ClientAccessOptions, type GroupAccessOptions, type RealtimeProvider, type RealtimeRelay } from "@agentforeach/platform";

export type WebPubSubRealtimeOptions = {
  /** `Endpoint=https://<name>.webpubsub.azure.com;AccessKey=...;Version=1.0;` */
  connectionString: string;
  /** The client hub. */
  hub: string;
};

/** The service's host, from its connection string; undefined when there is none. */
export function webPubSubHost(connectionString: string): string | undefined {
  const endpoint = /(?:^|;)\s*Endpoint=([^;]+)/i.exec(connectionString)?.[1];
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint.trim()).hostname;
  } catch {
    return undefined;
  }
}

/** One-group relay tokens on any hub of the service. */
export function webPubSubRelay(connectionString: string): RealtimeRelay | undefined {
  const host = webPubSubHost(connectionString);
  if (!host) return undefined;
  return {
    host,
    async groupAccess(o: GroupAccessOptions) {
      const client = new WebPubSubServiceClient(connectionString, o.hub);
      const token = await client.getClientAccessToken({
        userId: o.userId,
        roles: [roles.joinLeaveGroup(o.group), roles.sendToGroup(o.group)],
        expirationTimeInMinutes: o.ttlMinutes,
      });
      return { url: token.url };
    },
  };
}

export class WebPubSubRealtime implements RealtimeProvider {
  readonly id = "azure-webpubsub";
  readonly label = "Azure Web PubSub";
  readonly capabilities: RealtimeProvider["capabilities"];
  readonly relay?: RealtimeRelay;
  private readonly client: WebPubSubServiceClient;

  constructor(options: WebPubSubRealtimeOptions) {
    if (!options.connectionString) {
      throw new Error(
        "Azure Web PubSub provider requires a connection string. " +
          "Set WEBPUBSUB_CONNECTION_STRING env var or configure in agentforeach.json.",
      );
    }
    this.client = new WebPubSubServiceClient(options.connectionString, options.hub);
    this.relay = webPubSubRelay(options.connectionString);
    this.capabilities = { push: true, relay: !!this.relay };
  }

  async sendToUser(userId: string, data: unknown): Promise<void> {
    await this.client.sendToUser(userId, data as Record<string, unknown>);
  }

  async sendToGroup(group: string, data: unknown): Promise<void> {
    await this.client.group(group).sendToAll(data as Record<string, unknown>);
  }

  async sendToAll(data: unknown): Promise<void> {
    await this.client.sendToAll(data as Record<string, unknown>);
  }

  async addUserToGroup(userId: string, group: string): Promise<void> {
    await this.client.group(group).addUser(userId);
  }

  async removeUserFromGroup(userId: string, group: string): Promise<void> {
    await this.client.group(group).removeUser(userId);
  }

  async isUserOnline(userId: string): Promise<boolean> {
    return this.client.userExists(userId);
  }

  async disconnectUser(userId: string, reason?: string): Promise<void> {
    await this.client.closeUserConnections(userId, { reason });
  }

  async clientAccess(userId: string, options: ClientAccessOptions): Promise<ClientAccess> {
    const token = await this.client.getClientAccessToken({
      userId,
      expirationTimeInMinutes: options.ttlMinutes,
      groups: options.groups,
      roles: options.roles,
    });
    return { url: token.url, token: token.token, expiresAtMs: Date.now() + options.ttlMinutes * 60 * 1000 };
  }
}
