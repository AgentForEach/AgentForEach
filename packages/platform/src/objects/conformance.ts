/**
 * AgentForEach Platform — Object store conformance suite
 *
 * One `node:test` suite every object-store provider must pass, so the
 * gateway can swap Azure Blob Storage for S3, R2 or MinIO without noticing.
 *
 * ```ts
 * import { runObjectStoreConformance } from "@agentforeach/platform/conformance";
 *
 * runObjectStoreConformance({
 *   name: "s3 (MinIO)",
 *   createStore: () => new S3ObjectStore({ endpoint, bucket, credentials }),
 *   fetchSignedUrls: true,
 * });
 * ```
 *
 * Every object the suite writes lives under `<prefix>/<run id>/`, and the
 * suite deletes that prefix when it ends, so it can share a bucket.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { ObjectStoreErrorCode } from "./errors.js";
import type { ObjectInfo, ObjectStore } from "./types.js";

export type ObjectStoreConformanceOptions = {
  /** Shown in the suite name. */
  name: string;
  createStore: () => ObjectStore | Promise<ObjectStore>;
  /**
   * Download signed URLs and check their bytes and headers. Needs a provider
   * whose URLs this process can reach (not the in-memory one).
   */
  fetchSignedUrls?: boolean;
  /** Key prefix for everything the suite writes. Default "conformance". */
  prefix?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DAY_MS = 24 * 60 * 60 * 1000;

async function rejectsWith(promise: Promise<unknown>, code: ObjectStoreErrorCode): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    const e = err as { name?: string; code?: unknown };
    assert.equal(e?.name, "ObjectStoreError", `expected an ObjectStoreError, got ${String(err)}`);
    assert.equal(e.code, code);
    return true;
  });
}

async function collect(iterable: AsyncIterable<ObjectInfo>): Promise<ObjectInfo[]> {
  const out: ObjectInfo[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export function runObjectStoreConformance(options: ObjectStoreConformanceOptions): void {
  describe(`object store conformance: ${options.name}`, () => {
    let store: ObjectStore;
    const root = `${options.prefix ?? "conformance"}/${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    let n = 0;
    /** A fresh prefix per test, so tests never see each other's objects. */
    const scope = (): string => `${root}/t${++n}`;

    before(async () => {
      store = await options.createStore();
    });

    after(async () => {
      await store?.deletePrefix(`${root}/`);
    });

    it("puts and gets bytes and text", async () => {
      const p = scope();
      const bytes = new Uint8Array([0, 1, 2, 254, 255]);
      await store.put(`${p}/bin`, bytes);
      await store.put(`${p}/text.md`, "héllo ✓\n");
      assert.deepEqual(await store.get(`${p}/bin`), bytes);
      assert.equal(decoder.decode(await store.get(`${p}/text.md`)), "héllo ✓\n");
    });

    it("stores an empty object", async () => {
      const p = scope();
      await store.put(`${p}/empty`, new Uint8Array(0));
      assert.equal((await store.get(`${p}/empty`)).byteLength, 0);
      assert.equal(await store.exists(`${p}/empty`), true);
    });

    it("replaces an object on a second put", async () => {
      const p = scope();
      await store.put(`${p}/k`, "first");
      await store.put(`${p}/k`, "second");
      assert.equal(decoder.decode(await store.get(`${p}/k`)), "second");
    });

    it("reports missing objects as not_found and exists=false", async () => {
      const p = scope();
      await rejectsWith(store.get(`${p}/missing`), "not_found");
      assert.equal(await store.exists(`${p}/missing`), false);
    });

    it("enforces maxBytes on get", async () => {
      const p = scope();
      await store.put(`${p}/ten`, encoder.encode("0123456789"));
      assert.equal((await store.get(`${p}/ten`, { maxBytes: 10 })).byteLength, 10);
      await rejectsWith(store.get(`${p}/ten`, { maxBytes: 9 }), "too_large");
    });

    it("refuses an oversize object without returning part of it", async () => {
      const p = scope();
      const big = new Uint8Array(256 * 1024 + 1).fill(7);
      await store.put(`${p}/big`, big);
      await rejectsWith(store.get(`${p}/big`, { maxBytes: 256 * 1024 }), "too_large");
      assert.equal((await store.get(`${p}/big`)).byteLength, big.byteLength);
    });

    it("lists by prefix, in key order, with sizes", async () => {
      const p = scope();
      await store.put(`${p}/b/2.txt`, "22");
      await store.put(`${p}/a/1.txt`, "1");
      await store.put(`${p}/b/1.txt`, "333");
      await store.put(`${p}/bc/1.txt`, "4444");
      const listed = await collect(store.list(`${p}/b/`));
      assert.deepEqual(
        listed.map((o) => [o.key, o.size]),
        [
          [`${p}/b/1.txt`, 3],
          [`${p}/b/2.txt`, 2],
        ],
      );
      for (const o of listed) if (o.lastModified) assert.ok(!Number.isNaN(o.lastModified.getTime()));
      assert.deepEqual(
        (await collect(store.list(`${p}/`))).map((o) => o.key),
        [`${p}/a/1.txt`, `${p}/b/1.txt`, `${p}/b/2.txt`, `${p}/bc/1.txt`],
      );
    });

    it("lists past one page", async () => {
      const p = scope();
      const keys = Array.from({ length: 25 }, (_, i) => `${p}/item-${String(i).padStart(2, "0")}`);
      await Promise.all(keys.map((k) => store.put(k, "x")));
      assert.deepEqual((await collect(store.list(`${p}/`))).map((o) => o.key), keys);
    });

    it("lists everything when no prefix is given", async () => {
      const p = scope();
      await store.put(`${p}/whole`, "x");
      const all = await collect(store.list());
      assert.ok(all.some((o) => o.key === `${p}/whole`));
    });

    it("lists nothing for an unused prefix", async () => {
      assert.deepEqual(await collect(store.list(`${scope()}/nothing/`)), []);
    });

    it("round-trips keys that need encoding", async () => {
      const p = scope();
      const names = ["with space.txt", "a+b=c&d.txt", "dollar$sign", "percent%20literal", "ünïcödé ✓.md", "quote'(paren)*!", "x~y_z-1.2"];
      for (const name of names) await store.put(`${p}/${name}`, name);
      for (const name of names) {
        assert.equal(decoder.decode(await store.get(`${p}/${name}`)), name, name);
        assert.equal(await store.exists(`${p}/${name}`), true, name);
      }
      const listed = (await collect(store.list(`${p}/`))).map((o) => o.key).sort();
      assert.deepEqual(listed, names.map((name) => `${p}/${name}`).sort());
    });

    it("rejects invalid keys", async () => {
      for (const key of ["", "/leading", "a/../b", "./a"]) {
        await rejectsWith(store.get(key), "invalid");
        await rejectsWith(store.put(key, "x"), "invalid");
      }
    });

    it("deletes a prefix and counts what it deleted", async () => {
      const p = scope();
      await store.put(`${p}/u1/a`, "x");
      await store.put(`${p}/u1/nested/b`, "x");
      await store.put(`${p}/u10/c`, "x");
      assert.equal(await store.deletePrefix(`${p}/u1/`), 2);
      assert.equal(await store.exists(`${p}/u1/a`), false);
      assert.equal(await store.exists(`${p}/u1/nested/b`), false);
      assert.equal(await store.exists(`${p}/u10/c`), true);
      assert.equal(await store.deletePrefix(`${p}/u1/`), 0);
    });

    it("refuses to delete with an empty prefix", async () => {
      await rejectsWith(store.deletePrefix(""), "invalid");
    });

    it("signs URLs for expiries up to 7 days ahead, and refuses past ones", async () => {
      const p = scope();
      await store.put(`${p}/f`, "x");
      const url = new URL(await store.signedUrl(`${p}/f`, { expiresAt: new Date(Date.now() + DAY_MS) }));
      assert.ok(url.protocol === "https:" || url.protocol === "http:");
      await store.signedUrl(`${p}/f`, { expiresAt: new Date(Date.now() + 7 * DAY_MS - 60_000) });
      await rejectsWith(store.signedUrl(`${p}/f`, { expiresAt: new Date(Date.now() - 1000) }), "invalid");
    });

    if (options.fetchSignedUrls) {
      it("serves a signed URL with the stored content type and disposition", async () => {
        const p = scope();
        const key = `${p}/report final.csv`;
        await store.put(key, "a,b\n1,2\n", { contentType: "text/csv", contentDisposition: 'attachment; filename="report final.csv"' });
        const response = await fetch(await store.signedUrl(key, { expiresAt: new Date(Date.now() + 60_000) }));
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "a,b\n1,2\n");
        assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
        assert.equal(response.headers.get("content-disposition"), 'attachment; filename="report final.csv"');
      });

      it("does not let a signed URL be used to write", async () => {
        const p = scope();
        await store.put(`${p}/ro`, "original");
        const url = await store.signedUrl(`${p}/ro`, { expiresAt: new Date(Date.now() + 60_000) });
        const response = await fetch(url, { method: "PUT", body: "changed" });
        assert.ok(response.status >= 400, `PUT through a read URL returned ${response.status}`);
        assert.equal(decoder.decode(await store.get(`${p}/ro`)), "original");
      });
    }
  });
}
