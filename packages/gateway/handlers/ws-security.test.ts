import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import azureFunctions from "@azure/functions";

import {
  accessKeyFromConnectionString,
  isValidWebPubSubSignature,
  verifyUpstreamSecret,
} from "./ws-security.js";

const { HttpRequest } = azureFunctions;

const ENV = [
  "WEBSITE_SITE_NAME",
  "WEBPUBSUB_CONNECTION_STRING",
  "WEBPUBSUB_UPSTREAM_SHARED_SECRET",
  "WEBPUBSUB_REQUIRE_UPSTREAM_SECRET",
  "WEBPUBSUB_SECONDARY_ACCESS_KEY",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const KEY = "primary-access-key";
const sig = (key: string, connectionId: string) =>
  `sha256=${createHmac("sha256", key).update(connectionId).digest("hex")}`;

function req(headers: Record<string, string>, query = "") {
  return new HttpRequest({ method: "POST", url: `https://func.example/ws/message${query}`, headers });
}

test("the access key is read from the connection string", () => {
  assert.equal(
    accessKeyFromConnectionString(`Endpoint=https://x.webpubsub.azure.com;AccessKey=${KEY};Version=1.0;`),
    KEY,
  );
  assert.equal(accessKeyFromConnectionString(undefined), undefined);
});

test("a valid ce-signature is accepted, including during key rotation", () => {
  assert.equal(isValidWebPubSubSignature(sig(KEY, "conn-1"), "conn-1", [KEY]), true);
  // Primary and secondary signatures, comma-separated.
  assert.equal(isValidWebPubSubSignature(`${sig("old", "conn-1")},${sig(KEY, "conn-1")}`, "conn-1", [KEY]), true);
  assert.equal(isValidWebPubSubSignature(sig(KEY, "conn-2"), "conn-1", [KEY]), false);
});

test("upstream calls are verified by ce-signature, no secret in the URL needed", () => {
  process.env.WEBSITE_SITE_NAME = "agentforeach-func";
  process.env.WEBPUBSUB_CONNECTION_STRING = `Endpoint=https://x;AccessKey=${KEY};`;
  const ok = req({ "ce-signature": sig(KEY, "conn-1"), "ce-connectionid": "conn-1" });
  assert.equal(verifyUpstreamSecret(ok), null);
  const forged = req({ "ce-signature": sig("guess", "conn-1"), "ce-connectionid": "conn-1" });
  assert.equal(verifyUpstreamSecret(forged)?.status, 401);
  assert.equal(verifyUpstreamSecret(req({}))?.status, 401);
});

test("in the cloud, a shared secret in the query string is ignored (it would be logged)", () => {
  process.env.WEBSITE_SITE_NAME = "agentforeach-func";
  delete process.env.WEBPUBSUB_CONNECTION_STRING;
  process.env.WEBPUBSUB_UPSTREAM_SHARED_SECRET = "s3cret";
  assert.equal(verifyUpstreamSecret(req({}, "?upstreamSecret=s3cret"))?.status, 401);
  assert.equal(verifyUpstreamSecret(req({ "x-webpubsub-upstream-secret": "s3cret" })), null);
});

test("with an access key, the shared secret cannot stand in for ce-signature", () => {
  process.env.WEBSITE_SITE_NAME = "agentforeach-func";
  process.env.WEBPUBSUB_CONNECTION_STRING = `Endpoint=https://x;AccessKey=${KEY};`;
  process.env.WEBPUBSUB_UPSTREAM_SHARED_SECRET = "s3cret";
  const spoof = req({ "x-webpubsub-upstream-secret": "s3cret", "ce-userid": "victim" });
  assert.equal(verifyUpstreamSecret(spoof)?.status, 401);
});

test("a signature without ce-connectionid is rejected", () => {
  process.env.WEBPUBSUB_CONNECTION_STRING = `Endpoint=https://x;AccessKey=${KEY};`;
  assert.equal(verifyUpstreamSecret(req({ "ce-signature": sig(KEY, "") }))?.status, 401);
});

test("the secondary access key and upper-case hex are accepted", () => {
  process.env.WEBPUBSUB_CONNECTION_STRING = `Endpoint=https://x;AccessKey=${KEY};`;
  process.env.WEBPUBSUB_SECONDARY_ACCESS_KEY = "secondary-key";
  const secondary = req({ "ce-signature": sig("secondary-key", "conn-1"), "ce-connectionid": "conn-1" });
  assert.equal(verifyUpstreamSecret(secondary), null);
  const upper = req({ "ce-signature": sig(KEY, "conn-1").toUpperCase(), "ce-connectionid": "conn-1" });
  assert.equal(verifyUpstreamSecret(upper), null);
});
