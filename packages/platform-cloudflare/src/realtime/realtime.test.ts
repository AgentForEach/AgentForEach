import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REALTIME_SUBPROTOCOL, roles, sealRealtimeToken, openRealtimeToken } from "@agentforeach/platform";
import { CONNECTION_HEADER, HubHost, type HibernatableSocket } from "./hub-host.js";
import { CloudflareRealtime, handleRealtimeUpgrade, type ObjectNamespace, type UserSocketRpc } from "./provider.js";

const KEY = "test-signing-key";

/** A namespace that records which object each call went to. */
function namespace<T>(make: (name: string) => T) {
  const calls: Array<{ name: string; request?: Request }> = [];
  const ns: ObjectNamespace<T> = {
    idFromName: (name: string) => name,
    get: ((id: string) => ({
      ...make(id),
      fetch: async (request: Request) => {
        calls.push({ name: id, request });
        return new Response("upgraded", { status: 200 });
      },
    })) as never,
  };
  return { ns, calls };
}

function upgrade(path: string, token: string, extra: Record<string, string> = {}): Request {
  return new Request(`https://gw.example${path}?access_token=${token}`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": REALTIME_SUBPROTOCOL, ...extra },
  });
}

const token = (aud: string, sub: string, role: string[], hub = "agentforeach", jti: string | undefined = crypto.randomUUID()) =>
  sealRealtimeToken({ sub, aud, hub, role, exp: Math.floor(Date.now() / 1000) + 60, ...(jti ? { jti } : {}) }, KEY);

describe("cloudflare realtime: upgrade router", () => {
  const users = namespace(() => ({}));
  const relays = namespace(() => ({}));
  const options = { userSockets: users.ns, relays: relays.ns, signingKey: KEY };

  it("leaves other paths to the Worker's router", async () => {
    assert.equal(await handleRealtimeUpgrade(new Request("https://gw.example/api/chat"), options), undefined);
  });

  it("refuses a bad token, and sends any request with a valid one to its object, which spends the URL", async () => {
    const t = await token("/realtime/client", "u1", []);
    const before = users.calls.length;
    // Not upgrades: the object redeems the ticket, then refuses them (426), so a URL refused this way is spent.
    await handleRealtimeUpgrade(new Request(`https://gw.example/realtime/client?access_token=${t}`), options);
    await handleRealtimeUpgrade(upgrade("/realtime/client", t, { "Sec-WebSocket-Protocol": "graphql-ws" }), options);
    assert.equal(users.calls.length, before + 2, "both reached the object");
    assert.equal((await handleRealtimeUpgrade(upgrade("/realtime/client", "nope"), options))?.status, 401);
    assert.equal((await handleRealtimeUpgrade(upgrade("/realtime/relay", t), options))?.status, 401, "a client token is not a relay token");
  });

  it("routes a client to its user's object, with the verified identity overriding anything the client sent", async () => {
    const t = await token("/realtime/client", "u1", ["webpubsub.joinLeaveGroup.cron"]);
    const forged = JSON.stringify({ userId: "admin", roles: ["webpubsub.sendToGroup"] });
    await handleRealtimeUpgrade(upgrade("/realtime/client", t, { [CONNECTION_HEADER]: forged }), options);
    const call = users.calls.at(-1)!;
    assert.equal(call.name, "agentforeach:u1");
    const verified = JSON.parse(call.request!.headers.get(CONNECTION_HEADER)!);
    assert.deepEqual({ userId: verified.userId, roles: verified.roles }, { userId: "u1", roles: ["webpubsub.joinLeaveGroup.cron"] });
    assert.equal(typeof verified.ticket.id, "string");
    assert.equal(verified.ticket.resumeMs, 0, "a client URL connects once");
    assert.equal(new URL(call.request!.url).searchParams.has("access_token"), false, "the token stays out of the object's URL");
  });

  it("refuses forged, tampered, unsigned and expired tokens before reaching any object", async () => {
    const before = users.calls.length + relays.calls.length;
    const good = await token("/realtime/client", "u1", []);
    const claims = (await openRealtimeToken(good, KEY, "/realtime/client"))!;
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const forged = [
      good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA"),
      good.slice(0, 20) + (good[20] === "A" ? "B" : "A") + good.slice(21),
      good.slice(0, -10),
      `${enc({ alg: "none", typ: "JWT" })}.${enc({ ...claims, sub: "admin" })}.`,
      await sealRealtimeToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }, KEY),
      await sealRealtimeToken(claims, "another-deployments-key"),
      await sealRealtimeToken({ ...claims, aud: "/realtime/relay" }, KEY),
    ];
    for (const t of forged) {
      assert.equal((await handleRealtimeUpgrade(upgrade("/realtime/client", t), options))?.status, 401, t);
    }
    assert.equal(users.calls.length + relays.calls.length, before, "no object was reached");
  });

  it("refuses a token without a ticket id", async () => {
    const t = await token("/realtime/client", "u1", [], "agentforeach", "");
    assert.equal((await handleRealtimeUpgrade(upgrade("/realtime/client", t), options))?.status, 401);
  });

  it("routes a relay token to its one group's object", async () => {
    const t = await token("/realtime/relay", "browser-driver:ab", [roles.joinLeaveGroup("bh-1"), roles.sendToGroup("bh-1")], "agentforeach_browser");
    await handleRealtimeUpgrade(upgrade("/realtime/relay", t), options);
    assert.equal(relays.calls.at(-1)!.name, "agentforeach_browser:bh-1");
    assert.equal(JSON.parse(relays.calls.at(-1)!.request!.headers.get(CONNECTION_HEADER)!).ticket.resumeMs, 30_000, "a relay URL may reconnect right after it closed");
    const two = await token("/realtime/relay", "x", [roles.joinLeaveGroup("a"), roles.joinLeaveGroup("b")]);
    assert.equal((await handleRealtimeUpgrade(upgrade("/realtime/relay", two), options))?.status, 401);
  });
});

describe("cloudflare realtime: provider", () => {
  const pushed: Array<{ name: string; data: unknown }> = [];
  const users = namespace<UserSocketRpc>((name) => ({
    sendToUser: (data: unknown) => (pushed.push({ name, data }), 1),
    isOnline: () => name.endsWith(":online"),
    disconnect: () => 0,
  }));
  const provider = new CloudflareRealtime({
    userSockets: users.ns,
    relays: namespace(() => ({})).ns,
    signingKey: KEY,
    publicBaseUrl: "https://gw.example",
    hub: "agentforeach",
  });

  it("pushes and asks presence through the user's object", async () => {
    await provider.sendToUser("u1", { type: "event", event: "chat" });
    assert.deepEqual(pushed, [{ name: "agentforeach:u1", data: { type: "event", event: "chat" } }]);
    assert.equal(await provider.isUserOnline("online"), true);
    assert.equal(await provider.isUserOnline("u2"), false);
  });

  it("issues URLs that say nothing about their user", async () => {
    const access = await provider.clientAccess("alice@example.com", { ttlMinutes: 5 });
    const { url } = await provider.relay.groupAccess({ hub: "agentforeach_browser", userId: "alice@example.com", group: "bh-9", ttlMinutes: 5 });
    for (const u of [access.url, url]) {
      const readable = `${u} ${Buffer.from(new URL(u).searchParams.get("access_token")!.slice(3), "base64url").toString("latin1")}`;
      for (const part of ["alice", "example.com", "bh-9", "webpubsub"]) assert.ok(!readable.includes(part), `${part} in ${u}`);
    }
  });

  it("issues client and relay URLs on the Worker's origin with verifiable tokens", async () => {
    const access = await provider.clientAccess("u1", { ttlMinutes: 60, groups: ["cron"], roles: ["webpubsub.joinLeaveGroup.cron"] });
    assert.match(access.url, /^wss:\/\/gw\.example\/realtime\/client\?access_token=/);
    const claims = await openRealtimeToken(access.token, KEY, "/realtime/client");
    assert.deepEqual([claims?.sub, claims?.hub, claims?.groups, claims?.role], ["u1", "agentforeach", ["cron"], ["webpubsub.joinLeaveGroup.cron"]]);
    const again = await provider.clientAccess("u1", { ttlMinutes: 60 });
    assert.notEqual((await openRealtimeToken(again.token, KEY, "/realtime/client"))?.jti, claims?.jti, "every URL is its own ticket");
    assert.equal(provider.relay.host, "gw.example");
    const { url } = await provider.relay.groupAccess({ hub: "agentforeach_browser", userId: "v", group: "bh-2", ttlMinutes: 5 });
    const relayClaims = await openRealtimeToken(new URL(url).searchParams.get("access_token")!, KEY, "/realtime/relay");
    assert.deepEqual(relayClaims?.role, ["webpubsub.joinLeaveGroup.bh-2", "webpubsub.sendToGroup.bh-2"]);
    assert.equal(new URL(url).protocol, "wss:");
  });

  it("needs a signing key", () => {
    assert.throws(() => new CloudflareRealtime({ userSockets: users.ns, relays: users.ns, signingKey: "", publicBaseUrl: "https://x", hub: "h" }), /REALTIME_SIGNING_KEY/);
  });
});

describe("cloudflare realtime: hub host over hibernatable sockets", () => {
  function sockets() {
    const all: Array<HibernatableSocket & { sent: unknown[]; attachment: unknown; readyState: number; tags?: string[] }> = [];
    const state = {
      acceptWebSocket: (ws: never, tags?: string[]) => {
        (ws as { tags?: string[] }).tags = tags;
        all.push(ws);
      },
      getWebSockets: () => all,
    };
    const make = () => ({
      sent: [] as unknown[],
      attachment: null as unknown,
      readyState: 1,
      send(m: string) {
        this.sent.push(JSON.parse(m));
      },
      close() {
        this.readyState = 3;
      },
      serializeAttachment(v: unknown) {
        this.attachment = structuredClone(v);
      },
      deserializeAttachment() {
        return this.attachment;
      },
    });
    return { state, make, all };
  }

  it("keeps each socket's protocol state in its attachment, so hibernation loses nothing", async () => {
    const { state, make } = sockets();
    const a = make();
    const b = make();
    new HubHost(state).accept(a, { userId: "driver", roles: [roles.joinLeaveGroup("g"), roles.sendToGroup("g")] });
    new HubHost(state).accept(b, { userId: "viewer", roles: [roles.joinLeaveGroup("g"), roles.sendToGroup("g")] });
    assert.equal((a.sent[0] as { event: string }).event, "connected");

    // A fresh HubHost per frame, as after the object wakes from hibernation.
    await new HubHost(state).message(a, JSON.stringify({ type: "joinGroup", group: "g" }));
    await new HubHost(state).message(b, JSON.stringify({ type: "joinGroup", group: "g" }));
    await new HubHost(state).message(b, JSON.stringify({ type: "sendToGroup", group: "g", dataType: "json", noEcho: true, data: { kind: "hello" } }));
    assert.deepEqual(a.sent.at(-1), { type: "message", from: "group", fromUserId: "viewer", group: "g", dataType: "json", data: { kind: "hello" } });
    assert.equal(b.sent.length, 1, "noEcho");
  });

  it("ignores binary frames and sockets that are closing", async () => {
    const { state, make } = sockets();
    const a = make();
    const host = new HubHost(state);
    host.accept(a, { userId: "u", roles: [] });
    await host.message(a, new ArrayBuffer(4));
    assert.equal(a.sent.length, 1);
    assert.equal(host.hub.isUserOnline("u"), true);
    a.readyState = 2;
    assert.equal(host.hub.isUserOnline("u"), false);
  });
});
