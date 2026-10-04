import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeXml, parseListObjectsV2, S3ObjectStore } from "./s3.js";

type Call = { method: string; url: URL; headers: Record<string, string>; body?: Uint8Array };

/** A store whose `fetch` records requests and answers from `reply`. */
function fakeStore(reply: (call: Call) => Response, options: Partial<ConstructorParameters<typeof S3ObjectStore>[0]> = {}) {
  const calls: Call[] = [];
  const store = new S3ObjectStore({
    endpoint: "https://s3.example.test",
    bucket: "exports",
    region: "auto",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    now: () => new Date("2026-10-02T00:00:00Z"),
    fetch: async (input, init) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        headers: init?.headers as Record<string, string>,
        body: init?.body as Uint8Array | undefined,
      };
      calls.push(call);
      return reply(call);
    },
    ...options,
  });
  return { store, calls };
}

const xmlError = (status: number, code: string) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`, { status });

describe("s3 provider", () => {
  it("decodes XML entities and character references", () => {
    assert.equal(decodeXml("a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233; &#x2713;"), `a&b <c> "d" 'e' é ✓`);
    assert.equal(decodeXml("&amp;lt;"), "&lt;");
  });

  it("parses a ListObjectsV2 page", () => {
    const page = parseListObjectsV2(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>u/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>true</IsTruncated>
<Contents><Key>u/a&amp;b.txt</Key><LastModified>2026-10-01T10:00:00.000Z</LastModified><ETag>&quot;x&quot;</ETag><Size>12</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>u/c</Key><LastModified>2026-10-01T11:00:00.000Z</LastModified><Size>0</Size></Contents>
<NextContinuationToken>tok/+=</NextContinuationToken></ListBucketResult>`);
    assert.deepEqual(page.objects.map((o) => [o.key, o.size, o.lastModified?.toISOString()]), [
      ["u/a&b.txt", 12, "2026-10-01T10:00:00.000Z"],
      ["u/c", 0, "2026-10-01T11:00:00.000Z"],
    ]);
    assert.equal(page.truncated, true);
    assert.equal(page.nextContinuationToken, "tok/+=");
  });

  it("sends path-style URLs with each key segment encoded once", async () => {
    const { store, calls } = fakeStore(() => new Response(null, { status: 200 }));
    await store.exists("user a/b+c$.txt");
    assert.equal(calls[0].method, "HEAD");
    assert.equal(calls[0].url.pathname, "/exports/user%20a/b%2Bc%24.txt");
    assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261002\/auto\/s3\/aws4_request, /);
    assert.equal(calls[0].headers.host, undefined);
  });

  it("supports virtual-hosted addressing", async () => {
    const { store, calls } = fakeStore(() => new Response(null, { status: 200 }), { addressing: "virtual" });
    await store.exists("k");
    assert.equal(calls[0].url.host, "exports.s3.example.test");
    assert.equal(calls[0].url.pathname, "/k");
  });

  it("puts with the payload hash, content type and disposition", async () => {
    const { store, calls } = fakeStore(() => new Response(null, { status: 200 }));
    await store.put("k", "hello", { contentType: "text/plain", contentDisposition: 'attachment; filename="k.txt"' });
    const h = calls[0].headers;
    assert.equal(h["x-amz-content-sha256"], "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(h["content-type"], "text/plain");
    assert.equal(h["content-disposition"], 'attachment; filename="k.txt"');
    assert.match(h.authorization, /SignedHeaders=content-disposition;content-type;host;x-amz-content-sha256;x-amz-date,/);
    assert.equal(new TextDecoder().decode(calls[0].body), "hello");
  });

  it("follows continuation tokens; a missing bucket is not_found to list and empty to delete", async () => {
    const pages = [
      `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a</Key><Size>1</Size></Contents><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>b</Key><Size>2</Size></Contents></ListBucketResult>`,
    ];
    const { store, calls } = fakeStore(() => new Response(pages.shift()));
    const keys: string[] = [];
    for await (const o of store.list("p/")) keys.push(o.key);
    assert.deepEqual(keys, ["a", "b"]);
    assert.equal(calls[0].url.searchParams.get("prefix"), "p/");
    assert.equal(calls[1].url.searchParams.get("continuation-token"), "t2");

    const missing = fakeStore(() => xmlError(404, "NoSuchBucket")).store;
    await assert.rejects(async () => {
      for await (const _ of missing.list()) assert.fail("expected no objects");
    }, { code: "not_found" });
    assert.equal(await missing.deletePrefix("u/"), 0);
  });

  it("refuses an oversize object from Content-Length without reading it", async () => {
    const { store } = fakeStore(() => new Response(new Uint8Array(100), { headers: { "content-length": "100" } }));
    await assert.rejects(store.get("k", { maxBytes: 99 }), { code: "too_large" });
    assert.equal((await store.get("k", { maxBytes: 100 })).byteLength, 100);
  });

  it("maps service errors to codes", async () => {
    await assert.rejects(fakeStore(() => xmlError(404, "NoSuchKey")).store.get("k"), { code: "not_found", message: /NoSuchKey/ });
    await assert.rejects(fakeStore(() => xmlError(403, "SignatureDoesNotMatch")).store.put("k", "v"), { code: "unauthorized" });
    await assert.rejects(fakeStore(() => xmlError(503, "SlowDown")).store.get("k"), { code: "unavailable" });
    const failing = fakeStore(() => {
      throw new TypeError("fetch failed");
    }).store;
    await assert.rejects(failing.exists("k"), { code: "unavailable" });
  });

  it("creates a missing bucket with its region, then retries the put", async () => {
    let bucketExists = false;
    const { store, calls } = fakeStore(
      (call) => {
        if (call.url.pathname === "/exports") {
          bucketExists = true;
          return new Response(null, { status: 200 });
        }
        return bucketExists ? new Response(null, { status: 200 }) : xmlError(404, "NoSuchBucket");
      },
      { createBucket: true, region: "eu-west-1" },
    );
    await store.put("k", "v");
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.pathname}`), ["PUT /exports/k", "PUT /exports", "PUT /exports/k"]);
    assert.match(new TextDecoder().decode(calls[1].body), /<LocationConstraint>eu-west-1<\/LocationConstraint>/);
  });

  it("does not create the bucket unless asked", async () => {
    const { store, calls } = fakeStore(() => xmlError(404, "NoSuchBucket"));
    await assert.rejects(store.put("k", "v"), { code: "not_found" });
    assert.equal(calls.length, 1);
  });

  it("deletes a prefix with bounded concurrency and ignores vanished objects", async () => {
    let inFlight = 0;
    let peak = 0;
    const listing = `<ListBucketResult><IsTruncated>false</IsTruncated>${Array.from({ length: 10 }, (_, i) => `<Contents><Key>u/${i}</Key><Size>1</Size></Contents>`).join("")}</ListBucketResult>`;
    const { store } = fakeStore(
      (call) => {
        if (call.method === "GET") return new Response(listing);
        inFlight++;
        peak = Math.max(peak, inFlight);
        queueMicrotask(() => inFlight--);
        return new Response(null, { status: call.url.pathname.endsWith("/3") ? 404 : 204 });
      },
      { deleteConcurrency: 3 },
    );
    assert.equal(await store.deletePrefix("u/"), 9);
    assert.ok(peak <= 3, `peak concurrency ${peak}`);
  });

  it("presigns a GET for the object path", async () => {
    const { store } = fakeStore(() => new Response(null));
    const url = new URL(await store.signedUrl("u/report final.csv", { expiresAt: new Date("2026-10-03T00:00:00Z") }));
    assert.equal(url.pathname, "/exports/u/report%20final.csv");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "86400");
    assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
    assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
  });

  it("rejects invalid bucket names", () => {
    assert.throws(
      () => new S3ObjectStore({ endpoint: "https://x.test", bucket: "Bad_Bucket", credentials: { accessKeyId: "a", secretAccessKey: "b" } }),
      { code: "invalid" },
    );
  });
});
