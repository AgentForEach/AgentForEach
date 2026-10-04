/**
 * AgentForEach Platform Cloudflare — Realtime hub host
 *
 * Runs protocol v1's `RealtimeHub` over the WebSockets a Durable Object
 * holds with the hibernation API. Each socket's protocol state lives in its
 * attachment (`serializeAttachment`), so a Durable Object that hibernates
 * between frames loses nothing. Kept free of `cloudflare:workers` so it is
 * testable in Node with fake sockets.
 */

import { RealtimeHub, REALTIME_SUBPROTOCOL, type ConnectionState, type HubConnection, type HubEventHandler } from "@agentforeach/platform";

/** The parts of a hibernatable WebSocket the hub needs. */
export interface HibernatableSocket {
  /** 1 while open; closing sockets linger in getWebSockets() until the handshake ends. */
  readonly readyState?: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The parts of `DurableObjectState` the hub needs. */
export interface SocketState {
  acceptWebSocket(ws: never, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableSocket[];
}

/** Header the Worker uses to hand a verified connection to its Durable Object. */
export const CONNECTION_HEADER = "x-agentforeach-realtime-connection";

/** What the Worker verified about a connection, passed to the Durable Object. */
export type VerifiedConnection = {
  userId: string;
  roles: string[];
  groups?: string[];
  /** The URL's one-time ticket: the token's jti, its expiry, and how long it may reconnect after closing. */
  ticket?: { id: string; expMs: number; resumeMs: number };
};

class SocketConnection implements HubConnection {
  constructor(private readonly ws: HibernatableSocket) {}

  get state(): ConnectionState {
    return this.ws.deserializeAttachment() as ConnectionState;
  }

  save(state: ConnectionState): void {
    this.ws.serializeAttachment(state);
  }

  send(text: string): void {
    try {
      this.ws.send(text);
    } catch {
      // Closing or closed: nothing to deliver to.
    }
  }

  close(code: number, reason: string): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

/** A `RealtimeHub` over one Durable Object's sockets. */
export class HubHost {
  readonly hub: RealtimeHub;

  constructor(
    private readonly state: SocketState,
    onEvent?: HubEventHandler,
  ) {
    this.hub = new RealtimeHub({
      connections: () =>
        this.state
          .getWebSockets()
          .filter((ws) => (ws.readyState ?? 1) === 1 && ws.deserializeAttachment())
          .map((ws) => new SocketConnection(ws)),
      onEvent,
    });
  }

  /**
   * Accepts a connection the Worker has verified: hibernatable, with its
   * protocol state attached, greeted with the `connected` frame.
   */
  accept(server: HibernatableSocket, verified: VerifiedConnection): void {
    const connectionId = crypto.randomUUID().replace(/-/g, "");
    this.state.acceptWebSocket(server as never, [verified.userId]);
    const connection = new SocketConnection(server);
    connection.save({
      ...RealtimeHub.initialState(verified.userId, connectionId, verified.roles, verified.groups),
      ...(verified.ticket ? { ticket: verified.ticket.id } : {}),
    });
    this.hub.open(connection);
  }

  async message(ws: HibernatableSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return; // protocol v1 is JSON text only
    await this.hub.receive(new SocketConnection(ws), message);
  }

  /** Whether a connection opened with ticket `id` is open now. */
  ticketOpen(id: string): boolean {
    return this.state
      .getWebSockets()
      .some((ws) => (ws.readyState ?? 1) === 1 && (ws.deserializeAttachment() as ConnectionState | null)?.ticket === id);
  }

  /** The ticket a socket was opened with, if any. */
  static ticketOf(ws: HibernatableSocket): string | undefined {
    return (ws.deserializeAttachment() as ConnectionState | null)?.ticket;
  }

  closed(ws: HibernatableSocket, code: number, reason: string): void {
    // Complete the close handshake; the socket then leaves getWebSockets().
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}

/**
 * Why a request isn't a protocol v1 WebSocket upgrade, or undefined when it
 * is. Checked by the object after it has redeemed the URL's ticket, so a URL
 * refused here is spent like any other.
 */
export function upgradeProblem(headers: Headers): string | undefined {
  if (headers.get("Upgrade")?.toLowerCase() !== "websocket") return "Expected a WebSocket upgrade";
  const protocols = (headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
  if (!protocols.includes(REALTIME_SUBPROTOCOL)) return `Expected the ${REALTIME_SUBPROTOCOL} subprotocol`;
  return undefined;
}

/** Response headers for an accepted upgrade. */
export function upgradeHeaders(): Record<string, string> {
  return { "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL };
}
