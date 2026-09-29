import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import azureFunctions from "@azure/functions";

import { createEasyAuthProvider } from "./providers/easy-auth.js";
import { createInsecureHeaderProvider } from "./providers/insecure-header.js";
import { createTrustedProxyProvider } from "./providers/trusted-proxy.js";
import { isCrossSiteFormPost } from "./resolver.js";

const { HttpRequest } = azureFunctions;

const ENV_KEYS = [
  "WEBSITE_SITE_NAME",
  "WEBSITE_AUTH_ENABLED",
  "AUTH_ALLOW_INSECURE_USER_ID_HEADER",
  "AUTH_TRUST_EASY_AUTH_HEADERS",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

function request(headers: Record<string, string>, query = "") {
  return new HttpRequest({
    method: "GET",
    url: `https://example.test/api/chat${query}`,
    headers,
  });
}

function principalHeader(userId: string): string {
  return Buffer.from(
    JSON.stringify({
      auth_typ: "google",
      userId,
      claims: [{ typ: "email", val: "victim@example.com" }],
    }),
  ).toString("base64");
}

// --- insecure-header: never trust a client-supplied user id unless opted in ---

test("insecure-header is off by default, even off Azure (Docker, AKS)", async () => {
  setEnv({});
  const provider = createInsecureHeaderProvider({ type: "insecure-header" });
  assert.equal(await provider.resolve(request({ "x-user-id": "victim" })), null);
});

test("insecure-header resolves x-user-id when explicitly opted in locally", async () => {
  setEnv({ AUTH_ALLOW_INSECURE_USER_ID_HEADER: "true" });
  const provider = createInsecureHeaderProvider({ type: "insecure-header" });
  assert.equal((await provider.resolve(request({ "x-user-id": "alice" })))?.userId, "alice");
});

test("insecure-header is always off on Azure, even when the flag is on", async () => {
  setEnv({
    WEBSITE_SITE_NAME: "agentforeach-func",
    AUTH_ALLOW_INSECURE_USER_ID_HEADER: "true",
  });
  const provider = createInsecureHeaderProvider({ type: "insecure-header" });
  assert.equal(await provider.resolve(request({ "x-user-id": "victim" })), null);
  assert.equal(await provider.resolve(request({}, "?userId=victim")), null);
});

test("insecure-header ignores the deprecated requireEnvOptIn: false", async () => {
  setEnv({});
  const provider = createInsecureHeaderProvider({
    type: "insecure-header",
    requireEnvOptIn: false,
  });
  assert.equal(await provider.resolve(request({ "x-user-id": "victim" })), null);
});

// --- easy-auth: principal headers are only trusted when the platform sets them ---

test("easy-auth trusts the principal header when App Service auth is on", async () => {
  setEnv({ WEBSITE_SITE_NAME: "agentforeach-func", WEBSITE_AUTH_ENABLED: "True" });
  const provider = createEasyAuthProvider({ type: "easy-auth" });
  const ctx = await provider.resolve(
    request({ "x-ms-client-principal": principalHeader("user-1") }),
  );
  assert.equal(ctx?.userId, "user-1");
});

test("easy-auth ignores spoofed principal headers when App Service auth is off", async () => {
  setEnv({ WEBSITE_SITE_NAME: "agentforeach-func", AUTH_TRUST_EASY_AUTH_HEADERS: "true" });
  const provider = createEasyAuthProvider({ type: "easy-auth" });
  const ctx = await provider.resolve(
    request({
      "x-ms-client-principal": principalHeader("victim"),
      "x-ms-client-principal-id": "victim",
    }),
  );
  assert.equal(ctx, null);
});

test("easy-auth ignores principal headers off Azure unless explicitly trusted", async () => {
  setEnv({});
  const provider = createEasyAuthProvider({ type: "easy-auth" });
  const spoofed = request({ "x-ms-client-principal": principalHeader("victim") });
  assert.equal(await provider.resolve(spoofed), null);

  setEnv({ AUTH_TRUST_EASY_AUTH_HEADERS: "true" });
  const emulated = request({ "x-ms-client-principal": principalHeader("dev-user") });
  assert.equal((await provider.resolve(emulated))?.userId, "dev-user");
});

test("easy-auth keeps every role claim, not just the first", async () => {
  setEnv({ WEBSITE_SITE_NAME: "agentforeach-func", WEBSITE_AUTH_ENABLED: "True" });
  const provider = createEasyAuthProvider({ type: "easy-auth" });
  const principal = Buffer.from(
    JSON.stringify({
      auth_typ: "aad",
      role_typ: "roles",
      userId: "admin-user",
      claims: [
        { typ: "roles", val: "User" },
        { typ: "roles", val: "admin" },
      ],
    }),
  ).toString("base64");
  const ctx = await provider.resolve(request({ "x-ms-client-principal": principal }));
  assert.deepEqual(ctx?.roles, ["User", "admin"]);
});

// --- trusted-proxy: identity headers count only with the proxy's secret ---

test("trusted-proxy refuses requests without the shared secret, and everything when none is configured", async () => {
  process.env.TEST_PROXY_SECRET = "s3cret-value";
  try {
    const provider = createTrustedProxyProvider({
      type: "trusted-proxy",
      userHeader: "x-forwarded-user",
      sharedSecret: "$TEST_PROXY_SECRET",
      defaultRoles: ["user"],
    });
    assert.equal(await provider.resolve(request({ "x-forwarded-user": "alice" })), null, "direct request, no secret");
    assert.equal(await provider.resolve(request({ "x-forwarded-user": "alice", "x-proxy-secret": "guess" })), null);
    const ok = await provider.resolve(request({ "x-forwarded-user": "alice", "x-proxy-secret": "s3cret-value" }));
    assert.equal(ok?.userId, "alice");

    const unconfigured = createTrustedProxyProvider({ type: "trusted-proxy", userHeader: "x-forwarded-user" });
    assert.equal(await unconfigured.resolve(request({ "x-forwarded-user": "alice", "x-proxy-secret": "" })), null);
  } finally {
    delete process.env.TEST_PROXY_SECRET;
  }
});

// --- CSRF: cookie-authenticated POSTs must be JSON (forces a CORS preflight) ---

test("easy-auth POSTs without a JSON content type are treated as cross-site form posts", () => {
  const post = (headers: Record<string, string>) =>
    new HttpRequest({ method: "POST", url: "https://example.test/api/chat", headers });
  const cookie = { userId: "u", roles: [], source: "easy-auth" } as never;
  const bearer = { userId: "u", roles: [], source: "jwt" } as never;
  assert.equal(isCrossSiteFormPost(post({ "content-type": "text/plain" }), cookie), true);
  assert.equal(isCrossSiteFormPost(post({}), cookie), true);
  assert.equal(isCrossSiteFormPost(post({ "content-type": "application/json; charset=utf-8" }), cookie), false);
  assert.equal(isCrossSiteFormPost(post({ "content-type": "text/plain" }), bearer), false, "token auth isn't sent by browsers on their own");
  assert.equal(isCrossSiteFormPost(request({}), cookie), false, "GET");
});
