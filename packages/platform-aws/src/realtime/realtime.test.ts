import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRealtimeFrameDecoder, openScope, resolveRealtimeCapabilities } from "@agentforeach/platform";
import {
  appSyncConfigFromEnv,
  appSyncRealtime,
  authorizeAppSyncEvent,
  createAppSyncAuthorizer,
  issueClientToken,
  issueRelayToken,
  relayChannel,
  userChannel,
  validateAppSyncConfig,
  AppSyncEventsRealtime,
  type AppSyncEventsConfig,
} from "./index.js";

const config: AppSyncEventsConfig = {
  apiId: "testapi",
  region: "us-east-1",
  namespace: "agentforeach",
  relayNamespace: "agentforeach-browser",
  httpEndpoint: "https://api.test/event",
  realtimeEndpoint: "wss://realtime.test/event/realtime",
  tokenSecret: "test-secret-only-32-bytes-at-least",
};
const credentials = { accessKeyId: "TEST", secretAccessKey: "TEST-SECRET", sessionToken: "TEMPORARY" };
const accepted = (): Response => Response.json({ successful: [{ index: 0, identifier: "id" }], failed: [] });

const subscribe = (token: string, channel: string, patch: Record<string, unknown> = {}) => ({
  authorizationToken: token,
  requestContext: { apiId: config.apiId, operation: "EVENT_SUBSCRIBE", channelNamespaceName: config.namespace, channel, ...patch },
});

describe("AppSync Events: subscriber tokens and the authorizer", () => {
  it("a client token subscribes to exactly its issued channels, at most for 60 minutes, and never publishes", () => {
    const now = Date.now();
    const token = issueClientToken(config, "user/alice", ["chat"], 1440, now);
    assert.equal(token.expiresAtMs - now, 3_600_000, "clamped to 60 minutes");
    assert.deepEqual(token.channels, [userChannel("agentforeach", "user/alice"), "/agentforeach/all", "/agentforeach/groups/chat"]);
    const own = subscribe(token.token, token.channels[0]);
    assert.deepEqual(authorizeAppSyncEvent(config, own, now), { isAuthorized: true, ttlOverride: 0 });
    assert.equal(authorizeAppSyncEvent(config, { ...own, requestContext: { apiId: config.apiId, operation: "EVENT_CONNECT" } }, now).isAuthorized, true);
    for (const patch of [
      { channel: userChannel("agentforeach", "bob") },
      { channel: "/agentforeach/*" },
      { channel: "/agentforeach/users/*" },
      { channel: "/agentforeach/groups/system" },
      { operation: "EVENT_PUBLISH" },
      { apiId: "other-api" },
      { channelNamespaceName: "other" },
      { channelNamespaceName: "agentforeach-browser" },
      { operation: "unknown" },
      { channel: null },
    ]) {
      assert.equal(authorizeAppSyncEvent(config, subscribe(token.token, token.channels[0], patch), now).isAuthorized, false, JSON.stringify(patch));
    }
    assert.ok(!token.channels[0].includes("alice"), "no user id in a channel name");
    assert.ok(token.channels[0].split("/").every((segment) => segment.length <= 50));
  });

  it("refuses an expired, tampered, re-signed, future-dated or overlong token", () => {
    const now = Date.now();
    const token = issueClientToken(config, "alice", [], 60, now);
    const event = subscribe(token.token, token.channels[0]);
    const decide = (t: string, at = now) => authorizeAppSyncEvent(config, { ...event, authorizationToken: t }, at).isAuthorized;
    assert.equal(decide(token.token, token.expiresAtMs), false, "expired");
    assert.equal(authorizeAppSyncEvent({ ...config, tokenSecret: "a-different-secret-of-32-bytes-or-more" }, event, now).isAuthorized, false);
    assert.equal(decide(`${token.token}.extra`), false);
    assert.equal(decide(token.token.replace(/^afe1\./, "afeb1.")), false, "a client token is not a relay token");
    assert.equal(decide("garbage"), false);
    assert.equal(decide(""), false);
    assert.equal(decide("x".repeat(9000)), false);

    const [domain, payload, mac] = token.token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forge = (change: (c: Record<string, unknown>) => void) => {
      const c = structuredClone(claims);
      change(c);
      return `${domain}.${Buffer.from(JSON.stringify(c)).toString("base64url")}.${mac}`;
    };
    assert.equal(decide(forge((c) => (c.channels as string[]).push(userChannel("agentforeach", "bob")))), false, "another user's channel added");
    assert.equal(decide(forge((c) => (c.expiresAtMs = Number(c.expiresAtMs) + 86_400_000))), false, "a later expiry");
    assert.equal(decide(`${domain}.${payload}.${mac.slice(0, -2)}AA`), false, "a changed signature");

    const future = issueClientToken(config, "alice", [], 60, now + 120_000);
    assert.equal(decide(future.token), false, "issued in the future, beyond clock skew");
  });

  it("a relay party subscribes to its own inbox and publishes only to its peer's, in the relay namespace", () => {
    const now = Date.now();
    const party = { hub: "agentforeach_browser", group: "bh-0123456789abcdef0123456789abcdef", ttlMinutes: 11 };
    const driver = issueRelayToken(config, { ...party, userId: "browser-driver:ab", peerUserId: "alice" }, now);
    const viewer = issueRelayToken(config, { ...party, userId: "alice", peerUserId: "browser-driver:ab" }, now);
    assert.equal(driver.subscribe, viewer.publish);
    assert.equal(driver.publish, viewer.subscribe);
    assert.equal(driver.subscribe, relayChannel("agentforeach-browser", party.hub, party.group, "browser-driver:ab"));
    const ctx = (operation: string, channel: string, ns = "agentforeach-browser") => ({ apiId: config.apiId, operation, channel, channelNamespaceName: ns });
    const allow = (token: string, operation: string, channel: string, ns?: string) =>
      authorizeAppSyncEvent(config, { authorizationToken: token, requestContext: ctx(operation, channel, ns) }, now).isAuthorized;
    assert.equal(allow(viewer.token, "EVENT_SUBSCRIBE", viewer.subscribe), true);
    assert.equal(allow(viewer.token, "EVENT_PUBLISH", viewer.publish), true);
    assert.equal(allow(viewer.token, "EVENT_PUBLISH", viewer.subscribe), false, "never into its own inbox: a message there is always the peer's");
    assert.equal(allow(viewer.token, "EVENT_SUBSCRIBE", viewer.publish), false, "never the peer's inbox");
    const other = issueRelayToken(config, { ...party, group: "bh-ffffffffffffffffffffffffffffffff", userId: "mallory", peerUserId: "x" }, now);
    assert.equal(allow(viewer.token, "EVENT_SUBSCRIBE", other.subscribe), false, "another handoff");
    assert.equal(allow(viewer.token, "EVENT_SUBSCRIBE", "/agentforeach-browser/*"), false);
    assert.equal(allow(viewer.token, "EVENT_SUBSCRIBE", viewer.subscribe, "agentforeach"), false, "not the chat namespace");
    assert.equal(allow(viewer.token, "EVENT_SUBSCRIBE", userChannel("agentforeach", "alice"), "agentforeach"), false);
    assert.equal(allow(viewer.token, "EVENT_SUBSCRIBE", viewer.subscribe), true);
    assert.equal(authorizeAppSyncEvent(config, { authorizationToken: viewer.token, requestContext: ctx("EVENT_SUBSCRIBE", viewer.subscribe) }, viewer.expiresAtMs).isAuthorized, false, "expired");
    assert.throws(() => issueRelayToken(config, { ...party, ttlMinutes: 45, userId: "a", peerUserId: "b" }), /at most 31 minutes/);
    assert.throws(() => issueRelayToken(config, { ...party, userId: "a", peerUserId: "a" }), /two parties/);
    assert.throws(() => issueRelayToken(config, { ...party, group: "bad/*", userId: "a", peerUserId: "b" }), /relay group/);
  });

  it("invalid endpoints, secrets, namespaces and lifetimes fail closed", () => {
    for (const patch of [
      { tokenSecret: "short" },
      { namespace: "bad/*" },
      { relayNamespace: "agentforeach" },
      { httpEndpoint: "http://api.test/event" },
      { realtimeEndpoint: "wss://user:password@realtime.test/event/realtime" },
      { httpEndpoint: "https://api.test/event?token=bad" },
      { realtimeEndpoint: "wss://realtime.test/graphql" },
      { apiId: "" },
      { region: "" },
    ]) {
      assert.throws(() => validateAppSyncConfig({ ...config, ...patch }), /AppSync Events/, JSON.stringify(patch));
    }
    for (const ttl of [0, -1, NaN, Infinity]) assert.throws(() => issueClientToken(config, "u", [], ttl));
  });

  it("the Lambda authorizer reads its settings from the environment, and denies everything when they are wrong", async () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        APPSYNC_HTTP_ENDPOINT: config.httpEndpoint,
        APPSYNC_REALTIME_ENDPOINT: config.realtimeEndpoint,
        APPSYNC_API_ID: config.apiId,
        APPSYNC_REGION: config.region,
        APPSYNC_TOKEN_SECRET: config.tokenSecret,
      });
      delete process.env.APPSYNC_NAMESPACE;
      delete process.env.APPSYNC_RELAY_NAMESPACE;
      assert.deepEqual(appSyncConfigFromEnv(), config);
      const token = issueClientToken(config, "alice", [], 60);
      assert.deepEqual(await createAppSyncAuthorizer()(subscribe(token.token, token.channels[0])), { isAuthorized: true, ttlOverride: 0 });
      process.env.APPSYNC_TOKEN_SECRET = "short";
      const errors: unknown[] = [];
      const log = console.error;
      console.error = (...args: unknown[]) => errors.push(args.join(" "));
      try {
        assert.deepEqual(await createAppSyncAuthorizer()(subscribe(token.token, token.channels[0])), { isAuthorized: false, ttlOverride: 0 });
      } finally {
        console.error = log;
      }
      assert.match(String(errors[0]), /APPSYNC_TOKEN_SECRET/);
      assert.ok(!String(errors[0]).includes("short"), "never logs the secret");
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("AppSync Events: the provider", () => {
  it("signs each publish with SigV4 for appsync, serializes a channel, and reassembles large frames", async () => {
    const published: Array<{ channel: string; events: string[] }> = [];
    let entered!: () => void;
    const firstRequest = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = new AppSyncEventsRealtime({
      ...config,
      credentials,
      fetch: (async (url: URL, init: RequestInit) => {
        assert.equal(String(url), config.httpEndpoint);
        const headers = new Headers(init.headers);
        assert.match(headers.get("authorization")!, /Credential=TEST\/\d{8}\/us-east-1\/appsync\/aws4_request/);
        assert.equal(headers.get("x-amz-security-token"), "TEMPORARY");
        assert.equal(headers.get("host"), null, "fetch sets host");
        published.push(JSON.parse(String(init.body)));
        if (published.length === 1) {
          entered();
          await gate;
        }
        return accepted();
      }) as typeof fetch,
    });
    const first = provider.sendToUser("alice", { type: "event", event: "chat", payload: { state: "thinking" } });
    const final = { type: "event", event: "chat", payload: { state: "final", text: "語".repeat(180_000) } };
    const second = provider.sendToUser("alice", final);
    await firstRequest; // Signing may take longer than 10 ms on a busy runner.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(published.length, 1, "the second frame waits for the first");
    release();
    await Promise.all([first, second]);
    const decode = createRealtimeFrameDecoder();
    let whole;
    for (const request of published.slice(1)) {
      assert.equal(request.channel, userChannel("agentforeach", "alice"));
      assert.equal(request.events.length, 1);
      assert.ok(Buffer.byteLength(JSON.stringify(request)) < 240_000, "under AppSync's event limit");
      whole = decode(request.events[0]);
    }
    assert.deepEqual(whole, final);
  });

  it("an invocation's scope waits for publishes nobody awaited", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let done = false;
    const provider = new AppSyncEventsRealtime({
      ...config,
      credentials,
      fetch: (async () => {
        await gate;
        done = true;
        return accepted();
      }) as typeof fetch,
    });
    const opened = openScope({ invocationId: "lambda", kind: "http" });
    await opened.run(async () => {
      void provider.sendToUser("alice", { type: "event", event: "chat" }).catch(() => {});
    });
    const settled = opened.settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(done, false);
    release();
    await settled;
    assert.equal(done, true, "settle() waited for the publish");
  });

  it("HTTP errors and per-event failures are never reported as delivered, and don't block the next frame", async () => {
    for (const response of [new Response("denied", { status: 403 }), Response.json({ successful: [], failed: [{ index: 0 }] }), Response.json({})]) {
      const provider = new AppSyncEventsRealtime({ ...config, credentials, fetch: (async () => response) as typeof fetch });
      await assert.rejects(provider.sendToUser("u", { type: "event", event: "chat" }), /AppSync Events/);
    }
    let count = 0;
    const provider = new AppSyncEventsRealtime({
      ...config,
      credentials,
      fetch: (async () => (++count === 1 ? new Response("unavailable", { status: 503 }) : accepted())) as typeof fetch,
    });
    const first = provider.sendToUser("u", { type: "event", event: "chat" });
    const second = provider.sendToUser("u", { type: "event", event: "chat" });
    await assert.rejects(first);
    await second;
    assert.equal(count, 2);
  });

  it("gives up on a publish that takes longer than its budget", async () => {
    const provider = new AppSyncEventsRealtime({
      ...config,
      credentials,
      fetch: ((_url: URL, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch,
    });
    const started = Date.now();
    await assert.rejects(provider.sendToUser("u", { type: "event", event: "chat" }));
    assert.ok(Date.now() - started >= 4_900, "the five-second budget");
  });

  it("client access: a descriptor with the endpoint, the token as Authorization, and its channels", async () => {
    const provider = new AppSyncEventsRealtime({ ...config, credentials });
    const access = await provider.clientAccess("alice", { ttlMinutes: 60, groups: ["chat"] });
    assert.equal(access.url, config.realtimeEndpoint);
    assert.deepEqual(access.descriptor, {
      protocol: "appsync-events",
      url: config.realtimeEndpoint,
      authorization: { host: "api.test", Authorization: access.token },
      channels: [userChannel("agentforeach", "alice"), "/agentforeach/all", "/agentforeach/groups/chat"],
      expiresAtMs: access.expiresAtMs,
    });
    assert.deepEqual(resolveRealtimeCapabilities(provider.capabilities), {
      push: true,
      relay: true,
      protocol: "appsync-events",
      inbound: "http",
      presence: false,
      disconnect: false,
    });
    await assert.rejects(provider.isUserOnline("alice"), /no presence/);
    await assert.rejects(provider.disconnectUser("alice"), /can't close/);
  });

  it("relay access binds each party to its own inbox and its peer's", async () => {
    const provider = new AppSyncEventsRealtime({ ...config, credentials });
    assert.equal(provider.relay.host, "realtime.test");
    const group = "bh-0123456789abcdef0123456789abcdef";
    const driver = await provider.relay.groupAccess({ hub: "agentforeach_browser", userId: "browser-driver:ab", peerUserId: "alice", group, ttlMinutes: 11 });
    const viewer = await provider.relay.groupAccess({ hub: "agentforeach_browser", userId: "alice", peerUserId: "browser-driver:ab", group, ttlMinutes: 11 });
    assert.equal(driver.url, config.realtimeEndpoint);
    assert.ok(driver.descriptor?.protocol === "appsync-events" && viewer.descriptor?.protocol === "appsync-events");
    assert.deepEqual(driver.descriptor.channels, [viewer.descriptor.publish]);
    assert.deepEqual(viewer.descriptor.channels, [driver.descriptor.publish]);
    assert.ok(driver.descriptor.authorization.Authorization.startsWith("afeb1."));
    await assert.rejects(provider.relay.groupAccess({ hub: "h", userId: "a", group, ttlMinutes: 5 }), /peerUserId is required/);
  });

  it("registers from the environment, without loading anything until it is used", () => {
    const registration = appSyncRealtime({ realtimeEndpoint: config.realtimeEndpoint });
    assert.equal(registration.id, "aws-appsync-events");
    assert.equal(registration.traits.relayHost(), "realtime.test");
    assert.equal(registration.traits.upstreamWebhooks, false);
    assert.equal(registration.traits.capabilities().protocol, "appsync-events");
    assert.equal(appSyncRealtime({ realtimeEndpoint: "" }).traits.relayHost(), undefined);
    assert.ok(appSyncRealtime({ ...config, credentials }).factory() instanceof AppSyncEventsRealtime);
  });
});

describe("AppSync Events: credentials", () => {
  it("default to the pack's one credential chain", async () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
    process.env.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "example-secret";
    process.env.AWS_SESSION_TOKEN = "example-session";
    let seen: string | null = null;
    try {
      const provider = new AppSyncEventsRealtime({
        ...config,
        fetch: (async (_url: URL, init: RequestInit) => {
          seen = new Headers(init.headers).get("authorization");
          return accepted();
        }) as typeof fetch,
      });
      await provider.sendToUser("u", { type: "event", event: "chat" });
      assert.match(String(seen), /Credential=AKIDEXAMPLE\//);
    } finally {
      for (const [key, value] of [["AWS_ACCESS_KEY_ID", saved.id], ["AWS_SECRET_ACCESS_KEY", saved.secret], ["AWS_SESSION_TOKEN", saved.token]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
