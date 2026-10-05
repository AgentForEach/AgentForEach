import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { testToken, userHeaders } from "./test-auth.mjs";

const claims = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

test("a test token is an HS256 JWT for the user, signed with the secret", () => {
  const token = testToken("s3cret", "alice", { ttlSeconds: 60 });
  const [head, body, sig] = token.split(".");
  assert.equal(sig, createHmac("sha256", "s3cret").update(`${head}.${body}`).digest("base64url"));
  const c = claims(token);
  assert.deepEqual([c.sub, c.iss, c.aud, c.exp - c.iat], ["alice", "agentforeach-loadtest", "agentforeach", 60]);
});

test("with a secret the user signs in with a bearer token; without one, x-user-id", () => {
  assert.equal(claims(userHeaders("bob", "s3cret").Authorization.slice("Bearer ".length)).sub, "bob");
  assert.deepEqual(userHeaders("bob", ""), { "x-user-id": "bob" });
  assert.deepEqual(userHeaders(undefined, "s3cret"), {});
});
