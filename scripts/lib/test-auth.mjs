/**
 * How the test scripts sign in as a test user, shared by the e2e scripts and
 * the load test.
 *
 * With LOADTEST_JWT_SECRET set (the scratch stack from
 * scripts/load-test/make-config.mjs), each request carries an HS256 JWT for
 * that user (issuer agentforeach-loadtest, audience agentforeach). Without it,
 * the user goes in x-user-id, which only a local gateway with
 * AUTH_ALLOW_INSECURE_USER_ID_HEADER=true accepts; a cloud host never does.
 */

import { createHmac } from "node:crypto";

export const ISSUER = "agentforeach-loadtest";
export const AUDIENCE = "agentforeach";

/** An HS256 JWT for `userId`, valid for `ttlSeconds`. */
export function testToken(secret, userId, { ttlSeconds = 3600, issuer = ISSUER, audience = AUDIENCE } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, iss: issuer, aud: audience, iat: now, exp: now + ttlSeconds })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** The headers that sign `userId` in: a bearer token when there's a secret, else x-user-id. */
export function userHeaders(userId, secret = process.env.LOADTEST_JWT_SECRET) {
  if (!userId) return {};
  return secret ? { Authorization: `Bearer ${testToken(secret, userId)}` } : { "x-user-id": userId };
}
