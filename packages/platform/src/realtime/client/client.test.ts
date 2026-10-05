import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryRealtime } from "../memory.js";
import type { RealtimeTestClient } from "../testing.js";
import type { ConnectionDescriptor } from "../types.js";
import {
  backoffDelay,
  connectRealtime,
  connectRelay,
  createFrameDecoder,
  defineRealtimeClient,
  encodeFrame,
  keepConnected,
  realtimeClientModule,
  type RealtimeSocket,
  type RealtimeSocketConstructor,
} from "./index.js";

type Listener = (event: { data?: unknown }) => void;

/** A WebSocket the test drives: it records what the client sends and delivers what the test says the service sent. */
class FakeSocket implements RealtimeSocket {
  readyState = 0;
  bufferedAmount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly sent: any[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  constructor(
    readonly url: string,
    readonly protocols: string | string[],
  ) {}
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", {}));
  }
  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  receive(message: unknown): void {
    this.emit("message", { data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** A socket class whose instances the test can reach. */
function fakeSockets(): { WebSocket: RealtimeSocketConstructor; sockets: FakeSocket[]; next: () => Promise<FakeSocket> } {
  const sockets: FakeSocket[] = [];
  const waiting: Array<(s: FakeSocket) => void> = [];
  class Socket extends FakeSocket {
    constructor(url: string, protocols: string | string[]) {
      super(url, protocols);
      sockets.push(this);
      waiting.shift()?.(this);
    }
  }
  let taken = 0;
  return {
    WebSocket: Socket,
    sockets,
    next: () => (sockets.length > taken ? Promise.resolve(sockets[taken++]) : new Promise((resolve) => waiting.push((s) => (taken++, resolve(s))))),
  };
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const APPSYNC_URL = "wss://example.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime";
const authorization = { host: "example.appsync-api.us-west-2.amazonaws.com", Authorization: "afe1.payload.mac" };
const appsync = (extra: Partial<Extract<ConnectionDescriptor, { protocol: "appsync-events" }>> = {}): ConnectionDescriptor => ({
  protocol: "appsync-events",
  url: APPSYNC_URL,
  authorization,
  channels: ["/agentforeach/users/a/b", "/agentforeach/all"],
  expiresAtMs: Date.now() + 3_600_000,
  ...extra,
});

/** Drives an AppSync socket through connection_init, the ack and every subscription. */
async function acceptAppSync(socket: FakeSocket, connectionTimeoutMs = 300_000): Promise<void> {
  socket.open();
  assert.deepEqual(socket.sent.shift(), { type: "connection_init" });
  socket.receive({ type: "connection_ack", connectionTimeoutMs });
  for (const message of socket.sent.splice(0)) {
    assert.equal(message.type, "subscribe");
    socket.receive({ type: "subscribe_success", id: message.id });
  }
}

describe("portable realtime client: protocol v1", () => {
  it("connects with the v1 subprotocol, once the service says connected, and delivers the server's pushes", async () => {
    const { WebSocket, next } = fakeSockets();
    const received: unknown[] = [];
    const pending = connectRealtime({ protocol: "v1", url: "wss://hub.example/client?access_token=t" }, { WebSocket, onMessage: (d) => received.push(d) });
    const socket = await next();
    assert.equal(socket.protocols, "json.webpubsub.azure.v1");
    socket.open();
    socket.receive({ type: "system", event: "connected", userId: "u", connectionId: "c" });
    const connection = await pending;
    socket.receive({ type: "message", from: "server", dataType: "json", data: { type: "event", event: "chat", payload: { state: "delta" } } });
    socket.receive({ type: "message", from: "server", dataType: "text", data: '{"type":"event","event":"cron"}' });
    socket.receive({ type: "message", from: "group", fromUserId: "x", group: "g", data: { type: "event", event: "chat" } });
    socket.receive("not json");
    assert.deepEqual(received, [
      { type: "event", event: "chat", payload: { state: "delta" } },
      { type: "event", event: "cron" },
    ]);
    connection.close();
  });

  it("says why the service closed the connection, and nothing after close()", async () => {
    const { WebSocket, next } = fakeSockets();
    const closes: Error[] = [];
    const pending = connectRealtime({ protocol: "v1", url: "wss://hub.example/c" }, { WebSocket, onClose: (e) => closes.push(e) });
    const socket = await next();
    socket.open();
    socket.receive({ type: "system", event: "connected" });
    await pending;
    socket.receive({ type: "system", event: "disconnected", message: "account deleted" });
    socket.close();
    await tick();
    assert.equal(closes.length, 1);
    assert.match(closes[0].message, /account deleted/);

    const quiet = connectRealtime({ protocol: "v1", url: "wss://hub.example/c" }, { WebSocket, onClose: (e) => closes.push(e) });
    const second = await next();
    second.open();
    second.receive({ type: "system", event: "connected" });
    (await quiet).close();
    await tick();
    assert.equal(closes.length, 1, "close() is not reported as a failure");
  });

  it("a relay joins its group, counts once the join is acked, and hears only its peer", async () => {
    const { WebSocket, next } = fakeSockets();
    const heard: Array<[unknown, string]> = [];
    const pending = connectRelay({ protocol: "v1", url: "wss://hub.example/relay?access_token=t" }, {
      WebSocket,
      group: "bh-1",
      peerUserId: "browser-driver:ab",
      onMessage: (data, from) => heard.push([data, from]),
    });
    const socket = await next();
    socket.open();
    socket.receive({ type: "system", event: "connected" });
    assert.deepEqual(socket.sent.shift(), { type: "joinGroup", group: "bh-1", ackId: 1 });
    socket.receive({ type: "ack", ackId: 1, success: true });
    const relay = await pending;
    socket.receive({ type: "message", from: "group", fromUserId: "browser-driver:ab", group: "bh-1", data: { kind: "frame", seq: 1 } });
    socket.receive({ type: "message", from: "group", fromUserId: "someone-else", group: "bh-1", data: { kind: "frame", seq: 2 } });
    socket.receive({ type: "message", from: "group", fromUserId: "browser-driver:ab", group: "bh-2", data: { kind: "frame", seq: 3 } });
    socket.receive({ type: "message", from: "server", data: { kind: "frame", seq: 4 } });
    assert.deepEqual(heard, [[{ kind: "frame", seq: 1 }, "browser-driver:ab"]]);
    assert.equal(relay.send({ kind: "hello" }), true);
    assert.deepEqual(socket.sent.shift(), { type: "sendToGroup", group: "bh-1", dataType: "json", noEcho: true, data: { kind: "hello" } });
    relay.close();
    assert.equal(relay.send({ kind: "hello" }), false, "nothing is sent on a closed relay");
  });

  it("a relay the service won't let join fails", async () => {
    const { WebSocket, next } = fakeSockets();
    const pending = connectRelay({ protocol: "v1", url: "wss://hub.example/relay" }, { WebSocket, group: "bh-1", peerUserId: "p" });
    const socket = await next();
    socket.open();
    socket.receive({ type: "system", event: "connected" });
    socket.receive({ type: "ack", ackId: 1, success: false, error: { name: "Forbidden" } });
    await assert.rejects(pending, /refused to join/);
  });

  it("runs against the memory provider's hub: pushes, and a relay that carries fromUserId", async () => {
    const memory = new MemoryRealtime();
    /** The memory provider's test client, behind the WebSocket API (its memory:// URLs as ws://). */
    class MemorySocket implements RealtimeSocket {
      readyState = 0;
      bufferedAmount = 0;
      private client?: RealtimeTestClient;
      private readonly listeners = new Map<string, Listener[]>();
      constructor(url: string, protocols: string | string[]) {
        void memory.connect(url.replace(/^ws:/, "memory:"), String(protocols)).then(
          async (client) => {
            this.client = client;
            this.readyState = 1;
            this.emit("open", {});
            void client.closed.then(() => ((this.readyState = 3), this.emit("close", {})));
            while (this.readyState !== 3) {
              const frame = await client.next(undefined, 100).catch(() => undefined);
              if (frame && this.readyState !== 3) this.emit("message", { data: JSON.stringify(frame) });
            }
          },
          () => this.emit("error", {}),
        );
      }
      addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(data: string): void {
        this.client?.send(data);
      }
      close(): void {
        this.client?.close();
      }
      private emit(type: string, event: { data?: unknown }): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const ws = (url: string): string => url.replace(/^memory:/, "ws:");
    const pushed: unknown[] = [];
    const access = await memory.clientAccess("alice", { ttlMinutes: 5 });
    const client = await connectRealtime({ protocol: "v1", url: ws(access.url) }, { WebSocket: MemorySocket, onMessage: (d) => pushed.push(d) });
    await memory.sendToUser("alice", { type: "event", event: "chat", payload: { text: "hé ✓" } });
    await tick(20);
    assert.deepEqual(pushed, [{ type: "event", event: "chat", payload: { text: "hé ✓" } }]);
    client.close();

    const group = "bh-memory";
    const issue = (userId: string, peerUserId: string) =>
      memory.relay.groupAccess({ hub: "agentforeach_browser", userId, group, ttlMinutes: 5, peerUserId });
    const heard: Array<[unknown, string]> = [];
    const driver = await connectRelay({ protocol: "v1", url: ws((await issue("driver", "viewer")).url) }, {
      WebSocket: MemorySocket,
      group,
      peerUserId: "viewer",
      onMessage: (data, from) => heard.push([data, from]),
    });
    const viewer = await connectRelay({ protocol: "v1", url: ws((await issue("viewer", "driver")).url) }, {
      WebSocket: MemorySocket,
      group,
      peerUserId: "driver",
    });
    viewer.send({ kind: "hello" });
    await tick(20);
    assert.deepEqual(heard, [[{ kind: "hello" }, "viewer"]]);
    driver.close();
    viewer.close();
  });
});

describe("portable realtime client: AppSync Events", () => {
  it("connects with the authorization header, subscribes to every channel, and counts once each is confirmed", async () => {
    const { WebSocket, next } = fakeSockets();
    let connected = false;
    const pending = connectRealtime(appsync(), { WebSocket }).then((c) => ((connected = true), c));
    const socket = await next();
    const [subprotocol, header] = socket.protocols as string[];
    assert.equal(subprotocol, "aws-appsync-event-ws");
    assert.deepEqual(JSON.parse(Buffer.from(header.slice("header-".length), "base64url").toString()), authorization);
    socket.open();
    assert.deepEqual(socket.sent.shift(), { type: "connection_init" });
    socket.receive({ type: "connection_ack", connectionTimeoutMs: 300000 });
    const subscribes = socket.sent.splice(0);
    assert.deepEqual(
      subscribes.map((s) => s.channel),
      ["/agentforeach/users/a/b", "/agentforeach/all"],
    );
    assert.ok(subscribes.every((s) => s.type === "subscribe" && s.authorization.Authorization === authorization.Authorization));
    socket.receive({ type: "subscribe_success", id: subscribes[0].id });
    await tick();
    assert.equal(connected, false, "not connected until every subscription is confirmed");
    socket.receive({ type: "subscribe_success", id: subscribes[1].id });
    (await pending).close();
  });

  it("delivers events, one at a time or in a list, and reassembles fragments up to 4 MiB", async () => {
    const { WebSocket, next } = fakeSockets();
    const received: unknown[] = [];
    const pending = connectRealtime(appsync(), { WebSocket, onMessage: (d) => received.push(d) });
    const socket = await next();
    await acceptAppSync(socket);
    const connection = await pending;
    socket.receive({ type: "data", id: "s0", event: JSON.stringify({ type: "event", event: "chat", seq: 1 }) });
    socket.receive({ type: "data", id: "s1", event: [JSON.stringify({ seq: 2 }), JSON.stringify({ seq: 3 })] });
    socket.receive({ type: "data", id: "not-ours", event: JSON.stringify({ seq: 4 }) });
    const big = { type: "event", event: "chat", payload: { state: "final", text: "語✓".repeat(400_000) } };
    const fragments = encodeFrame(big);
    assert.ok(fragments.length > 1);
    for (const fragment of fragments.reverse()) socket.receive({ type: "data", id: "s0", event: fragment });
    assert.deepEqual(received, [{ type: "event", event: "chat", seq: 1 }, { seq: 2 }, { seq: 3 }, big]);
    connection.close();
  });

  it("fails on an error frame, an invalid message or a missed keep-alive", async () => {
    const { WebSocket, next } = fakeSockets();
    const refused = connectRealtime(appsync(), { WebSocket });
    const first = await next();
    first.open();
    first.receive({ type: "connection_ack" });
    first.receive({ type: "subscribe_error", id: "s0", errors: [{ errorType: "UnauthorizedException" }] });
    await assert.rejects(refused, /AppSync refused/);

    const closes: Error[] = [];
    const pending = connectRealtime(appsync(), { WebSocket, onClose: (e) => closes.push(e) });
    const second = await next();
    await acceptAppSync(second);
    await pending;
    second.receive({ type: "data", id: "s0", event: JSON.stringify({ type: "afe-fragment", version: 1, id: "x", index: 3, count: 2, data: "" }) });
    assert.match(closes[0]?.message ?? "", /AppSync refused/, "a malformed fragment ends the connection");

    const quiet = connectRealtime(appsync(), { WebSocket, onClose: (e) => closes.push(e) });
    const third = await next();
    await acceptAppSync(third, 1000);
    await quiet;
    await tick(1200);
    assert.match(closes[1]?.message ?? "", /keep-alive/);
  });

  it("closes a client connection just before its token expires, so a reconnect renews it", async () => {
    const { WebSocket, next } = fakeSockets();
    const closes: Error[] = [];
    const pending = connectRealtime(appsync({ expiresAtMs: Date.now() + 5_050 }), { WebSocket, onClose: (e) => closes.push(e) });
    await acceptAppSync(await next());
    await pending;
    await tick(150);
    assert.match(closes[0]?.message ?? "", /expired; reconnect/);
  });

  it("a relay subscribes to its own channel, publishes to its peer's, and stamps the peer as the sender", async () => {
    const { WebSocket, next } = fakeSockets();
    const heard: Array<[unknown, string]> = [];
    const descriptor = appsync({ channels: ["/agentforeach-browser/h/bh-1/viewer"], publish: "/agentforeach-browser/h/bh-1/driver", expiresAtMs: Date.now() + 60_000 });
    const pending = connectRelay(descriptor, { WebSocket, group: "bh-1", peerUserId: "browser-driver:ab", onMessage: (d, from) => heard.push([d, from]) });
    const socket = await next();
    await acceptAppSync(socket);
    const relay = await pending;
    socket.receive({ type: "data", id: "s0", event: JSON.stringify({ kind: "frame", seq: 7 }) });
    assert.deepEqual(heard, [[{ kind: "frame", seq: 7 }, "browser-driver:ab"]]);

    assert.equal(relay.send({ kind: "key", type: "down", key: "a" }), true);
    const publish = socket.sent.shift();
    assert.deepEqual(publish, {
      type: "publish",
      id: publish.id,
      channel: "/agentforeach-browser/h/bh-1/driver",
      events: [JSON.stringify({ kind: "key", type: "down", key: "a" })],
      authorization,
    });
    assert.ok(relay.bufferedAmount > 0, "unacknowledged until AppSync answers");
    socket.receive({ type: "publish_success", id: publish.id, successful: [{ identifier: "x", index: 0 }], failed: [] });
    assert.equal(relay.bufferedAmount, 0);

    // A screen frame over the relay's event size goes as fragments the peer reassembles.
    const frame = { kind: "frame", seq: 8, jpeg: "A".repeat(300_000) };
    assert.equal(relay.send(frame, { droppable: true }), true);
    const parts = socket.sent.splice(0);
    assert.equal(parts.length, Math.ceil(JSON.stringify(frame).length / 64_000));
    const decode = createFrameDecoder();
    let whole;
    for (const part of parts) {
      assert.ok(Buffer.byteLength(JSON.stringify(part)) < 100_000);
      whole = decode(part.events[0]);
    }
    assert.deepEqual(whole, frame);
    relay.close();
  });

  it("a congested relay drops what may be dropped, and ends rather than drop input", async () => {
    const { WebSocket, next } = fakeSockets();
    const closes: Error[] = [];
    const descriptor = appsync({ channels: ["/ns/h/g/a"], publish: "/ns/h/g/b", expiresAtMs: Date.now() + 60_000 });
    const pending = connectRelay(descriptor, { WebSocket, group: "g", peerUserId: "b", onClose: (e) => closes.push(e) });
    const socket = await next();
    await acceptAppSync(socket);
    const relay = await pending;
    for (let i = 0; i < 80; i++) assert.equal(relay.send({ kind: "mouse", i }), true);
    assert.equal(relay.send({ kind: "frame", seq: 1 }, { droppable: true }), false, "a frame waits for the next one");
    assert.equal(closes.length, 0);
    assert.equal(relay.send({ kind: "key", type: "down", key: "Enter" }), false);
    assert.match(closes[0]?.message ?? "", /congested/, "never a click dropped silently");
  });

  it("a relay gives up on a publish nobody answers, or one AppSync rejects", async () => {
    const { WebSocket, next } = fakeSockets();
    const closes: Error[] = [];
    const descriptor = appsync({ channels: ["/ns/h/g/a"], publish: "/ns/h/g/b", expiresAtMs: Date.now() + 60_000 });
    const pending = connectRelay(descriptor, { WebSocket, group: "g", peerUserId: "b", publishTimeoutMs: 30, onClose: (e) => closes.push(e) });
    await acceptAppSync(await next());
    (await pending).send({ kind: "hello" });
    await tick(80);
    assert.match(closes[0]?.message ?? "", /timed out/);

    const again = connectRelay(descriptor, { WebSocket, group: "g", peerUserId: "b", onClose: (e) => closes.push(e) });
    const socket = await next();
    await acceptAppSync(socket);
    (await again).send({ kind: "hello" });
    const { id } = socket.sent.shift();
    socket.receive({ type: "publish_success", id, successful: [], failed: [{ index: 0, code: 401 }] });
    assert.match(closes[1]?.message ?? "", /AppSync refused/);
  });

  it("refuses descriptors it can't use", async () => {
    const { WebSocket } = fakeSockets();
    const relay = { WebSocket, group: "g", peerUserId: "p" };
    for (const descriptor of [
      { protocol: "mqtt", url: "wss://x.example" },
      { protocol: "v1", url: "https://x.example" },
      { protocol: "v1", url: "wss://user:pass@x.example" },
      appsync({ channels: [] }),
      appsync({ authorization: { host: "", Authorization: "t" } }),
    ] as ConnectionDescriptor[]) {
      await assert.rejects(connectRealtime(descriptor, { WebSocket }));
    }
    await assert.rejects(connectRelay(appsync({ channels: ["/ns/a"] }), relay), /Invalid AppSync/, "a relay must have its peer's channel");
    await assert.rejects(connectRelay(appsync({ channels: ["/ns/a"], publish: "/ns/a" }), relay), /Invalid AppSync/);
    await assert.rejects(connectRelay({ protocol: "v1", url: "wss://x.example" }, { WebSocket, group: "", peerUserId: "p" }), /group and peer/);
  });
});

describe("portable realtime client: frames", () => {
  it("sends a frame whole when it fits, and as fragments when it doesn't", () => {
    assert.deepEqual(encodeFrame({ a: 1 }), ['{"a":1}']);
    const fragments = encodeFrame({ text: "x".repeat(200 * 1024) }, { id: "f1" }).map((f) => JSON.parse(f));
    assert.equal(fragments.length, 2);
    assert.deepEqual(
      fragments.map((f) => [f.type, f.version, f.id, f.index, f.count]),
      [
        ["afe-fragment", 1, "f1", 0, 2],
        ["afe-fragment", 1, "f1", 1, 2],
      ],
    );
    assert.throws(() => encodeFrame({ text: "x".repeat(4 * 1024 * 1024) }), /exceeds 4 MiB/);
  });

  it("reassembles in any order, once per fragment, and refuses what doesn't add up", () => {
    const decode = createFrameDecoder();
    const frame = { text: "ünïcødé ".repeat(40_000) };
    const [first, ...rest] = encodeFrame(frame);
    assert.ok(rest.length >= 2);
    for (const fragment of rest.reverse()) assert.equal(decode(fragment), undefined);
    assert.equal(decode(rest[0]), undefined, "a repeated fragment is the same fragment");
    assert.deepEqual(decode(first), frame);

    const bad = (patch: Record<string, unknown>) => JSON.stringify({ type: "afe-fragment", version: 1, id: "i", index: 0, count: 2, data: "", ...patch });
    for (const patch of [{ version: 2 }, { count: 67 }, { index: 2 }, { index: -1 }, { id: "x".repeat(129) }, { data: "A".repeat(164_001) }]) {
      assert.throws(() => createFrameDecoder()(bad(patch)), /Invalid realtime fragment/);
    }
    const mixed = createFrameDecoder();
    mixed(bad({ count: 2 }));
    assert.throws(() => mixed(bad({ count: 3, index: 1 })), /Inconsistent/);
    const crowded = createFrameDecoder();
    for (const id of ["1", "2", "3", "4"]) crowded(bad({ id }));
    assert.throws(() => crowded(bad({ id: "5" })), /Too many incomplete/);
  });

  it("refuses a reassembled frame over 4 MiB", () => {
    const decode = createFrameDecoder();
    const chunk = Buffer.alloc(120 * 1024, 65).toString("base64");
    assert.throws(() => {
      for (let index = 0; index < 36; index++) decode({ type: "afe-fragment", version: 1, id: "big", index, count: 36, data: chunk });
    }, /exceeds 4 MiB/);
  });
});

describe("portable realtime client: staying connected", () => {
  it("backs off exponentially, jittered, and never past the cap", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const ceiling = Math.min(30_000, 500 * 2 ** (attempt - 1));
      for (let i = 0; i < 20; i++) {
        const delay = backoffDelay(attempt);
        assert.ok(delay >= ceiling / 2 && delay <= ceiling, `attempt ${attempt}: ${delay}`);
      }
    }
  });

  it("reconnects with a fresh descriptor after a drop, and stops when closed", async () => {
    const { WebSocket, next } = fakeSockets();
    const states: string[] = [];
    let issued = 0;
    const live = keepConnected({
      WebSocket,
      access: async () => ({ protocol: "v1", url: `wss://hub.example/c?access_token=${++issued}` }),
      onState: (state) => states.push(state),
      minDelayMs: 10,
      maxDelayMs: 20,
    });
    const first = await next();
    first.open();
    first.receive({ type: "system", event: "connected" });
    await tick();
    first.close(); // the network drops it
    const second = await next();
    assert.match(second.url, /access_token=2$/, "a new token for the new connection");
    second.open();
    second.receive({ type: "system", event: "connected" });
    await tick();
    live.close();
    await tick(50);
    assert.deepEqual(states, ["connecting", "open", "retrying", "connecting", "open", "closed"]);
  });

  it("gives up after maxAttempts failures in a row", async () => {
    const states: string[] = [];
    keepConnected({
      access: async () => {
        throw new Error("401");
      },
      onState: (state) => states.push(state),
      minDelayMs: 1,
      maxDelayMs: 2,
      maxAttempts: 2,
    });
    await tick(50);
    assert.deepEqual(states, ["connecting", "retrying", "connecting", "retrying", "connecting", "closed"]);
  });
});

describe("portable realtime client: the generated module", () => {
  it("is the same client, as an ES module with no imports", async () => {
    const source = realtimeClientModule();
    assert.ok(!/^\s*import\s/m.test(source), "no imports");
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    assert.deepEqual(Object.keys(mod).sort(), Object.keys(defineRealtimeClient()).filter((k) => k !== "MAX_FRAME_BYTES").sort());
    assert.deepEqual(mod.encodeFrame({ a: 1 }), ['{"a":1}']);
  });
});
