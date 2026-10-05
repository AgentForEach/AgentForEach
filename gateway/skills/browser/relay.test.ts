import test from "node:test";
import assert from "node:assert/strict";
import type { GroupAccessOptions } from "@agentforeach/platform";
import { clearWebSocketProviderCache, registerWebSocketProvider } from "../../websocket/providers/index.js";
import { resetWebSocketConfig } from "../../websocket/config.js";
import { handoffDriverUserId } from "./handler.js";
import { handoffRelay } from "./relay.js";

test("the handoff relay issues both parties' connections, each naming the other as its peer", async () => {
  const asked: GroupAccessOptions[] = [];
  registerWebSocketProvider(
    "test-peer-relay",
    () => ({
      id: "test-peer-relay",
      sendToUser: async () => {},
      isUserOnline: async () => false,
      disconnectUser: async () => {},
      clientAccess: async () => ({ url: "wss://x", token: "t", expiresAtMs: 0 }),
      relay: {
        host: "relay.example",
        groupAccess: async (o: GroupAccessOptions) => {
          asked.push(o);
          return {
            url: "wss://relay.example/event/realtime",
            descriptor: {
              protocol: "appsync-events" as const,
              url: "wss://relay.example/event/realtime",
              authorization: { host: "h", Authorization: o.userId },
              channels: [`/r/${o.userId}`],
              publish: `/r/${o.peerUserId}`,
              expiresAtMs: 1,
            },
          };
        },
      },
    }),
    { relayHost: () => "relay.example" },
  );
  const saved = process.env.WEBSOCKET_PROVIDER;
  process.env.WEBSOCKET_PROVIDER = "test-peer-relay";
  resetWebSocketConfig();
  clearWebSocketProviderCache();
  try {
    const issued = await handoffRelay("agentforeach_browser").issue("alice", "bh-1", 11);
    const driver = handoffDriverUserId("alice");
    assert.deepEqual(
      asked.map((o) => [o.userId, o.peerUserId, o.hub, o.group, o.ttlMinutes]),
      [
        [driver, "alice", "agentforeach_browser", "bh-1", 11],
        ["alice", driver, "agentforeach_browser", "bh-1", 11],
      ],
    );
    assert.equal(issued.driverUrl, "wss://relay.example/event/realtime");
    assert.equal(issued.driver?.protocol === "appsync-events" && issued.driver.authorization.Authorization, driver);
    assert.equal(issued.viewer?.protocol === "appsync-events" && issued.viewer.authorization.Authorization, "alice");
  } finally {
    if (saved === undefined) delete process.env.WEBSOCKET_PROVIDER;
    else process.env.WEBSOCKET_PROVIDER = saved;
    resetWebSocketConfig();
    clearWebSocketProviderCache();
  }
});
