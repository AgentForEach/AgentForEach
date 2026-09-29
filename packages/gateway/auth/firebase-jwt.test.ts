import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, test } from "node:test";
import azureFunctions from "@azure/functions";
import type { HttpRequest as HttpRequestType } from "@azure/functions";

import { createJwtProvider, resetJwksCache } from "./providers/jwt.js";

const { HttpRequest } = azureFunctions;

const issuer = "https://securetoken.google.com/example-project";
const audience = "example-project";
const keyId = "firebase-test-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = publicKey.export({ format: "jwk" });
const originalFetch = globalThis.fetch;

globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      keys: [{ ...publicJwk, kid: keyId, alg: "RS256", use: "sig" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

after(() => {
  globalThis.fetch = originalFetch;
});

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createToken(overrides: Record<string, unknown> = {}): string {
  const header = encode({ alg: "RS256", typ: "JWT", kid: keyId });
  const payload = encode({
    iss: issuer,
    aud: audience,
    sub: "firebase-user-1",
    email: "user@example.com",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const provider = createJwtProvider({
  type: "jwt",
  enabled: true,
  algorithm: "RS256",
  jwksUri: "https://example.test/firebase-jwks",
  issuer,
  audience,
  userIdClaim: "sub",
  roleClaims: [],
  emailClaim: "email",
});

function request(token: string): HttpRequestType {
  return new HttpRequest({
    method: "GET",
    url: "https://example.test/api/chat",
    headers: { Authorization: `Bearer ${token}` },
  });
}

test("accepts a valid Firebase-shaped RS256 token", async () => {
  const auth = await provider.resolve(request(createToken()));
  assert.equal(auth?.userId, "firebase-user-1");
  assert.equal(auth?.email, "user@example.com");
  assert.equal(auth?.source, "jwt");
});

test("rejects Firebase tokens for a different audience", async () => {
  const auth = await provider.resolve(
    request(createToken({ aud: "another-project" })),
  );
  assert.equal(auth, null);
});

test("rejects expired Firebase tokens (beyond the 60 s clock-skew leeway)", async () => {
  const auth = await provider.resolve(
    request(createToken({ exp: Math.floor(Date.now() / 1000) - 120 })),
  );
  assert.equal(auth, null);
});

test("rejects tokens without an exp claim", async () => {
  assert.equal(await provider.resolve(request(createToken({ exp: undefined }))), null);
});

test("accepts tokens without exp only when requireExp is off", async () => {
  const lenient = createJwtProvider({
    type: "jwt",
    algorithm: "RS256",
    jwksUri: "https://example.test/firebase-jwks",
    issuer,
    audience,
    requireExp: false,
  });
  assert.equal((await lenient.resolve(request(createToken({ exp: undefined }))))?.userId, "firebase-user-1");
});

test("rejects a token whose header names a different algorithm", async () => {
  // Same valid RSA signature, but the header claims "none" / HS256.
  for (const alg of ["none", "HS256"]) {
    const [, payload, signature] = createToken().split(".");
    const header = encode({ alg, typ: "JWT", kid: keyId });
    assert.equal(await provider.resolve(request(`${header}.${payload}.${signature}`)), null, alg);
  }
});

test("an unknown kid refetches the JWKS once (key rotation), rate-limited", async () => {
  const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rotatedJwk = { ...rotated.publicKey.export({ format: "jwk" }), kid: "rotated", alg: "RS256" };
  resetJwksCache(); // no state from earlier tests
  let fetches = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    if (!String(input).includes("rotating-jwks")) return previous(input);
    fetches++;
    const keys = fetches === 1 ? [{ ...publicJwk, kid: keyId, alg: "RS256" }] : [{ ...publicJwk, kid: keyId, alg: "RS256" }, rotatedJwk];
    return new Response(JSON.stringify({ keys }), { status: 200 });
  };
  try {
    const rotating = createJwtProvider({
      type: "jwt",
      algorithm: "RS256",
      jwksUri: "https://example.test/rotating-jwks",
      issuer,
      audience,
    });
    // Prime the cache with the old key set.
    assert.ok(await rotating.resolve(request(createToken())));
    assert.equal(fetches, 1);

    // A token signed with the new key: refetch, then accept.
    const header = encode({ alg: "RS256", typ: "JWT", kid: "rotated" });
    const payload = encode({ iss: issuer, aud: audience, sub: "u2", exp: Math.floor(Date.now() / 1000) + 300 });
    const sig = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), rotated.privateKey).toString("base64url");
    assert.equal((await rotating.resolve(request(`${header}.${payload}.${sig}`)))?.userId, "u2");
    assert.equal(fetches, 2);

    // A made-up kid right after doesn't trigger another fetch (rate limit).
    const bogus = encode({ alg: "RS256", typ: "JWT", kid: "made-up" });
    assert.equal(await rotating.resolve(request(`${bogus}.${payload}.${sig}`)), null);
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = previous;
  }
});
function signWith(key: typeof privateKey, header: object, claims: object): string {
  const h = encode(header);
  const p = encode(claims);
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

test("a token without kid is checked against every RSA signing key; EC keys are skipped", async () => {
  const second = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  resetJwksCache();
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    if (!String(input).includes("multi-jwks")) return previous(input);
    const keys = [
      { ...ec.publicKey.export({ format: "jwk" }), kid: "ec-key" },
      { ...publicJwk, kid: keyId, alg: "RS256", use: "sig" },
      { ...second.publicKey.export({ format: "jwk" }), alg: "RS256" }, // no kid
    ];
    return new Response(JSON.stringify({ keys }), { status: 200 });
  };
  try {
    const multi = createJwtProvider({ type: "jwt", algorithm: "RS256", jwksUri: "https://example.test/multi-jwks", issuer, audience });
    const claims = { iss: issuer, aud: audience, sub: "u3", exp: Math.floor(Date.now() / 1000) + 300 };
    const noKid = signWith(second.privateKey, { alg: "RS256", typ: "JWT" }, claims);
    assert.equal((await multi.resolve(request(noKid)))?.userId, "u3");
    // A kid naming the EC key finds no usable key (rejected, not a crash).
    const ecKid = signWith(second.privateKey, { alg: "RS256", typ: "JWT", kid: "ec-key" }, claims);
    assert.equal(await multi.resolve(request(ecKid)), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test("during a JWKS outage cached keys keep working and fetches back off", async () => {
  resetJwksCache();
  let fetches = 0;
  let down = false;
  const previous = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = async (input: string | URL | Request) => {
    if (!String(input).includes("flaky-jwks")) return previous(input);
    fetches++;
    if (down) throw new Error("connect ETIMEDOUT");
    return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: keyId, alg: "RS256" }] }), { status: 200 });
  };
  try {
    const flaky = createJwtProvider({ type: "jwt", algorithm: "RS256", jwksUri: "https://example.test/flaky-jwks", issuer, audience });
    assert.ok(await flaky.resolve(request(createToken())));
    assert.equal(fetches, 1);

    // Two hours later the cache has expired and the issuer is down.
    down = true;
    const later = realNow() + 2 * 3600_000;
    Date.now = () => later;
    assert.equal((await flaky.resolve(request(createToken())))?.userId, "firebase-user-1");
    assert.equal(fetches, 2);
    // The next login doesn't wait on another failing fetch.
    assert.ok(await flaky.resolve(request(createToken())));
    assert.equal(fetches, 2);
  } finally {
    Date.now = realNow;
    globalThis.fetch = previous;
  }
});

test("a non-numeric exp or nbf is rejected, even when exp is optional", async () => {
  const lenient = createJwtProvider({
    type: "jwt",
    algorithm: "RS256",
    jwksUri: "https://example.test/firebase-jwks",
    issuer,
    audience,
    requireExp: false,
  });
  assert.equal(await lenient.resolve(request(createToken({ exp: "9999999999" }))), null);
  assert.equal(await lenient.resolve(request(createToken({ exp: undefined, nbf: "0" }))), null);
});
