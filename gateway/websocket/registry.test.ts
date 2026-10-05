import assert from "node:assert/strict";
import test from "node:test";
import {
  clearWebSocketProviderCache,
  getActiveProvider,
  getRealtimeRelay,
  installRealtimeProvider,
  realtimeCapabilities,
  realtimeUpstreamWebhooks,
  registerWebSocketProvider,
  relayEgressEntry,
  relayHost,
} from "./providers/index.js";
import { isWebSocketEnabled, resetWebSocketConfig } from "./config.js";
import { installCloudflareRealtime } from "./providers/cloudflare.js";

// A made-up key, built here so it never appears as a literal.
const KEY = Buffer.from("fake-key-for-tests-only").toString("base64");
const CONNECTION = `Endpoint=https://afe-wps.webpubsub.azure.com;AccessKey=${KEY};Version=1.0;`;

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const restore = (): void => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    resetWebSocketConfig();
    clearWebSocketProviderCache();
  };
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  resetWebSocketConfig();
  clearWebSocketProviderCache();
  return Promise.resolve().then(fn).finally(restore);
}

test("Web PubSub: pushes and the relay exist exactly when a connection string is configured", () =>
  withEnv({ WEBSOCKET_PROVIDER: "azure-webpubsub", WEBPUBSUB_CONNECTION_STRING: CONNECTION }, async () => {
    assert.deepEqual(realtimeCapabilities(), { push: true, relay: true, protocol: "v1", inbound: "websocket", presence: true, disconnect: true });
    assert.equal(isWebSocketEnabled(), true);
    assert.equal(relayHost(), "afe-wps.webpubsub.azure.com");
    assert.equal(relayEgressEntry(), "afe-wps.webpubsub.azure.com", "Web PubSub: the whole host, as before");
    const provider = await getActiveProvider();
    assert.equal(provider.id, "azure-webpubsub");
    assert.equal(await getActiveProvider(), provider, "built once");
    const relay = await getRealtimeRelay();
    assert.equal(relay?.host, "afe-wps.webpubsub.azure.com");
  }).then(() =>
    withEnv({ WEBSOCKET_PROVIDER: "azure-webpubsub", WEBPUBSUB_CONNECTION_STRING: undefined }, async () => {
      assert.deepEqual(realtimeCapabilities(), { push: false, relay: false, protocol: "v1", inbound: "websocket", presence: true, disconnect: true });
      assert.equal(relayHost(), undefined);
      assert.equal(await getRealtimeRelay(), undefined);
    }),
  ));

test("pushes switched off: a configured Web PubSub still streams and still relays, as before", () =>
  withEnv({ WEBSOCKET_PROVIDER: "noop", WEBPUBSUB_CONNECTION_STRING: CONNECTION }, async () => {
    assert.equal(realtimeCapabilities().push, true);
    assert.equal(relayHost(), "afe-wps.webpubsub.azure.com");
    assert.equal(relayEgressEntry(), "afe-wps.webpubsub.azure.com");
    assert.equal((await getRealtimeRelay())?.host, "afe-wps.webpubsub.azure.com");
    assert.equal((await getActiveProvider()).id, "noop");
  }));

test("other providers declare their own capabilities and relay", () => {
  registerWebSocketProvider(
    "test-relay",
    () => ({
      id: "test-relay",
      capabilities: { push: true, relay: true },
      sendToUser: async () => {},
      isUserOnline: async () => false,
      disconnectUser: async () => {},
      clientAccess: async () => ({ url: "wss://x", token: "t", expiresAtMs: 0 }),
      relay: { host: "relay.example", groupAccess: async () => ({ url: "wss://relay.example/r" }) },
    }),
    { capabilities: () => ({ push: true, relay: true }), relayHost: () => "relay.example" },
  );
  return withEnv({ WEBSOCKET_PROVIDER: "test-relay", WEBPUBSUB_CONNECTION_STRING: undefined }, async () => {
    assert.equal(relayHost(), "relay.example");
    assert.equal((await getRealtimeRelay())?.host, "relay.example");
  });
});

test("a provider that fails to build is retried next time", () => {
  let attempts = 0;
  registerWebSocketProvider("flaky", () => {
    if (++attempts === 1) throw new Error("not yet");
    return { id: "flaky", sendToUser: async () => {} } as never;
  });
  return withEnv({ WEBSOCKET_PROVIDER: "flaky" }, async () => {
    await assert.rejects(getActiveProvider(), /not yet/);
    assert.equal((await getActiveProvider()).id, "flaky");
  });
});

test("the Cloudflare provider: pushes and a relay on the Worker's own host", () => {
  const pushed: unknown[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (() => ({ sendToUser: (data: unknown) => (pushed.push(data), 1), isOnline: () => true, disconnect: () => 1, fetch: async () => new Response() })) as never,
  };
  installCloudflareRealtime({ userSockets: ns, relays: ns, signingKey: "k", publicBaseUrl: "https://gw.example.workers.dev" });
  return withEnv({ WEBSOCKET_PROVIDER: "cloudflare", WEBPUBSUB_CONNECTION_STRING: undefined }, async () => {
    assert.deepEqual(realtimeCapabilities(), { push: true, relay: true, protocol: "v1", inbound: "websocket", presence: true, disconnect: true });
    assert.equal(relayHost(), "gw.example.workers.dev");
    assert.equal(relayEgressEntry(), "gw.example.workers.dev/realtime/relay", "only the relay path on the Worker's host");
    const provider = await getActiveProvider();
    assert.equal(provider.id, "cloudflare");
    await provider.sendToUser("u1", { type: "event", event: "chat" });
    assert.deepEqual(pushed, [{ type: "event", event: "chat" }]);
    const access = await provider.clientAccess("u1", { ttlMinutes: 5 });
    assert.match(access.url, /^wss:\/\/gw\.example\.workers\.dev\/realtime\/client\?access_token=/);
    assert.equal((await getRealtimeRelay())?.host, "gw.example.workers.dev");
  });
});

test("a pack's own registration (AppSync Events): its capabilities, relay host and no webhooks", () => {
  installRealtimeProvider({
    id: "test-appsync",
    factory: () => ({ id: "test-appsync", sendToUser: async () => {} }) as never,
    traits: {
      capabilities: () => ({ push: true, relay: true, protocol: "appsync-events", inbound: "http", presence: false, disconnect: false }),
      relayHost: () => "realtime.example",
      upstreamWebhooks: false,
    },
  });
  return withEnv({ WEBSOCKET_PROVIDER: "test-appsync", WEBPUBSUB_CONNECTION_STRING: undefined }, async () => {
    assert.deepEqual(realtimeCapabilities(), { push: true, relay: true, protocol: "appsync-events", inbound: "http", presence: false, disconnect: false });
    assert.equal(isWebSocketEnabled(), true);
    assert.equal(relayHost(), "realtime.example");
    assert.equal(relayEgressEntry(), "realtime.example");
    assert.equal(realtimeUpstreamWebhooks(), false);
    assert.equal((await getActiveProvider()).id, "test-appsync");
  });
});
