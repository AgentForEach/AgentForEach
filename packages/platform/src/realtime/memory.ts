/**
 * AgentForEach Platform — In-memory realtime provider
 *
 * Protocol v1 without a network, for tests and local runs: the same
 * `RealtimeHub` the Cloudflare Durable Objects run, with sockets held in
 * memory. Tokens are real HS256 tokens, checked on `connect`, and each URL
 * is a one-time ticket, as on Cloudflare (./tickets.ts).
 */

import { RealtimeHub, type ConnectionState, type HubConnection, type HubEventHandler } from "./hub.js";
import { REALTIME_SUBPROTOCOL, roles } from "./protocol.js";
import { FrameQueue, type RealtimeTestClient } from "./testing.js";
import { memoryTicketStorage, RELAY_RESUME_MS, TicketLedger } from "./tickets.js";
import { sealRealtimeToken, openRealtimeToken, type RealtimeTokenClaims } from "./token.js";
import type { ClientAccess, ClientAccessOptions, GroupAccessOptions, RealtimeProvider, RealtimeRelay } from "./types.js";

export type MemoryRealtimeOptions = {
  /** Inbound events on the client hub. */
  onEvent?: HubEventHandler;
  /** Client hub name. Default "agentforeach". */
  hub?: string;
  /** The key tokens are sealed with. Default: a random one per instance. */
  secret?: string;
};

const ORIGIN = "memory://realtime.memory.invalid";
const CLIENT_PATH = "/realtime/client";
const RELAY_PATH = "/realtime/relay";

class MemoryConnection implements HubConnection {
  state: ConnectionState;
  closedWith?: { code: number; reason: string };
  /** Frames from the client are handled one at a time, in order. */
  inbox: Promise<void> = Promise.resolve();

  constructor(
    state: ConnectionState,
    private readonly deliver: (text: string) => void,
    private readonly onClose: (code: number, reason: string) => void,
  ) {
    this.state = state;
  }

  save(state: ConnectionState): void {
    this.state = state;
  }

  send(text: string): void {
    if (!this.closedWith) queueMicrotask(() => this.deliver(text));
  }

  close(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    queueMicrotask(() => this.onClose(code, reason));
  }
}

export class MemoryRealtime implements RealtimeProvider {
  readonly id = "memory";
  readonly capabilities = { push: true, relay: true };
  readonly relay: RealtimeRelay;
  private readonly secret: string;
  private readonly tickets = new TicketLedger(memoryTicketStorage());
  private readonly clientHub: string;
  private readonly onEvent?: HubEventHandler;
  /** `<path> <hub>` → hub and its sockets. */
  private readonly hubs = new Map<string, { hub: RealtimeHub; connections: Set<MemoryConnection> }>();

  constructor(options: MemoryRealtimeOptions = {}) {
    this.clientHub = options.hub ?? "agentforeach";
    this.secret = options.secret ?? crypto.randomUUID();
    this.onEvent = options.onEvent;
    this.relay = {
      host: new URL(ORIGIN).host,
      groupAccess: async (o: GroupAccessOptions) => ({
        url: await this.url(RELAY_PATH, {
          sub: o.userId,
          hub: o.hub,
          role: [roles.joinLeaveGroup(o.group), roles.sendToGroup(o.group)],
          exp: Math.floor(Date.now() / 1000) + o.ttlMinutes * 60,
        }),
      }),
    };
  }

  async sendToUser(userId: string, data: unknown): Promise<void> {
    this.hubFor(CLIENT_PATH, this.clientHub).hub.sendToUser(userId, data);
  }

  async isUserOnline(userId: string): Promise<boolean> {
    return this.hubFor(CLIENT_PATH, this.clientHub).hub.isUserOnline(userId);
  }

  async disconnectUser(userId: string, reason?: string): Promise<void> {
    this.hubFor(CLIENT_PATH, this.clientHub).hub.disconnectUser(userId, reason);
  }

  async clientAccess(userId: string, options: ClientAccessOptions): Promise<ClientAccess> {
    const exp = Math.floor(Date.now() / 1000) + options.ttlMinutes * 60;
    const url = await this.url(CLIENT_PATH, { sub: userId, hub: this.clientHub, role: options.roles ?? [], groups: options.groups, exp });
    return { url, token: new URL(url).searchParams.get("access_token")!, expiresAtMs: exp * 1000 };
  }

  /** Opens a connection to a URL from `clientAccess` or `relay.groupAccess`, as a WebSocket client would. */
  async connect(url: string, protocol: string = REALTIME_SUBPROTOCOL): Promise<RealtimeTestClient> {
    const parsed = new URL(url);
    if (protocol !== REALTIME_SUBPROTOCOL) throw new Error(`Unsupported subprotocol ${protocol}`);
    const claims = await openRealtimeToken(parsed.searchParams.get("access_token") ?? "", this.secret, parsed.pathname);
    if (!claims?.jti) throw new Error("401: invalid or expired access token");

    const { hub, connections } = this.hubFor(parsed.pathname, claims.hub);
    const ticket = claims.jti;
    const resumeMs = parsed.pathname === RELAY_PATH ? RELAY_RESUME_MS : 0;
    const isOpen = (id: string) => [...connections].some((c) => c.state.ticket === id && !c.closedWith);
    if (!(await this.tickets.redeem(ticket, claims.exp * 1000, resumeMs, isOpen))) {
      throw new Error("401: this connection URL has already been used");
    }
    const queue = new FrameQueue();
    let resolveClosed!: (value: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));
    const connection = new MemoryConnection(
      { ...RealtimeHub.initialState(claims.sub, crypto.randomUUID().replace(/-/g, ""), claims.role, claims.groups), ticket },
      (text) => queue.push(text),
      (code, reason) => {
        connections.delete(connection);
        void this.tickets.closed(ticket);
        resolveClosed({ code, reason });
      },
    );
    connections.add(connection);
    hub.open(connection);

    return {
      send: (frame) => {
        const text = typeof frame === "string" ? frame : JSON.stringify(frame);
        connection.inbox = connection.inbox.then(() => (connection.closedWith ? undefined : hub.receive(connection, text)));
      },
      next: (match, timeoutMs) => queue.next(match, timeoutMs),
      collect: (ms, match) => queue.collect(ms, match),
      closed,
      close: () => connection.close(1000, ""),
    };
  }

  private async url(path: string, claims: Omit<RealtimeTokenClaims, "aud">): Promise<string> {
    const token = await sealRealtimeToken({ ...claims, aud: path, jti: crypto.randomUUID() }, this.secret);
    return `${ORIGIN}${path}?access_token=${token}`;
  }

  private hubFor(path: string, name: string): { hub: RealtimeHub; connections: Set<MemoryConnection> } {
    const key = `${path} ${name}`;
    let entry = this.hubs.get(key);
    if (!entry) {
      const connections = new Set<MemoryConnection>();
      const hub = new RealtimeHub({ connections: () => connections, onEvent: path === CLIENT_PATH ? this.onEvent : undefined });
      entry = { hub, connections };
      this.hubs.set(key, entry);
    }
    return entry;
  }
}
