/**
 * AgentForEach Platform Cloudflare — Realtime provider and upgrade router
 *
 * Protocol v1 on Durable Objects:
 *
 *   - `/realtime/client`: one `UserSocket` object per user and hub holds
 *     every connection of that user. The gateway pushes to it, asks it about
 *     presence, and has it close connections. Client events go to the
 *     gateway's handler from inside the object.
 *   - `/realtime/relay`: one `Relay` object per relay hub and group holds
 *     both parties of a handoff. It has no event handler, so relay traffic
 *     never reaches gateway code.
 *
 * The Worker opens the access token (sealed with a key derived from
 * `REALTIME_SIGNING_KEY`, so a logged URL shows nothing about its user)
 * before routing the request, and hands the verified identity to the
 * object, which redeems the URL's one-time ticket and stamps the identity
 * on everything the connection sends.
 */

import {
  RELAY_RESUME_MS,
  roles,
  sealRealtimeToken,
  openRealtimeToken,
  type ClientAccess,
  type ClientAccessOptions,
  type GroupAccessOptions,
  type RealtimeProvider,
  type RealtimeRelay,
  type RealtimeTokenClaims,
} from "@agentforeach/platform";
import { CONNECTION_HEADER, type VerifiedConnection } from "./hub-host.js";

export const CLIENT_PATH = "/realtime/client";
export const RELAY_PATH = "/realtime/relay";

/** What a `UserSocket` object offers the provider over RPC. */
export interface UserSocketRpc {
  sendToUser(data: unknown): Promise<number> | number;
  isOnline(): Promise<boolean> | boolean;
  disconnect(reason?: string): Promise<number> | number;
}

/** A Durable Object namespace, as far as the provider uses it. */
export interface ObjectNamespace<T = unknown> {
  idFromName(name: string): unknown;
  get(id: never): T & { fetch(request: Request): Promise<Response> };
}

export type CloudflareRealtimeOptions = {
  userSockets: ObjectNamespace<UserSocketRpc>;
  relays: ObjectNamespace;
  /** Secret that signs access tokens (`REALTIME_SIGNING_KEY`). */
  signingKey: string;
  /** The Worker's public origin, e.g. `https://gateway.example.com`. */
  publicBaseUrl: string;
  /** Client hub name. */
  hub: string;
};

/** Durable Object name for a user's sockets on a hub. */
export const userSocketName = (hub: string, userId: string): string => `${hub}:${userId}`;
/** Durable Object name for a relay group on a hub. */
export const relayName = (hub: string, group: string): string => `${hub}:${group}`;

function socketOrigin(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  return `${url.protocol === "http:" ? "ws:" : "wss:"}//${url.host}`;
}

export class CloudflareRealtime implements RealtimeProvider {
  readonly id = "cloudflare";
  readonly capabilities = { push: true, relay: true };
  readonly relay: RealtimeRelay;

  constructor(private readonly options: CloudflareRealtimeOptions) {
    if (!options.signingKey) throw new Error("The Cloudflare realtime provider needs REALTIME_SIGNING_KEY");
    this.relay = {
      host: new URL(options.publicBaseUrl).host,
      groupAccess: async (o: GroupAccessOptions) => ({
        url: await this.url(RELAY_PATH, {
          sub: o.userId,
          hub: o.hub,
          role: [roles.joinLeaveGroup(o.group), roles.sendToGroup(o.group)],
          exp: expiry(o.ttlMinutes),
        }),
      }),
    };
  }

  async sendToUser(userId: string, data: unknown): Promise<void> {
    await this.userSocket(userId).sendToUser(data);
  }

  async isUserOnline(userId: string): Promise<boolean> {
    return this.userSocket(userId).isOnline();
  }

  async disconnectUser(userId: string, reason?: string): Promise<void> {
    await this.userSocket(userId).disconnect(reason);
  }

  async clientAccess(userId: string, options: ClientAccessOptions): Promise<ClientAccess> {
    const exp = expiry(options.ttlMinutes);
    const url = await this.url(CLIENT_PATH, {
      sub: userId,
      hub: this.options.hub,
      role: options.roles ?? [],
      ...(options.groups?.length ? { groups: options.groups } : {}),
      exp,
    });
    return { url, token: new URL(url).searchParams.get("access_token")!, expiresAtMs: exp * 1000 };
  }

  private userSocket(userId: string): UserSocketRpc {
    const ns = this.options.userSockets;
    return ns.get(ns.idFromName(userSocketName(this.options.hub, userId)) as never);
  }

  private async url(path: string, claims: Omit<RealtimeTokenClaims, "aud">): Promise<string> {
    // Each URL is a one-time ticket (jti), redeemed by the object that holds the connection.
    const token = await sealRealtimeToken(
      { ...claims, aud: path, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() },
      this.options.signingKey,
    );
    return `${socketOrigin(this.options.publicBaseUrl)}${path}?access_token=${token}`;
  }
}

const expiry = (ttlMinutes: number): number => Math.floor(Date.now() / 1000) + Math.round(ttlMinutes * 60);

export type RealtimeUpgradeOptions = { userSockets: ObjectNamespace; relays: ObjectNamespace; signingKey: string };

/**
 * Routes a request on `/realtime/client` or `/realtime/relay` to its Durable
 * Object. Undefined for any other path, so the Worker's router can fall
 * through; 401 for a bad token. Every request with a valid token reaches the
 * object, which redeems the URL's ticket before it checks that the request
 * is a protocol v1 upgrade (426 if not): a URL that has been sent anywhere,
 * and so may be in a log, is spent.
 */
export async function handleRealtimeUpgrade(request: Request, options: RealtimeUpgradeOptions): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== CLIENT_PATH && url.pathname !== RELAY_PATH) return undefined;
  const claims = await openRealtimeToken(url.searchParams.get("access_token") ?? "", options.signingKey, url.pathname);
  if (!claims?.jti) return new Response("Invalid or expired access token", { status: 401 });

  const verified: VerifiedConnection = {
    userId: claims.sub,
    roles: claims.role,
    ...(claims.groups ? { groups: claims.groups } : {}),
    // Client URLs connect once; a relay URL may reconnect shortly after it closed (a reload of the live view).
    ticket: { id: claims.jti, expMs: claims.exp * 1000, resumeMs: url.pathname === RELAY_PATH ? RELAY_RESUME_MS : 0 },
  };
  let name: string;
  let ns: ObjectNamespace;
  if (url.pathname === CLIENT_PATH) {
    name = userSocketName(claims.hub, claims.sub);
    ns = options.userSockets;
  } else {
    // A relay token grants exactly one group; its Durable Object holds that group.
    const prefix = `${roles.joinLeaveGroup()}.`;
    const groups = claims.role.filter((r) => r.startsWith(prefix)).map((r) => r.slice(prefix.length));
    if (groups.length !== 1 || !groups[0]) return new Response("A relay token names exactly one group", { status: 401 });
    name = relayName(claims.hub, groups[0]);
    ns = options.relays;
  }
  const headers = new Headers(request.headers);
  headers.set(CONNECTION_HEADER, JSON.stringify(verified));
  // The object gets the identity in a header; the token stays out of its URL (and its logs).
  const forwarded = new URL(request.url);
  forwarded.searchParams.delete("access_token");
  return ns.get(ns.idFromName(name) as never).fetch(new Request(forwarded.toString(), { method: request.method, headers }));
}
