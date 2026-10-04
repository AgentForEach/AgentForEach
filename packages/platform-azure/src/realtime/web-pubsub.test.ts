import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebPubSubRealtime, webPubSubHost, webPubSubRelay } from "./web-pubsub.js";

// A made-up key, built here so it never appears as a literal.
const KEY = Buffer.from("fake-key-for-tests-only").toString("base64");
const CONNECTION = `Endpoint=https://afe-wps.webpubsub.azure.com;AccessKey=${KEY};Version=1.0;`;

/** The claims of the token in a client URL (signed locally with the access key; no network). */
function claims(url: string): Record<string, unknown> {
  const token = new URL(url).searchParams.get("access_token")!;
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

describe("azure web pubsub provider", () => {
  it("finds the service host in the connection string", () => {
    assert.equal(webPubSubHost(CONNECTION), "afe-wps.webpubsub.azure.com");
    assert.equal(webPubSubHost(""), undefined);
    assert.equal(webPubSubRelay(""), undefined);
  });

  it("issues relay tokens that can only join and send to one group, on the relay hub", async () => {
    const relay = webPubSubRelay(CONNECTION)!;
    assert.equal(relay.host, "afe-wps.webpubsub.azure.com");
    const { url } = await relay.groupAccess({ hub: "agentforeach_browser", userId: "browser-driver:ab", group: "bh-1", ttlMinutes: 31 });
    assert.match(url, /^wss:\/\/afe-wps\.webpubsub\.azure\.com\/client\/hubs\/agentforeach_browser\?access_token=/);
    const c = claims(url);
    assert.equal(c.sub, "browser-driver:ab");
    assert.deepEqual(c.role, ["webpubsub.joinLeaveGroup.bh-1", "webpubsub.sendToGroup.bh-1"]);
    assert.equal((c.exp as number) - (c.iat as number), 31 * 60);
  });

  it("issues client tokens with the caller's groups and roles", async () => {
    const provider = new WebPubSubRealtime({ connectionString: CONNECTION, hub: "agentforeach" });
    assert.deepEqual(provider.capabilities, { push: true, relay: true });
    const access = await provider.clientAccess("u1", { ttlMinutes: 60, groups: ["cron"], roles: ["webpubsub.joinLeaveGroup.cron"] });
    assert.match(access.url, /\/client\/hubs\/agentforeach\?access_token=/);
    const c = claims(access.url);
    assert.equal(c.sub, "u1");
    assert.deepEqual(c.role, ["webpubsub.joinLeaveGroup.cron"]);
    assert.deepEqual(c["webpubsub.group"], ["cron"]);
    assert.ok(Math.abs(access.expiresAtMs - (Date.now() + 3_600_000)) < 5000);
  });

  it("needs a connection string", () => {
    assert.throws(() => new WebPubSubRealtime({ connectionString: "", hub: "h" }), /requires a connection string/);
  });
});
