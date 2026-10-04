// Protocol v1 conformance against the test Worker (see run.mjs).
import { runRealtimeConformance, webSocketTestClient } from "@agentforeach/platform/realtime/conformance";
import { sealRealtimeToken } from "@agentforeach/platform";

// The test Worker's REALTIME_SIGNING_KEY (wrangler.jsonc vars), so the suite can mint tokens.
const WORKER_KEY = "local-conformance-only";

const base = process.env.REALTIME_WORKER_URL;
if (!base) throw new Error("Set REALTIME_WORKER_URL, or use run.mjs");

const call = async (op, body) => {
  const response = await fetch(`${base}/test/${op}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${op}: ${response.status} ${await response.text()}`);
  return response.json();
};

const host = await call("relayHost", {});
const provider = {
  id: "cloudflare",
  capabilities: { push: true, relay: true },
  sendToUser: (userId, data) => call("sendToUser", { userId, data }),
  isUserOnline: (userId) => call("isUserOnline", { userId }),
  disconnectUser: (userId, reason) => call("disconnectUser", { userId, reason }),
  clientAccess: (userId, options) => call("clientAccess", { userId, options }),
  relay: { host, groupAccess: (options) => call("groupAccess", options) },
};

// workerd ends a server-closed connection's TCP about 10 s after the close
// handshake, so allow presence that long to settle.
runRealtimeConformance({
  name: "cloudflare (workerd)",
  createProvider: () => provider,
  connect: webSocketTestClient,
  inboundEvents: true,
  oneTimeUrls: true,
  settleMs: 15_000,
  tokens: { hub: "agentforeach", seal: (claims, key) => sealRealtimeToken(claims, key === "provider" ? WORKER_KEY : "another-deployments-key") },
});

// Cloudflare only: a URL refused because the request wasn't a protocol v1
// upgrade is spent too, since it was sent (and may be in a log).
import assert from "node:assert/strict";
import { it } from "node:test";

it("cloudflare (workerd): a URL refused as a plain request is spent", async () => {
  for (const issue of [
    () => call("clientAccess", { userId: `spent-${Date.now()}`, options: { ttlMinutes: 5 } }),
    () => call("groupAccess", { hub: "conf_spent", userId: "viewer", group: `bh-${Date.now()}`, ttlMinutes: 5 }),
  ]) {
    const { url } = await issue();
    const plain = await fetch(url.replace(/^ws/, "http"));
    assert.equal(plain.status, 426);
    let client;
    try {
      client = await webSocketTestClient(url);
    } catch {
      continue;
    }
    client.close();
    assert.fail(`the URL still connected after a refused request: ${new URL(url).pathname}`);
  }
});
