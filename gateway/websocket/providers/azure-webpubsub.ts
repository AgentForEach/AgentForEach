/**
 * AgentForEach WebSocket Provider — Azure Web PubSub
 *
 * Implements the WebSocketProvider interface using Azure Web PubSub.
 * This is the primary provider for production Azure deployments.
 *
 * Azure Web PubSub is a managed WebSocket service that handles:
 *   - Connection management (connect/disconnect lifecycle)
 *   - User-level targeting (sendToUser)
 *   - Group-based pub/sub (sendToGroup)
 *   - Client access token generation
 *
 * The provider caches the WebPubSubServiceClient instance for reuse
 * across Azure Function invocations within the same process.
 */

import { WebPubSubServiceClient } from "@azure/web-pubsub";
import type {
  WebSocketProvider,
  WebSocketProviderConfig,
  Frame,
  ClientAccessToken,
  TokenGenerationOptions,
} from "../types.js";

// ============================================================================
// JSON Helper
// ============================================================================

type JSONRecord = Record<string, unknown>;

function toJSON(frame: Frame): JSONRecord {
  return frame as unknown as JSONRecord;
}

// ============================================================================
// Azure Web PubSub Provider
// ============================================================================

export class AzureWebPubSubProvider implements WebSocketProvider {
  readonly id = "azure-webpubsub" as const;
  readonly label = "Azure Web PubSub";

  private client: WebPubSubServiceClient;

  constructor(config: WebSocketProviderConfig) {
    if (!config.connectionString) {
      throw new Error(
        "Azure Web PubSub provider requires a connection string. " +
          "Set WEBPUBSUB_CONNECTION_STRING env var or configure in agentforeach.json.",
      );
    }
    this.client = new WebPubSubServiceClient(
      config.connectionString,
      config.hub,
    );
  }

  // -- Push Operations --

  async sendToUser(userId: string, frame: Frame): Promise<void> {
    await this.client.sendToUser(userId, toJSON(frame));
  }

  async sendToGroup(group: string, frame: Frame): Promise<void> {
    const groupClient = this.client.group(group);
    await groupClient.sendToAll(toJSON(frame));
  }

  async sendToAll(frame: Frame): Promise<void> {
    await this.client.sendToAll(toJSON(frame));
  }

  // -- Group Management --

  async addUserToGroup(userId: string, group: string): Promise<void> {
    const groupClient = this.client.group(group);
    await groupClient.addUser(userId);
  }

  async removeUserFromGroup(userId: string, group: string): Promise<void> {
    const groupClient = this.client.group(group);
    await groupClient.removeUser(userId);
  }

  // -- Connection Management --

  async isUserOnline(userId: string): Promise<boolean> {
    return this.client.userExists(userId);
  }

  async disconnectUser(userId: string, reason?: string): Promise<void> {
    await this.client.closeUserConnections(userId, { reason });
  }

  // -- Token Generation --

  async generateToken(
    userId: string,
    options: TokenGenerationOptions,
  ): Promise<ClientAccessToken> {
    const tokenResponse = await this.client.getClientAccessToken({
      userId,
      expirationTimeInMinutes: options.ttlMinutes,
      groups: options.groups,
      roles: options.roles,
    });

    return {
      url: tokenResponse.url,
      token: tokenResponse.token,
      expiresAtMs: Date.now() + options.ttlMinutes * 60 * 1000,
    };
  }

  /**
   * Get the underlying WebPubSubServiceClient for advanced operations
   * not covered by the WebSocketProvider interface.
   */
  getServiceClient(): WebPubSubServiceClient {
    return this.client;
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createAzureWebPubSubProvider(
  config: WebSocketProviderConfig,
): AzureWebPubSubProvider {
  return new AzureWebPubSubProvider(config);
}
