/**
 * AgentForEach Platform Cloudflare — Realtime Durable Objects
 *
 * The two Durable Object classes behind protocol v1 on Cloudflare. Both
 * accept sockets with the hibernation API and run the shared `RealtimeHub`
 * (through `HubHost`), so an idle connection costs no duration.
 *
 *   - `defineUserSocket({ onEvent })` builds the client hub's class: one
 *     object per user and hub, with RPC for pushes, presence and
 *     disconnects, and client events handed to `onEvent` (the gateway's
 *     handler, wired by the Worker entry).
 *   - `Relay` is the relay hub's class: one object per handoff group, no
 *     event handler.
 *
 * The Worker entry exports them under the binding names in wrangler.jsonc
 * (`REALTIME_USER_SOCKET` → `UserSocket`, `REALTIME_RELAY` → `Relay`).
 */

import { DurableObject } from "cloudflare:workers";
import { TicketLedger, type HubEventHandler, type TicketStorage } from "@agentforeach/platform";
import { CONNECTION_HEADER, HubHost, upgradeHeaders, upgradeProblem, type HibernatableSocket, type SocketState, type VerifiedConnection } from "./hub-host.js";
import type { UserSocketRpc } from "./provider.js";

/**
 * Builds a client event handler with the object's environment and context
 * (`waitUntil` keeps the handler's background work alive).
 */
export type UserSocketEventHandler<Env> = (env: Env, ctx: { waitUntil(work: Promise<unknown>): void }) => HubEventHandler;

abstract class HubObject<Env> extends DurableObject<Env> {
  protected abstract readonly host: HubHost;
  private ledger?: TicketLedger;

  private tickets(): TicketLedger {
    this.ledger ??= new TicketLedger(this.ctx.storage as unknown as TicketStorage);
    return this.ledger;
  }

  /** The Worker forwards only verified upgrades here (handleRealtimeUpgrade). */
  async fetch(request: Request): Promise<Response> {
    const header = request.headers.get(CONNECTION_HEADER);
    if (!header) return new Response("Not found", { status: 404 });
    const verified = JSON.parse(header) as VerifiedConnection;
    // Each URL connects once (a relay URL may reconnect right after it closed). Redeemed before
    // anything else is checked, so a URL refused below is spent as well.
    const ticket = verified.ticket;
    if (!ticket || !(await this.tickets().redeem(ticket.id, ticket.expMs, ticket.resumeMs, (id) => this.host.ticketOpen(id)))) {
      return new Response("This connection URL has already been used", { status: 401 });
    }
    const problem = upgradeProblem(request.headers);
    // Spent for good: real clients always send a protocol v1 upgrade.
    if (problem) return new Response(problem, { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.host.accept(server as unknown as HibernatableSocket, verified);
    return new Response(null, { status: 101, webSocket: client, headers: upgradeHeaders() });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.host.message(ws as unknown as HibernatableSocket, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const socket = ws as unknown as HibernatableSocket;
    const ticket = HubHost.ticketOf(socket);
    this.host.closed(socket, code, reason);
    if (ticket) await this.tickets().closed(ticket);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const ticket = HubHost.ticketOf(ws as unknown as HibernatableSocket);
    if (ticket) await this.tickets().closed(ticket);
  }

  protected socketState(): SocketState {
    return this.ctx as unknown as SocketState;
  }
}

/** A Durable Object class for the client hub. */
export type UserSocketClass<Env> = new (ctx: DurableObjectState, env: Env) => DurableObject<Env> &
  UserSocketRpc & {
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void>;
    webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void>;
  };

/** The client hub's Durable Object class, with client events going to `onEvent`. */
export function defineUserSocket<Env = unknown>(options: { onEvent?: UserSocketEventHandler<Env> } = {}): UserSocketClass<Env> {
  return class UserSocket extends HubObject<Env> implements UserSocketRpc {
    protected readonly host: HubHost;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.host = new HubHost(this.socketState(), options.onEvent?.(env, ctx));
    }

    /** Delivers `data` to every connection; returns how many got it. */
    sendToUser(data: unknown): number {
      return this.host.hub.sendToUser(this.userId() ?? "", data);
    }

    isOnline(): boolean {
      const userId = this.userId();
      return userId !== undefined && this.host.hub.isUserOnline(userId);
    }

    disconnect(reason?: string): number {
      const userId = this.userId();
      return userId === undefined ? 0 : this.host.hub.disconnectUser(userId, reason);
    }

    /** Every socket here belongs to one user; it's in the socket's tags. */
    private userId(): string | undefined {
      const [ws] = this.ctx.getWebSockets();
      return ws ? this.ctx.getTags(ws)[0] : undefined;
    }
  };
}

/** The relay hub's Durable Object class: group messages only, never the gateway. */
export class Relay<Env = unknown> extends HubObject<Env> {
  protected readonly host: HubHost;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = new HubHost(this.socketState());
  }
}
