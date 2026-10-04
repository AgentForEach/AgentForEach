/**
 * AgentForEach Platform — Realtime port
 *
 * How the gateway reaches connected clients, on any cloud. Clients speak
 * realtime protocol v1 (`./protocol.ts`) to whatever service the provider
 * runs; the gateway only uses this interface.
 *
 *   - Push: `sendToUser` delivers a JSON payload to every connection of a
 *     user as `{ type: "message", from: "server", dataType: "json", data }`.
 *   - Access: `clientAccess` returns the URL a client opens (the token is in
 *     its query string).
 *   - Relay (optional): one-group tokens on a separate hub with no event
 *     handler, for two parties the gateway introduces (the browser live
 *     view). The service stamps `fromUserId` from the sender's token.
 *
 * Inbound client events go to one transport-neutral handler in the gateway;
 * how they arrive (an upstream webhook, a Durable Object) is the provider's
 * business.
 */

export type RealtimeCapabilities = {
  /** Pushes reach clients. False for the no-op provider. */
  push: boolean;
  /** `relay` is available. */
  relay: boolean;
};

export type ClientAccessOptions = {
  ttlMinutes: number;
  /** Groups the connection starts in. */
  groups?: string[];
  /** Web PubSub role strings granted to the connection. */
  roles?: string[];
};

export type ClientAccess = {
  /** WebSocket URL including the access token. */
  url: string;
  token: string;
  expiresAtMs: number;
};

export type GroupAccessOptions = {
  /** The relay hub; connections on different hubs never meet. */
  hub: string;
  userId: string;
  /** The one group the token may join and send to. */
  group: string;
  ttlMinutes: number;
};

export interface RealtimeRelay {
  /** The host clients connect to, for egress allowlists and CSP `connect-src`. */
  readonly host: string;
  /** A URL whose token can only join `group` and send to it. */
  groupAccess(options: GroupAccessOptions): Promise<{ url: string }>;
}

export interface RealtimeProvider {
  /** Provider id: `azure-webpubsub`, `cloudflare`, `memory`, `noop`. */
  readonly id: string;
  readonly capabilities: RealtimeCapabilities;
  /** Delivers `data` to every connection of `userId`. */
  sendToUser(userId: string, data: unknown): Promise<void>;
  isUserOnline(userId: string): Promise<boolean>;
  /** Tells each of the user's connections why, then closes it. */
  disconnectUser(userId: string, reason?: string): Promise<void>;
  clientAccess(userId: string, options: ClientAccessOptions): Promise<ClientAccess>;
  /** Present when `capabilities.relay` is true. */
  readonly relay?: RealtimeRelay;
}
