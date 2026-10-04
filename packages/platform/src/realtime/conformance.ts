/**
 * AgentForEach Platform — Realtime conformance suite
 *
 * Drives real protocol v1 clients against a provider, so a provider that
 * passes it can carry web-chat, the browser live view and the sandbox's
 * browser driver unchanged.
 *
 * ```ts
 * import { runRealtimeConformance, webSocketTestClient } from "@agentforeach/platform/realtime/conformance";
 *
 * runRealtimeConformance({
 *   name: "cloudflare (wrangler dev)",
 *   createProvider: () => provider,
 *   connect: webSocketTestClient,
 *   inboundEvents: true,
 * });
 * ```
 *
 * With `inboundEvents`, the provider's client hub must answer an `event`
 * frame by replying `{ echo: data, event, userId }`, and throw when the data
 * is `{ fail: true }` (the harness wires that handler); otherwise those
 * tests are skipped.
 */

import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";
import type { Frame, RealtimeTestClient } from "./testing.js";
import type { RealtimeTokenClaims } from "./token.js";
import type { RealtimeProvider } from "./types.js";

export { webSocketTestClient, FrameQueue, type RealtimeTestClient, type Frame } from "./testing.js";

export type RealtimeConformanceOptions = {
  name: string;
  createProvider: () => RealtimeProvider | Promise<RealtimeProvider>;
  /** Opens a client on a URL from `clientAccess` or `relay.groupAccess`. */
  connect: (url: string) => Promise<RealtimeTestClient>;
  /** The client hub echoes `event` frames (see above). */
  inboundEvents?: boolean;
  /** How long presence may take to settle after a connect or close. Default 3000 ms. */
  settleMs?: number;
  /** How long to wait before concluding that no frame is coming. Default 500 ms. */
  quietMs?: number;
  /**
   * The provider issues one-time URLs (self-hosted providers; Web PubSub's
   * tokens are reusable until they expire): a client URL connects once, and
   * a relay URL has one connection at a time and may reconnect only shortly
   * after it closed.
   */
  oneTimeUrls?: boolean;
  /**
   * The provider honours a token lifetime of a few seconds, so expiry can be
   * checked without waiting a minute. Default true.
   */
  shortTokenTtl?: boolean;
  /**
   * For providers whose tokens the harness can mint (self-hosted ones):
   * seal `claims` with the provider's own key or with another one, so the
   * suite can check that a token sealed properly but with the wrong key,
   * or for the wrong audience, is refused. `hub` is the client hub's name.
   */
  tokens?: { hub: string; seal: (claims: RealtimeTokenClaims, key: "provider" | "other") => Promise<string> };
};

// ── Forged tokens ───────────────────────────────────────────────────────
// Mutations of a real access token, to check that a provider refuses every
// token it didn't issue exactly as issued. JWT-shaped tokens are also
// re-signed and tampered with field by field; any other token is flipped.

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const unb64 = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** `url` with its access token replaced by `mutate(token)`. */
function withToken(url: string, mutate: (token: string) => string): string {
  const u = new URL(url);
  u.searchParams.set("access_token", mutate(u.searchParams.get("access_token") ?? ""));
  return u.toString();
}

/** Change one character of `text` at `index` (from the end when negative). */
function flip(text: string, index: number): string {
  const i = index < 0 ? text.length + index : index;
  const c = text[i] === "A" ? "B" : "A";
  return text.slice(0, i) + c + text.slice(i + 1);
}

function isJwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    return typeof unb64(parts[0]).alg === "string";
  } catch {
    return false;
  }
}

/** The claims changed by `change`, the original signature kept (or, for an opaque token, a flipped byte). */
function tamperClaims(token: string, change: (claims: Record<string, unknown>) => void): string {
  if (!isJwt(token)) return flip(token, Math.floor(token.length / 2));
  const [header, payload, signature] = token.split(".");
  const claims = unb64(payload);
  change(claims);
  return `${header}.${b64(claims)}.${signature}`;
}

/** The same claims, signed HS256 with a key the provider doesn't have. */
function resignWithOtherKey(token: string): string {
  if (!isJwt(token)) return flip(token, 5);
  const [header, payload] = token.split(".");
  const signature = createHmac("sha256", "not-the-providers-key").update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** The same claims, unsigned (`alg: none`). */
function unsigned(token: string): string {
  const payload = isJwt(token) ? token.split(".")[1] : b64({ sub: "anyone" });
  return `${b64({ alg: "none", typ: "JWT" })}.${payload}.`;
}

const isConnected = (f: Frame): boolean => f?.type === "system" && f.event === "connected";
const isAck = (ackId: number) => (f: Frame): boolean => f?.type === "ack" && f.ackId === ackId;
const fromGroup = (f: Frame): boolean => f?.type === "message" && f.from === "group";
const fromServer = (f: Frame): boolean => f?.type === "message" && f.from === "server";

async function eventually(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function runRealtimeConformance(options: RealtimeConformanceOptions): void {
  const settleMs = options.settleMs ?? 3000;
  const quietMs = options.quietMs ?? 500;

  describe(`realtime conformance: ${options.name}`, () => {
    let provider: RealtimeProvider;
    const user = (): string => `conf-${randomUUID().slice(0, 12)}`;
    const open = async (userId: string): Promise<RealtimeTestClient> => {
      const access = await provider.clientAccess(userId, { ttlMinutes: 5 });
      assert.ok(access.expiresAtMs > Date.now());
      const client = await options.connect(access.url);
      const connected = await client.next(isConnected);
      assert.equal(connected.userId, userId);
      assert.equal(typeof connected.connectionId, "string");
      return client;
    };

    /** `url` must not connect. A connection that does is closed, so a failing provider fails fast instead of hanging. */
    const refused = async (url: string, what: string): Promise<void> => {
      let client: RealtimeTestClient;
      try {
        client = await options.connect(url);
      } catch {
        return;
      }
      client.close();
      assert.fail(`accepted: ${what}`);
    };

    before(async () => {
      provider = await options.createProvider();
    });

    describe("client hub", () => {
      it("greets a connection with its user id", async () => {
        const client = await open(user());
        client.close();
      });

      it("delivers sendToUser to every connection of that user, and only that user", async () => {
        const alice = user();
        const [a1, a2, b] = [await open(alice), await open(alice), await open(user())];
        const event = { type: "event", event: "chat", payload: { state: "delta", text: "hé ✓" }, seq: 1 };
        await provider.sendToUser(alice, event);
        for (const client of [a1, a2]) {
          assert.deepEqual(await client.next(fromServer), { type: "message", from: "server", dataType: "json", data: event });
        }
        assert.deepEqual(await b.collect(quietMs, fromServer), []);
        for (const c of [a1, a2, b]) c.close();
      });

      it("reports presence", async () => {
        const id = user();
        assert.equal(await provider.isUserOnline(id), false);
        const client = await open(id);
        await eventually(() => provider.isUserOnline(id), settleMs, "the user to be online");
        client.close();
        await client.closed;
        await eventually(async () => !(await provider.isUserOnline(id)), settleMs, "the user to be offline");
      });

      it("disconnects a user, saying why", async () => {
        const id = user();
        const client = await open(id);
        await provider.disconnectUser(id, "account deleted");
        const frame = await client.next((f) => f?.type === "system" && f.event === "disconnected");
        assert.equal(frame.message, "account deleted", "the reason given is the reason sent");
        await client.closed;
      });

      it("ignores sendToUser for a user with no connections", async () => {
        await provider.sendToUser(user(), { type: "event", event: "chat", payload: {} });
      });

      if (options.oneTimeUrls) {
        it("connects once per client URL, so a URL seen in a log is already spent", async () => {
          const access = await provider.clientAccess(user(), { ttlMinutes: 5 });
          const first = await options.connect(access.url);
          await first.next(isConnected);
          await refused(access.url, "a second connection while the first is open");
          first.close();
          await first.closed;
          await refused(access.url, "a client URL after its connection closed");
        });
      }

      if (options.inboundEvents) {
        it("answers an event with a server message, then the ack", async () => {
          const id = user();
          const client = await open(id);
          client.send({ type: "event", event: "message", ackId: 7, dataType: "json", data: { type: "ping" } });
          const reply = await client.next(fromServer);
          assert.deepEqual(reply.data, { echo: { type: "ping" }, event: "message", userId: id });
          assert.deepEqual(await client.next(isAck(7)), { type: "ack", ackId: 7, success: true });
          client.close();
        });

        it("acks InternalServerError, with no reply, when the handler fails", async () => {
          const client = await open(user());
          client.send({ type: "event", event: "message", ackId: 8, dataType: "json", data: { fail: true } });
          const ack = await client.next(isAck(8));
          assert.equal(ack.success, false);
          assert.equal(ack.error?.name, "InternalServerError");
          assert.deepEqual(await client.collect(quietMs, fromServer), [], "no reply for a failed event");
          client.close();
        });
      }
    });

    describe("token authentication", () => {
      it("refuses client tokens it didn't issue exactly as issued", async () => {
        const victim = user();
        const { url } = await provider.clientAccess(victim, { ttlMinutes: 5 });
        const token = new URL(url).searchParams.get("access_token") ?? "";
        // JWT-shaped tokens are tampered with field by field; opaque (sealed) ones byte by byte.
        const forgeries: Array<[string, string]> = isJwt(token)
          ? [
              ["a JWT with a changed signature", withToken(url, (t) => flip(t, -2))],
              ["a JWT whose claims changed under the original signature", withToken(url, (t) => tamperClaims(t, (c) => (c.sub = "someone-else")))],
              ["a JWT with a later expiry under the original signature", withToken(url, (t) => tamperClaims(t, (c) => (c.exp = Number(c.exp) + 86_400)))],
              ["a JWT re-signed with another key", withToken(url, resignWithOtherKey)],
            ]
          : [
              ["a changed byte near the end", withToken(url, (t) => flip(t, -2))],
              ["a changed byte in the middle", withToken(url, (t) => flip(t, Math.floor(t.length / 2)))],
              ["a changed byte near the start", withToken(url, (t) => flip(t, 6))],
              ["a truncated token", withToken(url, (t) => t.slice(0, -8))],
            ];
        forgeries.push(
          ["an unsigned JWT (alg none)", withToken(url, unsigned)],
          ["garbage", withToken(url, () => "nope")],
          ["no token", withToken(url, () => "")],
        );
        for (const [what, forged] of forgeries) await refused(forged, what);
        // The real URL still works: the refusals above didn't spend it.
        const client = await options.connect(url);
        assert.equal((await client.next(isConnected)).userId, victim);
        client.close();
      });

      it("refuses a properly sealed token under another key, or for another audience", async (t) => {
        if (!options.tokens) return t.skip("the harness can't mint tokens");
        const { url } = await provider.clientAccess(user(), { ttlMinutes: 5 });
        const claims = (aud: string): RealtimeTokenClaims => ({
          sub: user(),
          aud,
          hub: options.tokens!.hub,
          role: [],
          exp: Math.floor(Date.now() / 1000) + 300,
          jti: randomUUID(),
        });
        const own = await options.tokens.seal(claims("/realtime/client"), "provider");
        const control = await options.connect(withToken(url, () => own));
        await control.next(isConnected);
        control.close();
        const otherKey = await options.tokens.seal(claims("/realtime/client"), "other");
        await refused(withToken(url, () => otherKey), "a token sealed with another key");
        const relayToken = await options.tokens.seal(claims("/realtime/relay"), "provider");
        await refused(withToken(url, () => relayToken), "a relay token on the client URL");
      });

      it("refuses a relay token whose group was changed", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = `bh-${randomUUID().replace(/-/g, "")}`;
        const { url } = await provider.relay!.groupAccess({ hub: `conf_auth_${randomUUID().slice(0, 8)}`, userId: "viewer", group: g, ttlMinutes: 5 });
        const other = `bh-${randomUUID().replace(/-/g, "")}`;
        const forged = withToken(url, (t) =>
          tamperClaims(t, (c) => {
            c.role = (c.role as string[]).map((r) => r.replace(g, other));
          }),
        );
        await refused(forged, "a relay token for another group");
      });

      it("refuses an expired token", async (t) => {
        if (options.shortTokenTtl === false) return t.skip("no short-lived tokens");
        const access = await provider.clientAccess(user(), { ttlMinutes: 2 / 60 });
        assert.ok(access.expiresAtMs <= Date.now() + 3000, "the lifetime asked for is the one given");
        await new Promise((r) => setTimeout(r, Math.max(0, access.expiresAtMs - Date.now()) + 1500));
        await refused(access.url, "an expired token");
      });
    });

    describe("relay", () => {
      const relayHub = `conf_relay_${randomUUID().slice(0, 8)}`;
      const join = async (userId: string, group: string): Promise<RealtimeTestClient> => {
        assert.ok(provider.relay, "capabilities.relay requires relay");
        const { url } = await provider.relay.groupAccess({ hub: relayHub, userId, group, ttlMinutes: 5 });
        const client = await options.connect(url);
        await client.next(isConnected);
        return client;
      };
      const group = (): string => `bh-${randomUUID().replace(/-/g, "")}`;

      it("has a host", (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        assert.ok(provider.relay?.host);
      });

      it("stamps fromUserId from the sender's token, applies frames in order, and honours noEcho", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = group();
        const driver = await join("browser-driver:abc", g);
        const viewer = await join("viewer-user", g);
        // Neither side waits for its join ack before sending, as driver.mjs and viewer.ts don't.
        driver.send({ type: "joinGroup", group: g, ackId: 1 });
        viewer.send({ type: "joinGroup", group: g, ackId: 1 });
        viewer.send({ type: "sendToGroup", group: g, dataType: "json", noEcho: true, data: { kind: "hello", fromUserId: "browser-driver:abc" } });

        const hello = await driver.next(fromGroup);
        assert.deepEqual(hello, {
          type: "message",
          from: "group",
          fromUserId: "viewer-user",
          group: g,
          dataType: "json",
          data: { kind: "hello", fromUserId: "browser-driver:abc" },
        });
        assert.deepEqual(await viewer.collect(quietMs, fromGroup), [], "noEcho: the sender does not get its own message");

        driver.send({ type: "sendToGroup", group: g, dataType: "json", noEcho: true, data: { kind: "frame", seq: 1 } });
        const frame = await viewer.next(fromGroup);
        assert.equal(frame.fromUserId, "browser-driver:abc");
        assert.deepEqual(frame.data, { kind: "frame", seq: 1 });
        driver.close();
        viewer.close();
      });

      it("echoes to the sender without noEcho", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = group();
        const a = await join("a", g);
        a.send({ type: "joinGroup", group: g, ackId: 1 });
        await a.next(isAck(1));
        a.send({ type: "sendToGroup", group: g, dataType: "json", data: { n: 1 } });
        assert.equal((await a.next(fromGroup)).fromUserId, "a");
        a.close();
      });

      it("refuses groups the token doesn't grant, and never forwards there", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const [mine, theirs] = [group(), group()];
        const victim = await join("victim", theirs);
        victim.send({ type: "joinGroup", group: theirs, ackId: 1 });
        await victim.next(isAck(1));

        const intruder = await join("intruder", mine);
        intruder.send({ type: "joinGroup", group: theirs, ackId: 2 });
        const joinAck = await intruder.next(isAck(2));
        assert.equal(joinAck.success, false);
        assert.equal(joinAck.error?.name, "Forbidden");
        intruder.send({ type: "sendToGroup", group: theirs, ackId: 3, dataType: "json", data: { kind: "mouse" } });
        const sendAck = await intruder.next(isAck(3));
        assert.equal(sendAck.success, false);
        assert.equal(sendAck.error?.name, "Forbidden");
        assert.deepEqual(await victim.collect(quietMs, fromGroup), []);
        victim.close();
        intruder.close();
      });

      it("drops a forbidden frame silently when it has no ackId", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const [mine, theirs] = [group(), group()];
        const a = await join("a", mine);
        a.send({ type: "joinGroup", group: theirs });
        a.send({ type: "sendToGroup", group: theirs, dataType: "json", data: {} });
        a.send({ type: "joinGroup", group: mine, ackId: 9 });
        // The only answer is to the allowed frame that asked for one.
        assert.equal((await a.next(isAck(9))).success, true);
        assert.deepEqual(await a.collect(quietMs, (f) => f?.type === "ack"), []);
        a.close();
      });

      it("delivers to a group from a sender that hasn't joined it", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = group();
        const listener = await join("listener", g);
        listener.send({ type: "joinGroup", group: g, ackId: 1 });
        await listener.next(isAck(1));
        const sender = await join("sender", g);
        sender.send({ type: "sendToGroup", group: g, ackId: 2, dataType: "json", data: { n: 1 } });
        assert.equal((await sender.next(isAck(2))).success, true);
        assert.equal((await listener.next(fromGroup)).fromUserId, "sender");
        assert.deepEqual(await sender.collect(quietMs, fromGroup), [], "not a member, so not an echo");
        listener.close();
        sender.close();
      });

      it("stops delivering to a connection that left the group", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = group();
        const leaver = await join("leaver", g);
        const sender = await join("sender", g);
        leaver.send({ type: "joinGroup", group: g, ackId: 1 });
        await leaver.next(isAck(1));
        leaver.send({ type: "leaveGroup", group: g, ackId: 2 });
        assert.equal((await leaver.next(isAck(2))).success, true);
        sender.send({ type: "sendToGroup", group: g, dataType: "json", data: { n: 1 } });
        assert.deepEqual(await leaver.collect(quietMs, fromGroup), []);
        leaver.close();
        sender.close();
      });

      it("acks once per ackId and reports duplicates", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = group();
        const a = await join("a", g);
        a.send({ type: "joinGroup", group: g, ackId: 5 });
        assert.equal((await a.next(isAck(5))).success, true);
        a.send({ type: "joinGroup", group: g, ackId: 5 });
        const dup = await a.next(isAck(5));
        assert.equal(dup.success, false);
        assert.equal(dup.error?.name, "Duplicate");
        a.close();
      });

      it("keeps hubs apart", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = group();
        const a = await join("a", g);
        const { url } = await provider.relay!.groupAccess({ hub: `${relayHub}_other`, userId: "b", group: g, ttlMinutes: 5 });
        const b = await options.connect(url);
        await b.next(isConnected);
        a.send({ type: "joinGroup", group: g, ackId: 1 });
        b.send({ type: "joinGroup", group: g, ackId: 1 });
        await Promise.all([a.next(isAck(1)), b.next(isAck(1))]);
        a.send({ type: "sendToGroup", group: g, dataType: "json", noEcho: true, data: {} });
        assert.deepEqual(await b.collect(quietMs, fromGroup), []);
        a.close();
        b.close();
      });

      it("allows one connection per relay URL, and a reconnect right after it closed", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        if (!options.oneTimeUrls) return t.skip("reusable URLs");
        const g = group();
        const { url } = await provider.relay!.groupAccess({ hub: relayHub, userId: "viewer", group: g, ttlMinutes: 5 });
        const first = await options.connect(url);
        await first.next(isConnected);
        await refused(url, "a second connection with a relay URL while one is open");
        first.close();
        await first.closed;
        // A reload of the browser's live view reconnects with the same URL.
        const again = await options.connect(url);
        await again.next(isConnected);
        again.close();
      });

      it("never hands relay events to the gateway", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const a = await join("a", group());
        a.send({ type: "event", event: "message", dataType: "json", data: { type: "chat", message: "hi" } });
        assert.deepEqual(await a.collect(quietMs, fromServer), []);
        a.close();
      });

      it("closes a connection that sends a frame over 1 MiB", async (t) => {
        if (!provider.capabilities.relay) return t.skip("no relay");
        const g = group();
        const a = await join("a", g);
        a.send({ type: "sendToGroup", group: g, dataType: "text", data: "x".repeat(1024 * 1024 + 1) });
        const frame = await a.next((f) => f?.type === "system", quietMs * 10);
        assert.equal(frame.event, "disconnected", "told why before the close");
        await a.closed;
      });
    });
  });
}
