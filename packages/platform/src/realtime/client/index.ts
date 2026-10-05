/**
 * AgentForEach Platform — the portable realtime client
 *
 * One client for every realtime provider, keyed on the connection
 * descriptor's `protocol` (`ConnectionDescriptor` in ../types.ts):
 *
 *   - "v1": Azure Web PubSub, Cloudflare and the memory provider, over the
 *     `json.webpubsub.azure.v1` subprotocol (../protocol.ts);
 *   - "appsync-events": AWS AppSync Events. Client connections only
 *     receive; a relay connection subscribes to its own channel and
 *     publishes to its peer's.
 *
 * It offers a client connection (the user's own events), a relay connection
 * between two parties the gateway introduced (each message comes with the
 * peer's `fromUserId`), reconnection with bounded, jittered backoff
 * (`keepConnected`), and the fragment envelopes AppSync's event size limit
 * needs (`encodeFrame`; the client reassembles frames up to 4 MiB).
 *
 * It depends on nothing, not even the rest of this package: everything is
 * inside `defineRealtimeClient`, so the function's source is the client.
 * Node code imports it from here. Where nothing can be built or bundled, a
 * generated copy is checked in, and tests check each one is current
 * (`node scripts/sync-realtime-client.mjs` rewrites them):
 *
 *   - examples/web-chat/realtime-client.js: an ES module for the static page;
 *   - gateway/sandbox-container/browser/realtime-client.mjs: the sandbox
 *     image's browser driver;
 *   - gateway/skills/browser/realtime-client-script.ts: a classic script the
 *     browser live view inlines under its CSP hash.
 */

import type { ConnectionDescriptor } from "../types.js";

/** The part of the WebSocket API the client uses: browsers', Node's (22 and later) and test fakes. */
export interface RealtimeSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
}

export type RealtimeSocketConstructor = new (url: string, protocols: string | string[]) => RealtimeSocket;

export type RealtimeConnectOptions = {
  /** Each frame the server pushed, decoded (fragments reassembled). */
  onMessage?: (data: unknown) => void;
  /** The connection ended after it was open, and why. Not called after `close()`. */
  onClose?: (error: Error) => void;
  /** Default: the global WebSocket. */
  WebSocket?: RealtimeSocketConstructor;
  /** How long connecting (and subscribing) may take. Default 10 s; 15 s for a relay. */
  timeoutMs?: number;
};

export type RealtimeRelayOptions = Omit<RealtimeConnectOptions, "onMessage"> & {
  /** The relay group: protocol v1 joins it; AppSync's channels already name it. */
  group: string;
  /** The other party. Only its messages are delivered. */
  peerUserId: string;
  onMessage?: (data: unknown, fromUserId: string) => void;
  /** How long an AppSync publish may wait for its answer before the connection is given up. Default 15 s. */
  publishTimeoutMs?: number;
};

export interface RealtimeConnection {
  close(): void;
}

export interface RealtimeRelayConnection extends RealtimeConnection {
  /**
   * Sends `data` to the peer; false when it wasn't sent: the connection
   * isn't open, or the link is congested and the message is `droppable` (a
   * later one replaces it, as a screen frame does). A message that may not
   * be dropped ends a congested connection instead. Nothing is ever resent,
   * since a repeat could repeat a click.
   */
  send(data: unknown, options?: { droppable?: boolean }): boolean;
  /** Bytes queued and not yet sent (protocol v1) or not yet acknowledged (AppSync). */
  readonly bufferedAmount: number;
}

export type RealtimeConnectionState = "connecting" | "open" | "retrying" | "closed";

export type KeepConnectedOptions = Omit<RealtimeConnectOptions, "onClose"> & {
  /** A fresh descriptor for each attempt (a new token). */
  access: () => Promise<ConnectionDescriptor>;
  onState?: (state: RealtimeConnectionState, detail: { attempt: number; delayMs?: number; error?: Error }) => void;
  /** The first retry's delay ceiling. Default 500 ms. */
  minDelayMs?: number;
  /** No retry waits longer. Default 30 s. */
  maxDelayMs?: number;
  /** Failed attempts in a row before giving up ("closed"). Default: never. */
  maxAttempts?: number;
};

export type EncodeFrameOptions = {
  /** An event this size or under (measured as the JSON string it travels in) goes whole. Default 180 KiB. */
  maxEventBytes?: number;
  /** Bytes of the frame per fragment. Default 120 KiB. */
  chunkBytes?: number;
  /** The fragments' id. Default: a random UUID. */
  id?: string;
};

export interface RealtimeClient {
  /** The largest frame, after reassembly: 4 MiB. */
  readonly MAX_FRAME_BYTES: number;
  /**
   * A frame as AppSync events: the frame's JSON when it fits in one, or
   * `afe-fragment` envelopes of base64 chunks that `createFrameDecoder`
   * reassembles.
   */
  encodeFrame(frame: unknown, options?: EncodeFrameOptions): string[];
  /**
   * A decoder for one connection: returns the frame, or undefined while a
   * fragmented one is incomplete. Throws on a malformed fragment.
   */
  createFrameDecoder(): (input: unknown) => unknown;
  /** The user's own events. Resolves once connected (on AppSync, once every channel is subscribed). */
  connectRealtime(descriptor: ConnectionDescriptor, options?: RealtimeConnectOptions): Promise<RealtimeConnection>;
  /** A relay connection to one peer. Resolves once it can send and receive. */
  connectRelay(descriptor: ConnectionDescriptor, options: RealtimeRelayOptions): Promise<RealtimeRelayConnection>;
  /** A client connection that reconnects, with a fresh descriptor, until closed. */
  keepConnected(options: KeepConnectedOptions): RealtimeConnection;
  /** The wait before retry `attempt` (from 1): up to min × 2^(attempt-1), capped at max, and jittered to half or more of that. */
  backoffDelay(attempt: number, minDelayMs?: number, maxDelayMs?: number): number;
}

/** The names `realtimeClientModule()` exports, in order. */
const EXPORTS = [
  "encodeFrame",
  "createFrameDecoder",
  "connectRealtime",
  "connectRelay",
  "keepConnected",
  "backoffDelay",
] as const satisfies ReadonlyArray<keyof RealtimeClient>;

/**
 * The client. Self-contained: nothing outside this function is referenced,
 * so its source alone is the client (see the module docs).
 */
export function defineRealtimeClient(): RealtimeClient {
  const MAX_FRAME_BYTES = 4 * 1024 * 1024;
  /** Fragments of one frame, at most: 4 MiB in the relay's 64,000-byte chunks. */
  const MAX_FRAGMENTS = 66;
  /** A fragment's base64, at most: a 120 KiB chunk. */
  const MAX_FRAGMENT_CHARS = 164_000;
  /** Frames being reassembled at once, and how long one may take. */
  const MAX_PENDING_FRAMES = 4;
  const PENDING_FRAME_MS = 30_000;
  /** A relay's AppSync events: one publish each, smaller than a client event (they ride a WebSocket message with the token). */
  const RELAY_EVENT = { maxEventBytes: 100_000, chunkBytes: 64_000 };
  /** Unacknowledged relay publishes, and bytes, before the link counts as congested. */
  const RELAY_INFLIGHT_EVENTS = 80;
  const RELAY_INFLIGHT_BYTES = 6 * 1024 * 1024;
  const V1_SUBPROTOCOL = "json.webpubsub.azure.v1";
  const APPSYNC_SUBPROTOCOL = "aws-appsync-event-ws";
  /** AppSync's keep-alive interval, at most (its `connectionTimeoutMs`). */
  const MAX_KEEPALIVE_MS = 300_000;
  /** A client connection renews its token this long before it expires. */
  const RENEW_BEFORE_MS = 5_000;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function base64(bytes: Uint8Array): string {
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  }

  function base64url(text: string): string {
    return base64(encoder.encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function encodeFrame(frame: unknown, options: EncodeFrameOptions = {}): string[] {
    const { maxEventBytes = 180 * 1024, chunkBytes = 120 * 1024 } = options;
    const json = JSON.stringify(frame);
    const bytes = encoder.encode(json);
    if (bytes.length > MAX_FRAME_BYTES) throw new Error("Realtime frame exceeds 4 MiB");
    // An event travels as a JSON string inside JSON: measure it escaped.
    if (encoder.encode(JSON.stringify(json)).length <= maxEventBytes) return [json];
    const count = Math.ceil(bytes.length / chunkBytes);
    if (count > MAX_FRAGMENTS) throw new Error("Realtime frame needs too many fragments");
    const id = options.id ?? crypto.randomUUID();
    return Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        type: "afe-fragment",
        version: 1,
        id,
        index,
        count,
        data: base64(bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes)),
      }),
    );
  }

  function createFrameDecoder(): (input: unknown) => unknown {
    type Pending = { chunks: Map<number, Uint8Array>; count: number; size: number; expires: number };
    const pending = new Map<string, Pending>();
    return (input) => {
      const frame = typeof input === "string" ? JSON.parse(input) : input;
      if (!frame || frame.type !== "afe-fragment") return frame;
      const { id, index, count, data } = frame;
      if (
        frame.version !== 1 ||
        typeof id !== "string" ||
        id.length > 128 ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_FRAGMENTS ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= count ||
        typeof data !== "string" ||
        data.length > MAX_FRAGMENT_CHARS
      ) {
        throw new Error("Invalid realtime fragment");
      }
      const now = Date.now();
      for (const [key, entry] of pending) if (entry.expires <= now) pending.delete(key);
      let entry = pending.get(id);
      if (!entry) {
        if (pending.size >= MAX_PENDING_FRAMES) throw new Error("Too many incomplete realtime frames");
        entry = { chunks: new Map(), count, size: 0, expires: now + PENDING_FRAME_MS };
        pending.set(id, entry);
      }
      if (entry.count !== count) throw new Error("Inconsistent realtime fragments");
      // A fragment delivered twice is the same fragment.
      if (!entry.chunks.has(index)) {
        const chunk = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        entry.size += chunk.length;
        if (entry.size > MAX_FRAME_BYTES) {
          pending.delete(id);
          throw new Error("Realtime frame exceeds 4 MiB");
        }
        entry.chunks.set(index, chunk);
      }
      if (entry.chunks.size !== count) return undefined;
      pending.delete(id);
      const bytes = new Uint8Array(entry.size);
      let offset = 0;
      for (let i = 0; i < count; i++) {
        const chunk = entry.chunks.get(i)!;
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(decoder.decode(bytes));
    };
  }

  /** One socket's opening, readiness, timers and end, for both protocols. */
  function lifecycle(socket: RealtimeSocket, timeoutMs: number, onClose: ((error: Error) => void) | undefined) {
    let ready = false;
    let closed = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const whenReady = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const end = (): void => {
      closed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try {
        socket.close(1000);
      } catch {
        // already closing
      }
    };
    const life = {
      ready: whenReady,
      get open(): boolean {
        return ready && !closed;
      },
      get closed(): boolean {
        return closed;
      },
      connected(): void {
        if (ready || closed) return;
        ready = true;
        life.clear(handshake);
        resolveReady();
      },
      fail(error: Error): void {
        if (closed) return;
        end();
        if (!ready) rejectReady(error);
        else onClose?.(error);
      },
      close(): void {
        if (closed) return;
        end();
        if (!ready) rejectReady(new Error("Realtime connection closed"));
      },
      timer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
        const t = setTimeout(() => {
          timers.delete(t);
          fn();
        }, ms);
        timers.add(t);
        return t;
      },
      clear(t: ReturnType<typeof setTimeout> | undefined): void {
        if (t === undefined) return;
        clearTimeout(t);
        timers.delete(t);
      },
    };
    const handshake = life.timer(timeoutMs, () => life.fail(new Error("Realtime connection timed out")));
    return life;
  }

  function socketClass(options: { WebSocket?: RealtimeSocketConstructor }): RealtimeSocketConstructor {
    const Socket = options.WebSocket ?? (globalThis as { WebSocket?: RealtimeSocketConstructor }).WebSocket;
    if (!Socket) throw new Error("No WebSocket implementation");
    return Socket;
  }

  /** Protocol v1: the service greets with `connected`; a relay then joins its group. */
  function connectV1(
    descriptor: { url: string },
    options: RealtimeConnectOptions,
    relay: RealtimeRelayOptions | undefined,
  ): Promise<RealtimeRelayConnection> {
    const socket = new (socketClass(options))(descriptor.url, V1_SUBPROTOCOL);
    const life = lifecycle(socket, options.timeoutMs ?? (relay ? 15_000 : 10_000), options.onClose);
    const decode = createFrameDecoder();
    let reason = "";
    socket.addEventListener("message", (event) => {
      if (life.closed) return;
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // not a protocol v1 frame
      }
      if (message?.type === "system") {
        if (message.event === "connected") {
          if (relay) socket.send(JSON.stringify({ type: "joinGroup", group: relay.group, ackId: 1 }));
          else life.connected();
        } else if (message.event === "disconnected") {
          reason = String(message.message ?? "");
        }
        return;
      }
      if (relay && message?.type === "ack" && message.ackId === 1 && !life.open) {
        if (message.success === true) life.connected();
        else life.fail(new Error("The relay refused to join the group"));
        return;
      }
      if (message?.type !== "message" || !life.open) return;
      if (relay) {
        // The service stamps fromUserId from the sender's token: only the peer speaks.
        if (message.from !== "group" || message.fromUserId !== relay.peerUserId) return;
        if (message.group !== undefined && message.group !== relay.group) return;
        relay.onMessage?.(message.data, message.fromUserId);
        return;
      }
      if (message.from !== "server") return;
      let frame;
      try {
        frame = decode(message.data);
      } catch {
        return; // a text frame that isn't JSON: not ours
      }
      if (frame !== undefined) options.onMessage?.(frame);
    });
    socket.addEventListener("error", () => life.fail(new Error("Realtime connection failed")));
    socket.addEventListener("close", () =>
      life.fail(new Error(reason ? `Realtime connection closed: ${reason}` : "Realtime connection closed")),
    );
    return life.ready.then(() => ({
      close: () => life.close(),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      send(data: unknown): boolean {
        if (!relay || !life.open) return false;
        socket.send(JSON.stringify({ type: "sendToGroup", group: relay.group, dataType: "json", noEcho: true, data }));
        return true;
      },
    }));
  }

  /**
   * AppSync Events: `connection_init`, then one subscribe per channel; the
   * connection counts once every subscription is confirmed. A relay also
   * publishes to its peer's channel, each publish answered or the
   * connection given up.
   */
  function connectAppSync(
    descriptor: Extract<ConnectionDescriptor, { protocol: "appsync-events" }>,
    options: RealtimeConnectOptions,
    relay: RealtimeRelayOptions | undefined,
  ): Promise<RealtimeRelayConnection> {
    const { authorization, channels } = descriptor;
    if (
      !authorization?.Authorization ||
      !authorization.host ||
      !Array.isArray(channels) ||
      channels.length < 1 ||
      channels.length > 16 ||
      (relay && (channels.length !== 1 || !descriptor.publish || descriptor.publish === channels[0]))
    ) {
      return Promise.reject(new Error("Invalid AppSync connection"));
    }
    const socket = new (socketClass(options))(descriptor.url, [APPSYNC_SUBPROTOCOL, `header-${base64url(JSON.stringify(authorization))}`]);
    const life = lifecycle(socket, options.timeoutMs ?? (relay ? 15_000 : 10_000), options.onClose);
    const decode = createFrameDecoder();
    const subscribing = new Set<string>();
    const subscriptions = new Set<string>();
    const inflight = new Map<string, { bytes: number; timer: ReturnType<typeof setTimeout> }>();
    let acknowledged = false;
    let keepAliveMs = MAX_KEEPALIVE_MS;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let published = 0;
    const raw = (message: unknown): void => socket.send(JSON.stringify(message));
    const inflightBytes = (): number => [...inflight.values()].reduce((n, p) => n + p.bytes, 0);
    const alive = (): void => {
      life.clear(heartbeat);
      heartbeat = life.timer(keepAliveMs, () => life.fail(new Error("Realtime keep-alive timed out")));
    };
    if (Number.isFinite(descriptor.expiresAtMs)) {
      // A relay ends with its token; a client connection reconnects with a new one just before.
      const left = descriptor.expiresAtMs - Date.now() - (relay ? 0 : RENEW_BEFORE_MS);
      life.timer(Math.max(1, left), () =>
        life.fail(new Error(relay ? "The relay connection expired" : "Realtime token expired; reconnect to renew")),
      );
    }

    socket.addEventListener("open", () => {
      if (!life.closed) raw({ type: "connection_init" });
    });
    socket.addEventListener("message", (event) => {
      if (life.closed) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 6 * 1024 * 1024) throw new Error("Invalid message");
        const message = JSON.parse(event.data);
        switch (message?.type) {
          case "connection_ack": {
            if (acknowledged) return;
            acknowledged = true;
            const timeout = Number(message.connectionTimeoutMs);
            if (timeout > 0) keepAliveMs = Math.min(MAX_KEEPALIVE_MS, Math.max(1000, timeout));
            alive();
            channels.forEach((channel, index) => {
              const id = `s${index}`;
              subscribing.add(id);
              subscriptions.add(id);
              raw({ type: "subscribe", id, channel, authorization });
            });
            return;
          }
          case "ka":
            if (acknowledged) alive();
            return;
          case "subscribe_success":
            if (subscribing.delete(message.id) && subscribing.size === 0) life.connected();
            return;
          case "publish_success": {
            const entry = inflight.get(message.id);
            if (!entry) return;
            if (Array.isArray(message.failed) && message.failed.length) throw new Error("Publish rejected");
            life.clear(entry.timer);
            inflight.delete(message.id);
            return;
          }
          case "data": {
            if (!subscriptions.has(message.id)) return;
            // AppSync has delivered both one event (a string) and a list of them.
            const payload = message.event ?? message.events;
            const events = Array.isArray(payload) ? payload : [payload];
            if (events.length > 5) throw new Error("Too many events");
            for (const item of events) {
              const frame = decode(item);
              if (frame === undefined) continue;
              // Only the peer can publish to a relay's channel (its token's one publish channel).
              if (relay) relay.onMessage?.(frame, relay.peerUserId);
              else options.onMessage?.(frame);
            }
            return;
          }
          default:
            if (String(message?.type).includes("error")) throw new Error(String(message.type));
        }
      } catch {
        life.fail(new Error("AppSync refused the connection, a subscription or a publish"));
      }
    });
    socket.addEventListener("error", () => life.fail(new Error("Realtime connection failed")));
    socket.addEventListener("close", () => life.fail(new Error("Realtime connection closed")));

    return life.ready.then(() => ({
      close: () => life.close(),
      get bufferedAmount() {
        return socket.bufferedAmount + inflightBytes();
      },
      send(data: unknown, sendOptions: { droppable?: boolean } = {}): boolean {
        if (!relay || !life.open) return false;
        let events: string[];
        try {
          events = encodeFrame(data, RELAY_EVENT);
        } catch {
          life.fail(new Error("A relay message is too large"));
          return false;
        }
        const sizes = events.map((e) => encoder.encode(e).length);
        const bytes = sizes.reduce((n, s) => n + s, 0);
        if (inflight.size + events.length > RELAY_INFLIGHT_EVENTS || socket.bufferedAmount + inflightBytes() + bytes > RELAY_INFLIGHT_BYTES) {
          if (sendOptions.droppable) return false;
          life.fail(new Error("The relay is congested"));
          return false;
        }
        events.forEach((item, i) => {
          const id = `p${++published}`;
          const timer = life.timer(relay.publishTimeoutMs ?? 15_000, () => life.fail(new Error("A relay publish timed out")));
          inflight.set(id, { bytes: sizes[i], timer });
          raw({ type: "publish", id, channel: descriptor.publish, events: [item], authorization });
        });
        return true;
      },
    }));
  }

  function connect(
    descriptor: ConnectionDescriptor,
    options: RealtimeConnectOptions,
    relay: RealtimeRelayOptions | undefined,
  ): Promise<RealtimeRelayConnection> {
    try {
      const url = new URL(descriptor?.url);
      if (!/^wss?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid realtime URL");
      if (relay && (!relay.group || !relay.peerUserId)) throw new Error("A relay connection needs its group and peer");
      if (descriptor.protocol === "v1") return connectV1(descriptor, options, relay);
      if (descriptor.protocol === "appsync-events") return connectAppSync(descriptor, options, relay);
      throw new Error("Unsupported realtime protocol");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function connectRealtime(descriptor: ConnectionDescriptor, options: RealtimeConnectOptions = {}): Promise<RealtimeConnection> {
    return connect(descriptor, options, undefined).then((c) => ({ close: () => c.close() }));
  }

  function connectRelay(descriptor: ConnectionDescriptor, options: RealtimeRelayOptions): Promise<RealtimeRelayConnection> {
    const { WebSocket, timeoutMs, onClose } = options;
    return connect(descriptor, { WebSocket, timeoutMs, onClose }, options);
  }

  function backoffDelay(attempt: number, minDelayMs = 500, maxDelayMs = 30_000): number {
    const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** Math.max(0, attempt - 1));
    return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
  }

  /** A connection that lasted this long resets the backoff; a flapping one doesn't. */
  const STABLE_MS = 10_000;

  function keepConnected(options: KeepConnectedOptions): RealtimeConnection {
    const { access, onState, minDelayMs = 500, maxDelayMs = 30_000, maxAttempts = Infinity } = options;
    let stopped = false;
    let current: RealtimeConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let openedAt = 0;

    const retry = (error: Error): void => {
      if (stopped) return;
      if (openedAt && Date.now() - openedAt >= STABLE_MS) attempt = 0;
      openedAt = 0;
      attempt++;
      if (attempt > maxAttempts) {
        stopped = true;
        onState?.("closed", { attempt, error });
        return;
      }
      const delayMs = backoffDelay(attempt, minDelayMs, maxDelayMs);
      onState?.("retrying", { attempt, delayMs, error });
      timer = setTimeout(run, delayMs);
    };

    async function run(): Promise<void> {
      if (stopped) return;
      onState?.("connecting", { attempt });
      try {
        const descriptor = await access();
        if (stopped) return;
        const connection = await connectRealtime(descriptor, {
          ...options,
          onClose: (error) => {
            current = undefined;
            retry(error);
          },
        });
        if (stopped) return connection.close();
        current = connection;
        openedAt = Date.now();
        onState?.("open", { attempt });
      } catch (err) {
        retry(err instanceof Error ? err : new Error(String(err)));
      }
    }

    void run();
    return {
      close(): void {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        current?.close();
        current = undefined;
        onState?.("closed", { attempt });
      },
    };
  }

  return { MAX_FRAME_BYTES, encodeFrame, createFrameDecoder, connectRealtime, connectRelay, keepConnected, backoffDelay };
}

export const { encodeFrame, createFrameDecoder, connectRealtime, connectRelay, keepConnected, backoffDelay } = defineRealtimeClient();

const GENERATED = (from: string): string =>
  `// The AgentForEach portable realtime client, generated from ${from}.\n` +
  "// Don't edit it: change the source, then run `node scripts/sync-realtime-client.mjs`.\n";

/** The client as an ES module (the checked-in copies for the web chat and the sandbox's browser driver). */
export function realtimeClientModule(): string {
  return (
    GENERATED("packages/platform/src/realtime/client/index.ts") +
    `const client = (${defineRealtimeClient.toString()})();\n` +
    `export const { ${EXPORTS.join(", ")} } = client;\n`
  );
}

/** The client as a classic script that defines `globalName` (the live view inlines it). */
export function realtimeClientScript(globalName = "afeRealtime"): string {
  return `var ${globalName} = (${defineRealtimeClient.toString()})();\n`;
}
