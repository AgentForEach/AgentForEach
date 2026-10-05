/**
 * The s3 provider against a live S3-compatible service. CI runs it against
 * MinIO; point it at R2, S3 or GCS interoperability by setting the variables.
 *
 *   OBJECTS_S3_ENDPOINT=http://localhost:9000
 *   OBJECTS_S3_ACCESS_KEY_ID / OBJECTS_S3_SECRET_ACCESS_KEY
 *   OBJECTS_S3_BUCKET (default agentforeach-conformance; created if missing)
 *   OBJECTS_S3_REGION (default us-east-1; `auto` for R2)
 *   OBJECTS_S3_SKIP_CREATE_BUCKET=1 for keys that can't create buckets, such
 *     as an R2 "Object Read & Write" token (what a deployed Worker uses; the
 *     deploy script creates its buckets with wrangler). OBJECTS_S3_BUCKET must
 *     then exist, and the bucket-creation test is skipped.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import test from "node:test";
import { runObjectStoreConformance, UNCHECKED_NAMES } from "./conformance.js";
import { S3ObjectStore, type S3ObjectStoreOptions } from "./s3.js";
import { presignedUrlExpiry, signRequest, uriEncode, type AwsCredentials } from "./sigv4.js";
import { parseListObjectVersions } from "./s3.js";

const endpoint = process.env.OBJECTS_S3_ENDPOINT;
const skipCreateBucket = Boolean(process.env.OBJECTS_S3_SKIP_CREATE_BUCKET);

if (!endpoint) {
  test("s3 conformance (set OBJECTS_S3_ENDPOINT to run against a live service)", { skip: true }, () => {});
} else {
  const base: S3ObjectStoreOptions = {
    endpoint,
    bucket: process.env.OBJECTS_S3_BUCKET ?? "agentforeach-conformance",
    region: process.env.OBJECTS_S3_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.OBJECTS_S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.OBJECTS_S3_SECRET_ACCESS_KEY ?? "",
    },
    createBucket: !skipCreateBucket,
  };

  /** A request the provider would not send, signed with the test's keys. */
  const raw = async (method: string, bucket: string, key = "", init: { query?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> => {
    const path = key ? "/" + key.split("/").map(uriEncode).join("/") : "";
    const url = new URL(`${new URL(endpoint).origin}/${bucket}${path}${init.query ? `?${init.query}` : ""}`);
    const headers = await signRequest(
      { credentials: base.credentials as AwsCredentials, region: base.region ?? "us-east-1", service: "s3" },
      { method, url, headers: init.headers, body: init.body },
    );
    delete headers["host"];
    return fetch(url, { method, headers, body: init.body });
  };

  /** The suite's options for a store under `prefix` of the bucket. */
  const conformance = (prefix = "") => ({
    fetchSignedUrls: true,
    linkExpiry: presignedUrlExpiry,
    // The same keys, presented as temporary credentials that expire then.
    withCredentialsExpiring: (_store: unknown, expiration: Date) =>
      new S3ObjectStore({ ...base, prefix, credentials: async () => ({ ...(base.credentials as AwsCredentials), expiration }) }),
    // Written as a release before the current key rules could have.
    putUnchecked: async (_store: unknown, key: string, body: string) => {
      const response = await raw("PUT", base.bucket, prefix + key, { body });
      assert.equal(response.status, 200, await response.text());
    },
    // MinIO refuses empty key segments itself.
    uncheckedNames: UNCHECKED_NAMES.filter((name) => !name.includes("//")),
  });

  // A small page size makes the 25-object listing test cross pages.
  runObjectStoreConformance({
    name: "s3 (live)",
    createStore: () => new S3ObjectStore({ ...base, listPageSize: 10 }),
    ...conformance(),
  });

  // A store under a prefix of the bucket, as AWS deployments share one.
  runObjectStoreConformance({
    name: "s3 (live, under a store prefix)",
    createStore: () => new S3ObjectStore({ ...base, prefix: "store-prefix/", listPageSize: 10 }),
    ...conformance("store-prefix/"),
  });

  // The provider never deletes buckets, so the test removes its own.
  const deleteBucket = async (bucket: string): Promise<void> => {
    const response = await raw("DELETE", bucket);
    assert.equal(response.status, 204, await response.text());
  };

  describe("s3 specifics (live)", () => {
    const createSkip = skipCreateBucket && "OBJECTS_S3_SKIP_CREATE_BUCKET: these keys can't create buckets";
    it("creates a missing bucket on the first put", { skip: createSkip }, async () => {
      const bucket = `afe-conf-${randomUUID().slice(0, 8)}`;
      const store = new S3ObjectStore({ ...base, bucket });
      assert.equal(await store.exists("k"), false);
      assert.equal(await store.deletePrefix("k"), 0);
      await assert.rejects(async () => {
        for await (const _ of store.list()) assert.fail("no bucket yet");
      }, { name: "ObjectStoreError", code: "not_found" });
      await store.put("k", "v");
      assert.equal(new TextDecoder().decode(await store.get("k")), "v");
      assert.equal(await store.deletePrefix("k"), 1);
      await deleteBucket(bucket);
    });

    it("with deleteVersions, leaves no version or delete marker behind on a versioned bucket", { skip: createSkip }, async () => {
      const bucket = `afe-conf-${randomUUID().slice(0, 8)}`;
      const plain = new S3ObjectStore({ ...base, bucket });
      const versions = new S3ObjectStore({ ...base, bucket, deleteVersions: true });
      await plain.put("first", "x"); // creates the bucket
      const config = `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>`;
      const md5 = createHash("md5").update(config).digest("base64");
      const enabled = await raw("PUT", bucket, "", { query: "versioning=", body: config, headers: { "content-md5": md5 } });
      assert.equal(enabled.status, 200, await enabled.text());

      await plain.put("u/a", "1");
      await plain.put("u/a", "2");
      await plain.put("u/b", "1");
      assert.equal(await plain.deletePrefix("u/b"), 1); // leaves a delete marker and the old version
      const listVersions = async (prefix: string) => {
        const response = await raw("GET", bucket, "", { query: `prefix=${encodeURIComponent(prefix)}&versions=` });
        return parseListObjectVersions(await response.text()).versions;
      };
      assert.equal((await listVersions("u/")).length, 4, "two versions of u/a, one of u/b and its delete marker");

      assert.equal(await versions.deletePrefix("u/"), 2);
      assert.deepEqual(await listVersions("u/"), []);
      assert.equal(await versions.deletePrefix("first"), 1);
      await deleteBucket(bucket); // refused while any version is left
    });

    it("refuses wrong credentials as unauthorized", async () => {
      // Well-formed but unknown: R2 rejects a key of the wrong length as a bad request before checking it.
      const wrong = { accessKeyId: "0".repeat(32), secretAccessKey: "0".repeat(64) };
      const store = new S3ObjectStore({ ...base, credentials: wrong });
      await assert.rejects(store.put("k", "v"), { name: "ObjectStoreError", code: "unauthorized" });
    });
  });
}
