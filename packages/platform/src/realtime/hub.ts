/**
 * AgentForEach Platform — Realtime hub
 *
 * The protocol v1 service logic, independent of how sockets are held: group
 * membership, role checks, `noEcho`, acks and duplicate detection, the frame
 * size limit, `fromUserId` stamping, and inbound events. The in-memory
 * provider and the Cloudflare Durable Objects both run it, so they behave
 * the same by construction.
 *
 * A connection's state is plain JSON (`ConnectionState`) that the host saves
 * after every change, so a host that hibernates sockets (Durable Objects'
 * `serializeAttachment`) loses nothing.
 */

import {
  frameBytes,
  frames,
  hasGroupRole,
  MAX_FRAME_BYTES,
  parseClientFrame,
  roles,
  type AckErrorName,
  type DataType,
  type ServiceFrame,
} from "./protocol.js";

export type ConnectionState = {
  userId: string;
  connectionId: string;
  /** Web PubSub role strings from the connection's token. */
  roles: string[];
  groups: string[];
  /** The most recent ack ids, for duplicate detection. */
  acks: number[];
  /** The ticket (token jti) this connection was opened with, on providers that issue them. */
  ticket?: string;
};

/** One socket, as the host holds it. */
export interface HubConnection {
  readonly state: ConnectionState;
  /** Persist `state` for this socket (hibernating hosts) and make it current. */
  save(state: ConnectionState): void;
  send(text: string): void;
  close(code: number, reason: string): void;
}

/** An inbound `event` frame, for the hub's event handler. */
export type HubEvent = { userId: string; connectionId: string; event: string; dataType: DataType; data: unknown };

/**
 * Handles an inbound event. A returned `reply` is sent back to the same
 * connection as a `from: "server"` message before the ack.
 */
export type HubEventHandler = (event: HubEvent) => Promise<{ reply?: unknown } | void>;

export type RealtimeHubOptions = {
  /** Every open connection on this hub. */
  connections: () => Iterable<HubConnection>;
  /** Inbound events. Without one, `event` frames are refused: relays never reach gateway code. */
  onEvent?: HubEventHandler;
  maxFrameBytes?: number;
};

/** How many recent ack ids each connection remembers. */
const ACK_MEMORY = 64;

export class RealtimeHub {
  private readonly connections: () => Iterable<HubConnection>;
  private readonly onEvent?: HubEventHandler;
  private readonly maxFrameBytes: number;

  constructor(options: RealtimeHubOptions) {
    this.connections = options.connections;
    this.onEvent = options.onEvent;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  }

  /** A new connection's initial state; groups it starts in are given by the token issuer. */
  static initialState(userId: string, connectionId: string, tokenRoles: readonly string[], groups: readonly string[] = []): ConnectionState {
    return { userId, connectionId, roles: [...tokenRoles], groups: [...new Set(groups)], acks: [] };
  }

  /** Greets a connection that was just accepted. */
  open(connection: HubConnection): void {
    send(connection, frames.connected(connection.state.userId, connection.state.connectionId));
  }

  /** Handles one text frame from `connection`. */
  async receive(connection: HubConnection, text: string): Promise<void> {
    if (frameBytes(text) > this.maxFrameBytes) {
      this.disconnect(connection, `Message larger than ${this.maxFrameBytes} bytes`, 1009);
      return;
    }
    const frame = parseClientFrame(text);
    if (!frame) return; // not protocol v1: ignored

    if (frame.ackId !== undefined) {
      const state = connection.state;
      if (state.acks.includes(frame.ackId)) {
        send(connection, frames.ack(frame.ackId, { name: "Duplicate", message: `ackId ${frame.ackId} was already used` }));
        return;
      }
      connection.save({ ...state, acks: [...state.acks, frame.ackId].slice(-ACK_MEMORY) });
    }
    const ack = (error?: { name: AckErrorName; message: string }): void => {
      if (frame.ackId !== undefined) send(connection, frames.ack(frame.ackId, error));
    };
    const forbidden = (message: string): void => ack({ name: "Forbidden", message });

    switch (frame.type) {
      case "joinGroup":
      case "leaveGroup": {
        if (!hasGroupRole(connection.state.roles, roles.joinLeaveGroup, frame.group)) return forbidden(`No permission to join or leave group ${frame.group}`);
        const groups = new Set(connection.state.groups);
        if (frame.type === "joinGroup") groups.add(frame.group);
        else groups.delete(frame.group);
        connection.save({ ...connection.state, groups: [...groups] });
        return ack();
      }
      case "sendToGroup": {
        if (!hasGroupRole(connection.state.roles, roles.sendToGroup, frame.group)) return forbidden(`No permission to send to group ${frame.group}`);
        const text = JSON.stringify(frames.group(connection.state.userId, frame.group, frame.data, frame.dataType));
        for (const other of this.connections()) {
          if (frame.noEcho && other.state.connectionId === connection.state.connectionId) continue;
          if (other.state.groups.includes(frame.group)) other.send(text);
        }
        return ack();
      }
      case "event": {
        if (!this.onEvent) return forbidden("This hub accepts no events");
        const { userId, connectionId } = connection.state;
        try {
          const result = await this.onEvent({ userId, connectionId, event: frame.event, dataType: frame.dataType, data: frame.data });
          if (result && "reply" in result && result.reply !== undefined) send(connection, frames.server(result.reply));
          return ack();
        } catch (err) {
          return ack({ name: "InternalServerError", message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  /** Sends `data` to every connection of `userId`; returns how many got it. */
  sendToUser(userId: string, data: unknown, dataType: DataType = "json"): number {
    const text = JSON.stringify(frames.server(data, dataType));
    let delivered = 0;
    for (const connection of this.connections()) {
      if (connection.state.userId !== userId) continue;
      connection.send(text);
      delivered++;
    }
    return delivered;
  }

  isUserOnline(userId: string): boolean {
    for (const connection of this.connections()) if (connection.state.userId === userId) return true;
    return false;
  }

  /** Closes every connection of `userId`, telling each why; returns how many. */
  disconnectUser(userId: string, reason = "Closed by the server"): number {
    let closed = 0;
    for (const connection of [...this.connections()]) {
      if (connection.state.userId !== userId) continue;
      this.disconnect(connection, reason, 1000);
      closed++;
    }
    return closed;
  }

  private disconnect(connection: HubConnection, reason: string, code: number): void {
    send(connection, frames.disconnected(reason));
    connection.close(code, reason.slice(0, 120));
  }
}

function send(connection: HubConnection, frame: ServiceFrame): void {
  connection.send(JSON.stringify(frame));
}
