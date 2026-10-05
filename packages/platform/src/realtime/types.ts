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
 *
 * A provider whose clients speak another protocol (AWS AppSync Events) says
 * so in `capabilities.protocol` and returns a `descriptor` with each access:
 * everything the portable client (`./client/`) needs to connect. Its URL
 * stays set, for egress allowlists and the live view's CSP.
 */

/** What clients speak: protocol v1 (`./protocol.ts`), or AWS AppSync Events. */
export type RealtimeProtocol = "v1" | "appsync-events";

/**
 * What a provider can do. The optional fields default to protocol v1's
 * (read them through `resolveRealtimeCapabilities`, never one by one).
 */
export type RealtimeCapabilities = {
  /** Pushes reach clients. False for the no-op provider. */
  push: boolean;
  /** `relay` is available. */
  relay: boolean;
  /** What clients speak. Default "v1"; any other protocol returns a `descriptor` with each access. */
  protocol?: RealtimeProtocol;
  /**
   * How client events reach the gateway: over the client's socket
   * ("websocket", the default), or only through the HTTP API ("http": the
   * socket only receives).
   */
  inbound?: "websocket" | "http";
  /** `isUserOnline` answers. Default true; false: it throws. */
  presence?: boolean;
  /** `disconnectUser` closes a user's connections. Default true; false: it throws. */
  disconnect?: boolean;
};

/** The capabilities with every optional field filled in. */
export type ResolvedRealtimeCapabilities = Required<RealtimeCapabilities>;

/** Authorization an AppSync Events client sends on connect and with each subscribe or publish. */
export type AppSyncAuthorization = { host: string; Authorization: string };

/**
 * How a client connects, for the portable client. Protocol v1 needs only the
 * URL (its token is in the query string), so v1 providers don't return one;
 * a client builds `{ protocol: "v1", url }` itself.
 */
export type ConnectionDescriptor =
  | { protocol: "v1"; url: string; expiresAtMs?: number }
  | {
      protocol: "appsync-events";
      /** The realtime endpoint, `wss://<domain>/event/realtime`. */
      url: string;
      authorization: AppSyncAuthorization;
      /** The channels the connection subscribes to, each confirmed before it counts as connected. */
      channels: string[];
      /** A relay connection's one publish channel: its peer's. Absent on client connections, which only receive. */
      publish?: string;
      expiresAtMs: number;
    };

export type ClientAccessOptions = {
  ttlMinutes: number;
  /** Groups the connection starts in. */
  groups?: string[];
  /** Web PubSub role strings granted to the connection. */
  roles?: string[];
};

export type ClientAccess = {
  /** WebSocket URL including the access token (protocol v1), or the service's endpoint. */
  url: string;
  token: string;
  expiresAtMs: number;
  /** Set by providers whose protocol isn't v1. */
  descriptor?: ConnectionDescriptor;
};

export type GroupAccessOptions = {
  /** The relay hub; connections on different hubs never meet. */
  hub: string;
  userId: string;
  /** The one group the token may join and send to. */
  group: string;
  ttlMinutes: number;
  /**
   * The other party's user id. Providers that bind a relay connection to
   * its two parties (AppSync: one channel each) need it; v1 providers
   * ignore it, as their service stamps the sender.
   */
  peerUserId?: string;
};

export type GroupAccess = {
  url: string;
  /** Set by providers whose protocol isn't v1. */
  descriptor?: ConnectionDescriptor;
};

export interface RealtimeRelay {
  /** The host clients connect to, for egress allowlists and CSP `connect-src`. */
  readonly host: string;
  /** A URL whose token can only join `group` and send to it. */
  groupAccess(options: GroupAccessOptions): Promise<GroupAccess>;
}

export interface RealtimeProvider {
  /** Provider id: `azure-webpubsub`, `cloudflare`, `aws-appsync-events`, `memory`, `noop`. */
  readonly id: string;
  readonly capabilities: RealtimeCapabilities;
  /** Delivers `data` to every connection of `userId`. */
  sendToUser(userId: string, data: unknown): Promise<void>;
  /** Throws when `capabilities.presence` is false. */
  isUserOnline(userId: string): Promise<boolean>;
  /** Tells each of the user's connections why, then closes it. Throws when `capabilities.disconnect` is false. */
  disconnectUser(userId: string, reason?: string): Promise<void>;
  clientAccess(userId: string, options: ClientAccessOptions): Promise<ClientAccess>;
  /** Present when `capabilities.relay` is true. */
  readonly relay?: RealtimeRelay;
}

/** `capabilities` with the protocol v1 defaults filled in: the one place they are read. */
export function resolveRealtimeCapabilities(capabilities: RealtimeCapabilities): ResolvedRealtimeCapabilities {
  return {
    push: capabilities.push,
    relay: capabilities.relay,
    protocol: capabilities.protocol ?? "v1",
    inbound: capabilities.inbound ?? "websocket",
    presence: capabilities.presence ?? true,
    disconnect: capabilities.disconnect ?? true,
  };
}
