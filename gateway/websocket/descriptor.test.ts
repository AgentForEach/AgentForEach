import assert from "node:assert/strict";
import test from "node:test";
import type { ClientAccess, HandlerContext, HttpRequestLike, RouteDef } from "@agentforeach/platform";
import { routes as apiRoutes } from "../handlers/api.js";
import { routes as wsRoutes } from "../handlers/ws-connect.js";
import { resetAuthConfig } from "../auth/index.js";
import { clearWebSocketProviderCache, registerWebSocketProvider } from "./providers/index.js";
import { resetWebSocketConfig } from "./config.js";

const context = { log() {}, warn() {}, error() {} } as unknown as HandlerContext;

const request = (method: string): HttpRequestLike =>
  ({
    method,
    url: "https://gw.example/api/token",
    headers: new Headers({ "x-user-id": "alice" }),
    query: new URLSearchParams(),
    params: {},
    text: async () => "",
    json: async () => ({}),
  }) as unknown as HttpRequestLike;

const route = (list: RouteDef[], name: string) => list.find((r) => r.name === name)!.handler;

/** A provider whose client access is `access`. */
function provider(id: string, access: ClientAccess): void {
  registerWebSocketProvider(id, () => ({
    id,
    sendToUser: async () => {},
    isUserOnline: async () => false,
    disconnectUser: async () => {},
    clientAccess: async () => access,
  }));
}

async function withProvider(id: string, fn: () => Promise<void>): Promise<void> {
  const saved = { provider: process.env.WEBSOCKET_PROVIDER, insecure: process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER };
  process.env.WEBSOCKET_PROVIDER = id;
  process.env.AUTH_ALLOW_INSECURE_USER_ID_HEADER = "true";
  resetWebSocketConfig();
  resetAuthConfig();
  clearWebSocketProviderCache();
  try {
    await fn();
  } finally {
    for (const [key, value] of [["WEBSOCKET_PROVIDER", saved.provider], ["AUTH_ALLOW_INSECURE_USER_ID_HEADER", saved.insecure]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetWebSocketConfig();
    clearWebSocketProviderCache();
  }
}

test("/api/token and /negotiate return a provider's connection descriptor with the URL", () => {
  const descriptor = {
    protocol: "appsync-events" as const,
    url: "wss://example.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime",
    authorization: { host: "example.appsync-api.us-west-2.amazonaws.com", Authorization: "afe1.p.m" },
    channels: ["/agentforeach/users/a/b"],
    expiresAtMs: 1_900_000_000_000,
  };
  provider("test-descriptor", { url: descriptor.url, token: "afe1.p.m", expiresAtMs: descriptor.expiresAtMs, descriptor });
  return withProvider("test-descriptor", async () => {
    const token = await route(apiRoutes, "apiToken")(request("POST"), context);
    assert.equal(token.status, 200);
    assert.deepEqual(JSON.parse(token.body!), { url: descriptor.url, expiresAtMs: descriptor.expiresAtMs, descriptor });
    const negotiate = await route(wsRoutes, "negotiate")(request("GET"), context);
    assert.equal(negotiate.status, 200);
    assert.deepEqual(JSON.parse(negotiate.body!), { url: descriptor.url, descriptor });
  });
});

test("protocol v1 providers answer exactly as before: no descriptor", () => {
  provider("test-v1", { url: "wss://hub.example/client?access_token=t", token: "t", expiresAtMs: 1_900_000_000_000 });
  return withProvider("test-v1", async () => {
    const token = await route(apiRoutes, "apiToken")(request("POST"), context);
    assert.deepEqual(JSON.parse(token.body!), { url: "wss://hub.example/client?access_token=t", expiresAtMs: 1_900_000_000_000 });
    const negotiate = await route(wsRoutes, "negotiate")(request("GET"), context);
    assert.deepEqual(JSON.parse(negotiate.body!), { url: "wss://hub.example/client?access_token=t" });
  });
});
