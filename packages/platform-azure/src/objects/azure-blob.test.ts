/**
 * The azure-blob provider. Unit tests run everywhere; the conformance suite
 * runs against Azurite or a real account when OBJECTS_AZURE_CONNECTION_STRING
 * is set (for Azurite: "UseDevelopmentStorage=true").
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import test from "node:test";
import { runObjectStoreConformance, UNCHECKED_NAMES } from "@agentforeach/platform/objects/conformance";
import { ContainerClient } from "@azure/storage-blob";
import { AzureBlobObjectStore } from "./azure-blob.js";

const KEY_ACCOUNT = "DefaultEndpointsProtocol=https;AccountName=acct2;AccountKey=a2V5;EndpointSuffix=core.windows.net";
const credential = { getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 60_000 }) };

describe("azure-blob provider", () => {
  it("reaches the account by connection string or managed identity", () => {
    assert.equal(new AzureBlobObjectStore({ accountName: "acct", credential }, "skills").containerUrl, "https://acct.blob.core.windows.net/skills");
    assert.equal(new AzureBlobObjectStore(KEY_ACCOUNT, "custom").containerUrl, "https://acct2.blob.core.windows.net/custom");
  });

  it("signs read-only, HTTPS-only links with the account key", async () => {
    const store = new AzureBlobObjectStore(KEY_ACCOUNT, "user-exports");
    const expiresAt = new Date(Date.now() + 3_600_000);
    const url = new URL(await store.signedUrl("abc/123_report final.csv", { expiresAt }));
    assert.equal(url.origin + url.pathname, "https://acct2.blob.core.windows.net/user-exports/abc/123_report%20final.csv");
    assert.equal(url.searchParams.get("sp"), "r");
    assert.equal(url.searchParams.get("spr"), "https");
    assert.equal(url.searchParams.get("sr"), "b");
    assert.equal(url.searchParams.get("st"), null, "no start time");
    assert.equal(new Date(url.searchParams.get("se")!).getTime(), Math.floor(expiresAt.getTime() / 1000) * 1000);
    assert.ok(url.searchParams.get("sig"));
  });

  it("signs with a user delegation key under a managed identity, reusing it while it outlives the link", async () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const store = new AzureBlobObjectStore({ accountName: "acct", credential }, "user-exports", { now: () => now });
    const requests: Array<[Date, Date]> = [];
    (store as unknown as { service: { getUserDelegationKey: unknown } }).service.getUserDelegationKey = async (startsOn: Date, expiresOn: Date) => {
      requests.push([startsOn, expiresOn]);
      return {
        signedObjectId: "oid",
        signedTenantId: "tid",
        signedStartsOn: startsOn,
        signedExpiresOn: expiresOn,
        signedService: "b",
        signedVersion: "2025-01-05",
        value: Buffer.from("delegation-key").toString("base64"),
      };
    };
    const in24h = new Date(now.getTime() + 24 * 3_600_000);
    const url = new URL(await store.signedUrl("u/f.txt", { expiresAt: in24h }));
    assert.equal(url.searchParams.get("skoid"), "oid");
    assert.equal(url.searchParams.get("sp"), "r");
    assert.equal(url.searchParams.get("spr"), "https");
    assert.deepEqual(requests[0], [new Date(now.getTime() - 5 * 60_000), new Date(in24h.getTime() + 86_400_000)]);

    await store.signedUrl("u/g.txt", { expiresAt: new Date(now.getTime() + 36 * 3_600_000) });
    assert.equal(requests.length, 1, "the cached key outlives the second link");

    await store.signedUrl("u/h.txt", { expiresAt: new Date(now.getTime() + 7 * 86_400_000 - 1000) });
    assert.equal(requests.length, 2, "a later link needs a new key");
    assert.equal(requests[1][1].getTime(), now.getTime() + 7 * 86_400_000 - 60_000, "keys are capped just under 7 days");
  });

  it("ends a delegation-signed link when its key does, and reports when", async () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const store = new AzureBlobObjectStore({ accountName: "acct", credential }, "user-exports", { now: () => now });
    (store as unknown as { service: { getUserDelegationKey: unknown } }).service.getUserDelegationKey = async (startsOn: Date, expiresOn: Date) => ({
      signedObjectId: "oid",
      signedTenantId: "tid",
      signedStartsOn: startsOn,
      signedExpiresOn: expiresOn,
      signedService: "b",
      signedVersion: "2025-01-05",
      value: Buffer.from("delegation-key").toString("base64"),
    });
    const keyExpiry = now.getTime() + 7 * 86_400_000 - 60_000;
    const far = await store.signedUrlWithExpiry("u/f.txt", { expiresAt: new Date(now.getTime() + 10 * 86_400_000) });
    assert.equal(far.expiresAt.getTime(), keyExpiry, "no later than the key, which lasts just under 7 days");
    assert.equal(new Date(new URL(far.url).searchParams.get("se")!).getTime(), keyExpiry, "the link's own expiry");

    const near = new Date(now.getTime() + 3_600_000 + 500);
    const signed = await store.signedUrlWithExpiry("u/f.txt", { expiresAt: near });
    assert.equal(signed.expiresAt.getTime(), now.getTime() + 3_600_000, "whole seconds, as a SAS has them");
    assert.equal(new Date(new URL(signed.url).searchParams.get("se")!).getTime(), signed.expiresAt.getTime());
  });

  it("issues key-signed links beyond 7 days, as it always has", async () => {
    const store = new AzureBlobObjectStore(KEY_ACCOUNT, "user-exports");
    const expiresAt = new Date(Date.now() + 200 * 3_600_000);
    const url = new URL(await store.signedUrl("k", { expiresAt }));
    assert.equal(new Date(url.searchParams.get("se")!).getTime(), Math.floor(expiresAt.getTime() / 1000) * 1000);
    assert.equal((await store.signedUrlWithExpiry("k", { expiresAt })).expiresAt.getTime(), Math.floor(expiresAt.getTime() / 1000) * 1000);
    await assert.rejects(store.signedUrl("k", { expiresAt: new Date(Date.now() - 1000) }), { code: "invalid" });
  });
});

const connectionString = process.env.OBJECTS_AZURE_CONNECTION_STRING;
if (!connectionString) {
  test("azure-blob conformance (set OBJECTS_AZURE_CONNECTION_STRING to run against Azurite or an account)", { skip: true }, () => {});
} else {
  // Links are HTTPS-only, so they are not fetched from Azurite's HTTP endpoint.
  // Azurite and key accounts sign with the account key, which never expires,
  // so the credential-expiry case is the unit test above.
  runObjectStoreConformance({
    name: "azure-blob (live)",
    createStore: () => new AzureBlobObjectStore(connectionString, "agentforeach-conformance", { createContainer: true }),
    linkExpiry: (url) => new Date(new URL(url).searchParams.get("se")!),
    // Written straight to the container, as a release before the current key rules could have.
    putUnchecked: async (_store, key, body) => {
      await new ContainerClient(connectionString, "agentforeach-conformance").getBlockBlobClient(key).upload(body, Buffer.byteLength(body));
    },
    // The SDK sends a backslash in a blob name as "/", so no such name was ever stored.
    uncheckedNames: UNCHECKED_NAMES.filter((name) => !name.includes("\\")),
  });

  describe("azure-blob specifics (live)", () => {
    it("treats a missing container as not_found to list and empty to delete", async () => {
      const store = new AzureBlobObjectStore(connectionString, `afe-missing-${Date.now()}`);
      assert.equal(await store.deletePrefix("u/"), 0);
      assert.equal(await store.exists("k"), false);
      await assert.rejects(async () => {
        for await (const _ of store.list()) assert.fail("no container");
      }, { name: "ObjectStoreError", code: "not_found" });
    });
  });
}
