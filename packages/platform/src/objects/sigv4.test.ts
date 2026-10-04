/**
 * SigV4 against the worked examples in the Amazon S3 API reference
 * ("Signature Calculations for the Authorization Header" and "Authenticating
 * Requests: Using Query Parameters"). The credentials are AWS's documented
 * example credentials, not real ones.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presignUrl, sha256Hex, signRequest, uriEncode, canonicalPath, type SigningScope } from "./sigv4.js";

const scope: SigningScope = {
  credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  region: "us-east-1",
  service: "s3",
};
const now = new Date("2013-05-24T00:00:00Z");
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function signatureOf(authorization: string): string {
  return /Signature=([0-9a-f]{64})/.exec(authorization)?.[1] ?? "";
}

describe("sigv4", () => {
  it("hashes the empty payload", async () => {
    assert.equal(await sha256Hex(""), EMPTY_SHA);
  });

  it("GET object with a Range header", async () => {
    const headers = await signRequest(scope, {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      now,
    });
    assert.match(headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
    assert.equal(signatureOf(headers.authorization), "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("PUT object with a key that needs encoding", async () => {
    const headers = await signRequest(scope, {
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      body: "Welcome to Amazon S3.",
      now,
    });
    assert.equal(signatureOf(headers.authorization), "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("GET bucket (list objects) with query parameters", async () => {
    const headers = await signRequest(scope, {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      now,
    });
    assert.equal(signatureOf(headers.authorization), "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("presigned GET URL", async () => {
    const url = await presignUrl(scope, {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      expiresInSeconds: 86400,
      now,
    });
    assert.equal(url.searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    assert.equal(url.searchParams.get("X-Amz-Credential"), "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
  });

  it("rejects expiries outside SigV4's 7-day limit", async () => {
    const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
    await assert.rejects(presignUrl(scope, { method: "GET", url, expiresInSeconds: 0 }), RangeError);
    await assert.rejects(presignUrl(scope, { method: "GET", url, expiresInSeconds: 604801 }), RangeError);
  });

  it("encodes the characters encodeURIComponent leaves alone", () => {
    assert.equal(uriEncode("a b!'()*~_-."), "a%20b%21%27%28%29%2A~_-.");
    assert.equal(canonicalPath("/user%20files/a+b/%E2%9C%93.txt"), "/user%20files/a%2Bb/%E2%9C%93.txt");
  });
});
