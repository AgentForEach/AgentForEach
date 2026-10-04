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
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import test from "node:test";
import { runObjectStoreConformance } from "./conformance.js";
import { S3ObjectStore, type S3ObjectStoreOptions } from "./s3.js";
import { signRequest, type AwsCredentials } from "./sigv4.js";

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

  // A small page size makes the 25-object listing test cross pages.
  runObjectStoreConformance({
    name: "s3 (live)",
    createStore: () => new S3ObjectStore({ ...base, listPageSize: 10 }),
    fetchSignedUrls: true,
  });

  // The provider never deletes buckets, so the test removes its own.
  const deleteBucket = async (bucket: string): Promise<void> => {
    const url = new URL(`${new URL(endpoint).origin}/${bucket}`);
    const headers = await signRequest(
      { credentials: base.credentials as AwsCredentials, region: base.region ?? "us-east-1", service: "s3" },
      { method: "DELETE", url },
    );
    delete headers["host"];
    const response = await fetch(url, { method: "DELETE", headers });
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

    it("refuses wrong credentials as unauthorized", async () => {
      // Well-formed but unknown: R2 rejects a key of the wrong length as a bad request before checking it.
      const wrong = { accessKeyId: "0".repeat(32), secretAccessKey: "0".repeat(64) };
      const store = new S3ObjectStore({ ...base, credentials: wrong });
      await assert.rejects(store.put("k", "v"), { name: "ObjectStoreError", code: "unauthorized" });
    });
  });
}
