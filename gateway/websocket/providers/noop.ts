/**
 * AgentForEach WebSocket Provider — No-Op (Development / Testing)
 *
 * A silent no-op implementation of the WebSocketProvider interface.
 * Used when Web PubSub isn't configured (local dev, unit tests, CI)
 * or when real-time push is intentionally disabled.
 *
 * All methods succeed immediately without side effects.
 * Token generation returns a dummy token that can't connect anywhere.
 */

import type {
  WebSocketProvider,
  WebSocketProviderConfig,
  Frame,
  ClientAccessToken,
  TokenGenerationOptions,
} from "../types.js";

// ============================================================================
// No-Op Provider
// ============================================================================

export class NoopWebSocketProvider implements WebSocketProvider {
  readonly id = "noop" as const;
  readonly label = "No-Op (disabled)";
  readonly capabilities = { push: false, relay: false };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config?: WebSocketProviderConfig) {
    // Nothing to initialise — intentionally empty.
  }

  // -- Push Operations (silent no-ops) --

  async sendToUser(_userId: string, _frame: Frame): Promise<void> {}
  async sendToGroup(_group: string, _frame: Frame): Promise<void> {}
  async sendToAll(_frame: Frame): Promise<void> {}

  // -- Group Management (silent no-ops) --

  async addUserToGroup(_userId: string, _group: string): Promise<void> {}
  async removeUserFromGroup(_userId: string, _group: string): Promise<void> {}

  // -- Connection Management --

  async isUserOnline(_userId: string): Promise<boolean> {
    return false; // No real connections in noop mode.
  }

  async disconnectUser(_userId: string, _reason?: string): Promise<void> {}

  // -- Token Generation (dummy token) --

  async clientAccess(
    userId: string,
    options: TokenGenerationOptions,
  ): Promise<ClientAccessToken> {
    return {
      url: `wss://noop.local/ws?userId=${encodeURIComponent(userId)}`,
      token: "noop-token",
      expiresAtMs: Date.now() + options.ttlMinutes * 60 * 1000,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createNoopProvider(
  config?: WebSocketProviderConfig,
): NoopWebSocketProvider {
  return new NoopWebSocketProvider(config);
}
