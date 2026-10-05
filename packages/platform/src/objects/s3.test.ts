import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeXml, parseListObjectsV2, parseListObjectVersions, S3ObjectStore } from "./s3.js";
import { presignedUrlExpiry } from "./sigv4.js";

type Call = { method: string; url: URL; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal };

/** A store whose `fetch` records requests and answers from `reply`. */
function fakeStore(reply: (call: Call) => Response, options: Partial<ConstructorParameters<typeof S3ObjectStore>[0]> = {}) {
  const calls: Call[] = [];
  const store = new S3ObjectStore({
    endpoint: "https://s3.example.test",
    bucket: "exports",
    region: "auto",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    now: () => new Date("2026-10-02T00:00:00Z"),
    retryDelayMs: 0,
    fetch: async (input, init) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        headers: init?.headers as Record<string, string>,
        body: init?.body as Uint8Array | undefined,
        signal: init?.signal ?? undefined,
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
      `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>p/a</Key><Size>1</Size></Contents><NextContinuationToken>t2</NextContinuationToken></ListBucketResult>`,
      `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/b</Key><Size>2</Size></Contents></ListBucketResult>`,
    ];
    const { store, calls } = fakeStore(() => new Response(pages.shift()));
    const keys: string[] = [];
    for await (const o of store.list("p/")) keys.push(o.key);
    assert.deepEqual(keys, ["p/a", "p/b"]);
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

  it("keeps a store's objects under its prefix, and returns keys relative to it", async () => {
    const listing = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>exports/u/a.txt</Key><Size>1</Size></Contents><Contents><Key>exports/u/dir/</Key><Size>0</Size></Contents><Contents><Key>other/u/b.txt</Key><Size>1</Size></Contents></ListBucketResult>`;
    const { store, calls } = fakeStore((call) => (call.method === "GET" && !call.url.pathname.endsWith(".txt") ? new Response(listing) : new Response("x")), {
      prefix: "exports/",
    });
    await store.put("u/a.txt", "x");
    assert.equal(calls[0].url.pathname, "/exports/exports/u/a.txt");
    assert.equal(new TextDecoder().decode(await store.get("u/a.txt")), "x");
    const keys: string[] = [];
    for await (const o of store.list("u/")) keys.push(o.key);
    assert.deepEqual(keys, ["u/a.txt"], "relative keys, no markers, nothing outside the prefix");
    assert.equal(calls.at(-1)!.url.searchParams.get("prefix"), "exports/u/");
    assert.match(await store.signedUrl("u/a.txt", { expiresAt: new Date("2026-10-02T01:00:00Z") }), /^https:\/\/s3\.example\.test\/exports\/exports\/u\/a\.txt\?/);
    for (const prefix of ["exports", "/exports/", "a//b/"]) {
      assert.throws(() => fakeStore(() => new Response(), { prefix }), { code: "invalid" }, prefix);
    }
  });

  it("deletes directory markers with the prefix they're under, though list skips them", async () => {
    const listing = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>u/</Key><Size>0</Size></Contents><Contents><Key>u/a</Key><Size>1</Size></Contents><Contents><Key>u/b\\c</Key><Size>1</Size></Contents></ListBucketResult>`;
    const { store, calls } = fakeStore((call) => (call.method === "GET" ? new Response(listing) : new Response(null, { status: 204 })));
    const listed: string[] = [];
    for await (const o of store.list("u/")) listed.push(o.key);
    assert.deepEqual(listed, ["u/a", "u/b\\c"]);
    assert.equal(await store.deletePrefix("u/"), 3);
    assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.url.pathname).sort(), ["/exports/u/", "/exports/u/a", "/exports/u/b%5Cc"]);
  });

  it("sends the expected bucket owner on every request, signed", async () => {
    const listing = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>u/a</Key><Size>1</Size></Contents></ListBucketResult>`;
    const versions = `<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>u/a</Key><VersionId>v1</VersionId></Version></ListVersionsResult>`;
    const reply = (call: Call) =>
      call.method === "GET" && call.url.searchParams.has("versions") ? new Response(versions) : call.method === "GET" && call.url.searchParams.has("list-type") ? new Response(listing) : new Response("x");
    const { store, calls } = fakeStore(reply, { expectedBucketOwner: "123456789012" });
    await store.put("u/a", "x");
    await store.get("u/a");
    await store.exists("u/a");
    for await (const _ of store.list("u/"));
    await store.deletePrefix("u/");
    const versioned = fakeStore(reply, { expectedBucketOwner: "123456789012", deleteVersions: true });
    await versioned.store.deletePrefix("u/");
    const all = [...calls, ...versioned.calls];
    assert.deepEqual([...new Set(all.map((c) => c.method))].sort(), ["DELETE", "GET", "HEAD", "PUT"]);
    for (const call of all) {
      assert.equal(call.headers["x-amz-expected-bucket-owner"], "123456789012", `${call.method} ${call.url}`);
      assert.match(call.headers.authorization, /SignedHeaders=[^,]*x-amz-expected-bucket-owner/);
    }
    assert.throws(() => fakeStore(reply, { expectedBucketOwner: "acme" }), { code: "invalid" });
  });

  it("encrypts uploads with the KMS key when one is set", async () => {
    const { store, calls } = fakeStore(() => new Response(null, { status: 200 }), { kmsKeyId: "alias/agentforeach-exports" });
    await store.put("k", "v");
    assert.equal(calls[0].headers["x-amz-server-side-encryption"], "aws:kms");
    assert.equal(calls[0].headers["x-amz-server-side-encryption-aws-kms-key-id"], "alias/agentforeach-exports");
    const plain = fakeStore(() => new Response(null, { status: 200 }));
    await plain.store.put("k", "v");
    assert.equal(plain.calls[0].headers["x-amz-server-side-encryption"], undefined, "the bucket's own encryption otherwise");
  });

  it("retries throttling, server errors and network failures, re-signing each attempt", async () => {
    const replies: Array<() => Response> = [() => xmlError(503, "SlowDown"), () => { throw new TypeError("fetch failed"); }, () => new Response("ok")];
    const { store, calls } = fakeStore(() => replies.shift()!());
    assert.equal(new TextDecoder().decode(await store.get("k")), "ok");
    assert.equal(calls.length, 3);

    const throttled = fakeStore(() => xmlError(429, "TooManyRequests"));
    await assert.rejects(throttled.store.put("k", "v"), { code: "unavailable", message: /429/ });
    assert.equal(throttled.calls.length, 3, "three attempts by default");

    const once = fakeStore(() => xmlError(500, "InternalError"), { maxAttempts: 1 });
    await assert.rejects(once.store.exists("k"), { code: "unavailable" });
    assert.equal(once.calls.length, 1);

    const missing = fakeStore(() => xmlError(404, "NoSuchKey"));
    await assert.rejects(missing.store.get("k"), { code: "not_found" });
    assert.equal(missing.calls.length, 1, "client errors are not retried");
  });

  it("times out an attempt that gets no response, then retries it", async () => {
    let attempts = 0;
    const { store } = fakeStore(() => new Response(), {
      timeoutMs: 20,
      maxAttempts: 2,
      fetch: async (_input, init) => {
        attempts++;
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      },
    });
    await assert.rejects(store.exists("k"), { code: "unavailable", message: /timed out after 20 ms/ });
    assert.equal(attempts, 2);
  });

  it("parses a ListObjectVersions page", () => {
    const page = parseListObjectVersions(`<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>u/b</NextKeyMarker><NextVersionIdMarker>v9</NextVersionIdMarker>
<Version><Key>u/a&amp;1</Key><VersionId>v2</VersionId><IsLatest>true</IsLatest><Size>3</Size></Version>
<Version><Key>u/a&amp;1</Key><VersionId>v1</VersionId><IsLatest>false</IsLatest><Size>2</Size></Version>
<DeleteMarker><Key>u/b</Key><VersionId>v9</VersionId><IsLatest>true</IsLatest></DeleteMarker></ListVersionsResult>`);
    assert.deepEqual(page.versions, [
      { key: "u/a&1", versionId: "v2" },
      { key: "u/a&1", versionId: "v1" },
      { key: "u/b", versionId: "v9" },
    ]);
    assert.equal(page.truncated, true);
    assert.equal(page.nextKeyMarker, "u/b");
    assert.equal(page.nextVersionIdMarker, "v9");
  });

  it("with deleteVersions, deletes every version and delete marker, page by page", async () => {
    const pages = [
      `<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>u/a</NextKeyMarker><NextVersionIdMarker>v1</NextVersionIdMarker><Version><Key>u/a</Key><VersionId>v2</VersionId></Version><Version><Key>u/a</Key><VersionId>v1</VersionId></Version></ListVersionsResult>`,
      `<ListVersionsResult><IsTruncated>false</IsTruncated><DeleteMarker><Key>u/b</Key><VersionId>m1</VersionId></DeleteMarker><Version><Key>u/b</Key><VersionId>v0</VersionId></Version><Version><Key>u/c</Key><VersionId>null</VersionId></Version></ListVersionsResult>`,
    ];
    const { store, calls } = fakeStore((call) => (call.method === "GET" ? new Response(pages.shift()) : new Response(null, { status: 204 })), {
      deleteVersions: true,
    });
    assert.equal(await store.deletePrefix("u/"), 3, "each object counts once");
    const lists = calls.filter((c) => c.method === "GET");
    assert.equal(lists[0].url.searchParams.get("prefix"), "u/");
    assert.equal(lists[0].url.searchParams.has("versions"), true);
    assert.equal(lists[1].url.searchParams.get("key-marker"), "u/a");
    assert.equal(lists[1].url.searchParams.get("version-id-marker"), "v1");
    assert.deepEqual(
      calls.filter((c) => c.method === "DELETE").map((c) => `${c.url.pathname}?versionId=${c.url.searchParams.get("versionId")}`).sort(),
      ["/exports/u/a?versionId=v1", "/exports/u/a?versionId=v2", "/exports/u/b?versionId=m1", "/exports/u/b?versionId=v0", "/exports/u/c?versionId=null"],
    );

    const stuck = `<ListVersionsResult><IsTruncated>true</IsTruncated></ListVersionsResult>`;
    await assert.rejects(fakeStore(() => new Response(stuck), { deleteVersions: true }).store.deletePrefix("u/"), { code: "provider_error" });
    assert.equal(await fakeStore(() => xmlError(404, "NoSuchBucket"), { deleteVersions: true }).store.deletePrefix("u/"), 0);
  });

  it("cuts presigned links short to end a minute before temporary credentials do", async () => {
    const now = new Date("2026-10-02T00:00:00.400Z");
    const expiration = new Date("2026-10-02T00:10:00Z");
    const { store } = fakeStore(() => new Response(), {
      now: () => now,
      credentials: async () => ({ accessKeyId: "ASIAEXAMPLE", secretAccessKey: "s", sessionToken: "token", expiration }),
    });
    const { url, expiresAt } = await store.signedUrlWithExpiry("k", { expiresAt: new Date("2026-10-03T00:00:00Z") });
    assert.equal(new URL(url).searchParams.get("X-Amz-Expires"), "540");
    assert.equal(expiresAt.toISOString(), "2026-10-02T00:09:00.000Z");
    assert.equal(presignedUrlExpiry(url).toISOString(), expiresAt.toISOString(), "the link's own expiry");
    assert.equal(new URL(url).searchParams.get("X-Amz-Security-Token"), "token");

    const sooner = await store.signedUrlWithExpiry("k", { expiresAt: new Date("2026-10-02T00:05:00Z") });
    assert.equal(sooner.expiresAt.toISOString(), "2026-10-02T00:05:00.000Z", "a link ending before the credentials is unchanged");
    assert.equal(await store.signedUrl("k", { expiresAt: new Date("2026-10-03T00:00:00Z") }), url);

    const expiring = fakeStore(() => new Response(), {
      now: () => now,
      credentials: async () => ({ accessKeyId: "a", secretAccessKey: "s", expiration: new Date(now.getTime() + 60_500) }),
    });
    await assert.rejects(expiring.store.signedUrl("k", { expiresAt: new Date("2026-10-03T00:00:00Z") }), { code: "unavailable" });
  });

  it("rejects keys the current rules refuse before sending anything", async () => {
    const { store, calls } = fakeStore(() => new Response());
    for (const key of ["a//b", "dir/", "back\\slash", "tab\tkey"]) await assert.rejects(store.put(key, "x"), { code: "invalid" }, key);
    assert.equal(calls.length, 0);
  });

  it("caps links at maxSignedUrlSeconds and reports the capped expiry", async () => {
    const now = new Date("2026-10-02T00:00:00.400Z");
    const { store } = fakeStore(() => new Response(), { now: () => now, maxSignedUrlSeconds: 3600 });
    const { url, expiresAt } = await store.signedUrlWithExpiry("k", { expiresAt: new Date("2026-10-03T00:00:00Z") });
    assert.equal(new URL(url).searchParams.get("X-Amz-Expires"), "3600");
    assert.equal(expiresAt.toISOString(), "2026-10-02T01:00:00.000Z");
    assert.equal(presignedUrlExpiry(url).toISOString(), expiresAt.toISOString());
    const sooner = await store.signedUrlWithExpiry("k", { expiresAt: new Date("2026-10-02T00:30:00Z") });
    assert.equal(sooner.expiresAt.toISOString(), "2026-10-02T00:30:00.000Z", "a shorter link is unchanged");
    await assert.rejects(store.signedUrl("k", { expiresAt: new Date("2026-10-10T00:00:00Z") }), { code: "invalid" }, "past 7 days is still refused");

    const both = fakeStore(() => new Response(), {
      now: () => now,
      maxSignedUrlSeconds: 3600,
      credentials: async () => ({ accessKeyId: "a", secretAccessKey: "s", expiration: new Date("2026-10-02T00:20:00Z") }),
    });
    assert.equal((await both.store.signedUrlWithExpiry("k", { expiresAt: new Date("2026-10-03T00:00:00Z") })).expiresAt.toISOString(), "2026-10-02T00:19:00.000Z", "the sooner limit wins");
    for (const bad of [0, 1.5, 604801]) assert.throws(() => fakeStore(() => new Response(), { maxSignedUrlSeconds: bad }), { code: "invalid" }, String(bad));
  });
});
