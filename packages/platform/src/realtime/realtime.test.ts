import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runRealtimeConformance } from "./conformance.js";
import { RealtimeHub, type ConnectionState, type HubConnection } from "./hub.js";
import { MemoryRealtime } from "./memory.js";
import { parseClientFrame, roles } from "./protocol.js";
import { sealRealtimeToken, openRealtimeToken } from "./token.js";

// The in-memory provider must pass the same suite as every cloud.
let memory: MemoryRealtime;
const MEMORY_SECRET = "memory-conformance-secret";
runRealtimeConformance({
  name: "memory",
  createProvider: () =>
    (memory = new MemoryRealtime({
      secret: MEMORY_SECRET,
      onEvent: async (e) => {
        if ((e.data as { fail?: boolean } | null)?.fail) throw new Error("conformance handler failed on purpose");
        return { reply: { echo: e.data, event: e.event, userId: e.userId } };
      },
    })),
  connect: (url) => memory.connect(url),
  inboundEvents: true,
  oneTimeUrls: true,
  quietMs: 50,
  tokens: { hub: "agentforeach", seal: (claims, key) => sealRealtimeToken(claims, key === "provider" ? MEMORY_SECRET : "another-key") },
});

describe("realtime protocol v1", () => {
  it("parses the client frames AgentForEach clients send", () => {
    assert.deepEqual(parseClientFrame('{"type":"joinGroup","group":"bh-1","ackId":1}'), { type: "joinGroup", group: "bh-1", ackId: 1 });
    assert.deepEqual(parseClientFrame('{"type":"sendToGroup","group":"g","dataType":"json","noEcho":true,"data":{"kind":"ping"}}'), {
      type: "sendToGroup",
      group: "g",
      noEcho: true,
      dataType: "json",
      data: { kind: "ping" },
    });
    assert.deepEqual(parseClientFrame('{"type":"event","event":"message","dataType":"json","data":{"type":"chat"}}'), {
      type: "event",
      event: "message",
      dataType: "json",
      data: { type: "chat" },
    });
  });

  it("ignores anything else", () => {
    for (const text of [
      "not json",
      "[]",
      '{"type":"joinGroup"}',
      '{"type":"joinGroup","group":""}',
      '{"type":"joinGroup","group":"g","ackId":-1}',
      '{"type":"joinGroup","group":"g","ackId":"1"}',
      '{"type":"sendToGroup","group":"g","dataType":"binary","data":"AA=="}',
      '{"type":"sendToGroup","group":"g","dataType":"text","data":{}}',
      '{"type":"sendToGroup","group":"g","dataType":"json"}',
      '{"type":"event","dataType":"json","data":1}',
      '{"type":"sendToUser","userId":"u","data":1}',
    ]) {
      assert.equal(parseClientFrame(text), undefined, text);
    }
  });
});

describe("realtime tokens", () => {
  const claims = { sub: "u1", aud: "/realtime/relay", hub: "h", role: [roles.sendToGroup("g")], exp: Math.floor(Date.now() / 1000) + 60 };

  it("verify only with the right key, audience and time", async () => {
    const token = await sealRealtimeToken(claims, "secret");
    assert.deepEqual(await openRealtimeToken(token, "secret", "/realtime/relay"), claims);
    assert.equal(await openRealtimeToken(token, "other", "/realtime/relay"), undefined);
    assert.equal(await openRealtimeToken(token, "secret", "/realtime/client"), undefined);
    assert.equal(await openRealtimeToken(token, "secret", "/realtime/relay", new Date(claims.exp * 1000)), undefined);
  });

  it("reject any changed byte, and anything not sealed by us", async () => {
    const token = await sealRealtimeToken(claims, "secret");
    // Every position, the last character included (its spare bits too: only the canonical spelling opens).
    for (let i = 3; i < token.length; i++) {
      const changed = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
      assert.equal(await openRealtimeToken(changed, "secret", "/realtime/relay"), undefined, `byte ${i}`);
    }
    const jwt = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    for (const other of [jwt, "a.b", "v1.", "v1.AAAA", token.slice(0, -4)]) {
      assert.equal(await openRealtimeToken(other, "secret", "/realtime/relay"), undefined, other);
    }
  });

  it("give every token its own key (a fresh salt), and refuse older formats and oversized input", async () => {
    const a = await sealRealtimeToken(claims, "secret");
    const b = await sealRealtimeToken(claims, "secret");
    assert.ok(a.startsWith("v2."));
    const salt = (t: string) => Buffer.from(t.slice(3), "base64url").subarray(0, 16).toString("hex");
    assert.notEqual(salt(a), salt(b), "a new salt, so a new key, per token");
    const v1 = `v1.${Buffer.from(new Uint8Array(80)).toString("base64url")}`;
    assert.equal(await openRealtimeToken(v1, "secret", "/realtime/relay"), undefined, "v1 is refused");
    assert.equal(await openRealtimeToken(`v2.${"A".repeat(9000)}`, "secret", "/realtime/relay"), undefined, "oversized");
    assert.equal(await openRealtimeToken(`v2.${Buffer.from(new Uint8Array(44)).toString("base64url")}`, "secret", "/realtime/relay"), undefined, "too short");
  });

  it("accept only the canonical spelling of a token", async () => {
    // A token whose base64url has spare bits in its last character: setting them spells the same bytes differently.
    let token = "";
    for (let tries = 0; tries < 20 && Buffer.from((token = await sealRealtimeToken(claims, "secret")).slice(3), "base64url").length % 3 === 0; tries++);
    const body = token.slice(3);
    assert.notEqual(Buffer.from(body, "base64url").length % 3, 0, "found a token with spare bits");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(body.at(-1)!);
    const respelled = `v2.${body.slice(0, -1)}${alphabet[last | 1]}`;
    assert.notEqual(respelled, token);
    assert.deepEqual(Buffer.from(respelled.slice(3), "base64url"), Buffer.from(body, "base64url"), "the same bytes, spelled differently");
    assert.deepEqual(await openRealtimeToken(token, "secret", "/realtime/relay"), claims);
    assert.equal(await openRealtimeToken(respelled, "secret", "/realtime/relay"), undefined, "the other spelling is refused");
  });

  it("refuse an oversized token before any crypto", async () => {
    const subtle = crypto.subtle as unknown as Record<"importKey" | "deriveKey" | "decrypt", (...args: unknown[]) => Promise<unknown>>;
    const real = { importKey: subtle.importKey, deriveKey: subtle.deriveKey, decrypt: subtle.decrypt };
    let calls = 0;
    for (const name of ["importKey", "deriveKey", "decrypt"] as const) {
      subtle[name] = (...args: unknown[]) => (calls++, real[name].apply(crypto.subtle, args));
    }
    try {
      const token = await sealRealtimeToken(claims, `cap-${Math.random()}`);
      calls = 0;
      const oversized = token + "A".repeat(8192 - token.length + 1);
      assert.equal(oversized.length, 8193);
      assert.equal(await openRealtimeToken(oversized, "secret", "/realtime/relay"), undefined);
      assert.equal(calls, 0, "no key import, derivation or decryption for an oversized token");
    } finally {
      Object.assign(subtle, real);
    }
  });

  it("don't keep a failed key import, so the next call can succeed", async () => {
    const subtle = crypto.subtle as unknown as { importKey: (...args: unknown[]) => Promise<CryptoKey> };
    const real = subtle.importKey;
    let failures = 1;
    subtle.importKey = (...args: unknown[]) => (failures-- > 0 ? Promise.reject(new Error("transient")) : real.apply(crypto.subtle, args));
    try {
      const secret = `fresh-${Math.random()}`;
      await assert.rejects(sealRealtimeToken(claims, secret));
      const token = await sealRealtimeToken(claims, secret);
      assert.deepEqual(await openRealtimeToken(token, secret, "/realtime/relay"), claims);
    } finally {
      subtle.importKey = real;
    }
  });

  it("show nothing about the user to someone reading the URL", async () => {
    const token = await sealRealtimeToken({ ...claims, sub: "alice@example.com" }, "secret");
    const readable = [token, ...token.split(".").map((part) => {
      try {
        return Buffer.from(part, "base64url").toString("latin1");
      } catch {
        return "";
      }
    })].join(" ");
    for (const secretPart of ["alice", "example.com", "/realtime/relay", "webpubsub"]) {
      assert.ok(!readable.includes(secretPart), secretPart);
    }
    assert.notEqual(await sealRealtimeToken(claims, "secret"), await sealRealtimeToken(claims, "secret"), "a fresh IV each time");
  });
});

describe("realtime hub", () => {
  /** A hub over in-memory connections that record what they were sent and saved. */
  function setup() {
    const connections: Array<HubConnection & { sent: unknown[]; saves: number }> = [];
    const hub = new RealtimeHub({ connections: () => connections });
    const add = (state: ConnectionState) => {
      const c = {
        state,
        sent: [] as unknown[],
        saves: 0,
        save(s: ConnectionState) {
          this.state = s;
          this.saves++;
        },
        send(text: string) {
          this.sent.push(JSON.parse(text));
        },
        close() {},
      };
      connections.push(c);
      return c;
    };
    return { hub, add };
  }

  it("saves state after every change, so hibernated sockets lose nothing", async () => {
    const { hub, add } = setup();
    const c = add(RealtimeHub.initialState("u", "c1", [roles.joinLeaveGroup("g")]));
    await hub.receive(c, JSON.stringify({ type: "joinGroup", group: "g", ackId: 1 }));
    assert.deepEqual(c.state.groups, ["g"]);
    assert.deepEqual(c.state.acks, [1]);
    assert.ok(c.saves >= 2);
  });

  it("starts connections in the groups their token names", () => {
    assert.deepEqual(RealtimeHub.initialState("u", "c", [], ["a", "a", "b"]).groups, ["a", "b"]);
  });

  it("remembers a bounded number of ack ids", async () => {
    const { hub, add } = setup();
    const c = add(RealtimeHub.initialState("u", "c1", [roles.joinLeaveGroup()]));
    for (let i = 0; i < 100; i++) await hub.receive(c, JSON.stringify({ type: "joinGroup", group: "g", ackId: i }));
    assert.equal(c.state.acks.length, 64);
    assert.equal(c.state.acks[63], 99);
  });

  it("refuses events without a handler, and reports handler failures", async () => {
    const { hub, add } = setup();
    const c = add(RealtimeHub.initialState("u", "c1", []));
    await hub.receive(c, JSON.stringify({ type: "event", event: "message", ackId: 1, dataType: "json", data: {} }));
    assert.deepEqual(c.sent.at(-1), { type: "ack", ackId: 1, success: false, error: { name: "Forbidden", message: "This hub accepts no events" } });

    const failing = new RealtimeHub({ connections: () => [c], onEvent: async () => Promise.reject(new Error("boom")) });
    await failing.receive(c, JSON.stringify({ type: "event", event: "message", ackId: 2, dataType: "json", data: {} }));
    assert.deepEqual(c.sent.at(-1), { type: "ack", ackId: 2, success: false, error: { name: "InternalServerError", message: "boom" } });
  });
});

describe("realtime tickets", () => {
  it("redeem once; a resumable ticket reconnects only shortly after it closed, and never twice at once", async () => {
    const { TicketLedger, memoryTicketStorage } = await import("./tickets.js");
    let now = 1_000_000;
    const ledger = new TicketLedger(memoryTicketStorage(), () => now);
    const open = new Set<string>();
    const isOpen = (id: string) => open.has(id);
    const exp = now + 60_000;

    assert.equal(await ledger.redeem("client", exp, 0, isOpen), true);
    await ledger.closed("client");
    assert.equal(await ledger.redeem("client", exp, 0, isOpen), false, "a client ticket never resumes");

    assert.equal(await ledger.redeem("relay", exp, 30_000, isOpen), true);
    open.add("relay");
    assert.equal(await ledger.redeem("relay", exp, 30_000, isOpen), false, "not while it is open");
    open.delete("relay");
    await ledger.closed("relay");
    now += 10_000;
    assert.equal(await ledger.redeem("relay", exp, 30_000, isOpen), true, "a reload within the window");
    await ledger.closed("relay");
    now += 31_000;
    assert.equal(await ledger.redeem("relay", exp, 30_000, isOpen), false, "not after the window");
  });

  it("let only one of two simultaneous redemptions through", async () => {
    const { TicketLedger, memoryTicketStorage } = await import("./tickets.js");
    const ledger = new TicketLedger(memoryTicketStorage());
    const results = await Promise.all([1, 2, 3].map(() => ledger.redeem("t", Date.now() + 60_000, 0, () => false)));
    assert.deepEqual(results.filter(Boolean).length, 1);
  });

  it("forget expired tickets", async () => {
    const { TicketLedger, memoryTicketStorage } = await import("./tickets.js");
    const map = new Map<string, unknown>();
    let now = 0;
    const ledger = new TicketLedger(memoryTicketStorage(map), () => now);
    await ledger.redeem("old", 100, 0, () => false);
    now = 200;
    await ledger.redeem("new", 1000, 0, () => false);
    assert.deepEqual([...map.keys()], ["ticket:new"]);
  });
});
