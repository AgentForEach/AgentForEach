import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { createAzureTokenCredential } from "@agentforeach/platform-azure/identity";
import { createStorage } from "../database/storage.js";

test("the Cosmos credential asks the managed identity endpoint for the right identity, and caches", async () => {
  const seen: URL[] = [];
  const server = createServer((req, res) => {
    seen.push(new URL(req.url!, "http://localhost"));
    assert.equal(req.headers["x-identity-header"], "secret-header");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "tok-1", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const saved = { e: process.env.IDENTITY_ENDPOINT, h: process.env.IDENTITY_HEADER };
  process.env.IDENTITY_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/msi/token`;
  process.env.IDENTITY_HEADER = "secret-header";
  try {
    const cred = createAzureTokenCredential("https://cosmos.azure.com", "uai-client-id");
    const first = await cred.getToken();
    const second = await cred.getToken();
    assert.equal(first.token, "tok-1");
    assert.ok(first.expiresOnTimestamp > Date.now());
    assert.equal(second.token, "tok-1");
    assert.equal(seen.length, 1, "cached");
    assert.equal(seen[0]!.searchParams.get("resource"), "https://cosmos.azure.com");
    assert.equal(seen[0]!.searchParams.get("client_id"), "uai-client-id");
  } finally {
    server.close();
    if (saved.e === undefined) delete process.env.IDENTITY_ENDPOINT;
    else process.env.IDENTITY_ENDPOINT = saved.e;
    if (saved.h === undefined) delete process.env.IDENTITY_HEADER;
    else process.env.IDENTITY_HEADER = saved.h;
  }
});

test("a Cosmos database without a key is built for Entra auth instead of failing", () => {
  assert.doesNotThrow(() =>
    createStorage({ provider: "cosmosdb", endpoint: "https://acct.documents.azure.com:443/", key: "", databaseId: "x" }),
  );
});
