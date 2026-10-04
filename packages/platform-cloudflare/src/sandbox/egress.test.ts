/**
 * SandboxEgress in Node ("cloudflare:workers" resolves to a stub): what the
 * outbound handler sends on, and where.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import type { SandboxEgressProps } from "./egress-policy.js";

register("./workers-loader.testkit.js", import.meta.url);
const { SandboxEgress } = await import("./egress.js");

function egress(props: SandboxEgressProps) {
  type Ctor = new (ctx: unknown, env: unknown) => { fetch(request: Request): Promise<Response> };
  return new (SandboxEgress as unknown as Ctor)({ props }, {});
}

const props: SandboxEgressProps = {
  allowHosts: ["example.com"],
  internet: false,
  credentials: [{ key: "ECHO", hosts: ["postman-echo.com"], header: "Authorization", value: "Bearer s3cret" }],
};

test("a credential goes only to the host the request is re-sent to, the one it was matched on (live check)", async (t) => {
  const sent: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: Request) => {
    sent.push(input);
    return new Response("ok");
  });
  // A sandbox's `curl https://example.com/headers -H 'Host: postman-echo.com'` reaches the
  // handler as a request for postman-echo.com: the SNI (example.com) isn't visible here.
  await egress(props).fetch(new Request("https://postman-echo.com/headers"));
  await egress(props).fetch(new Request("https://example.com/headers", { headers: { authorization: "Bearer placeholder" } }));

  assert.equal(new URL(sent[0].url).host, "postman-echo.com");
  assert.equal(sent[0].headers.get("authorization"), "Bearer s3cret", "matched and sent to the same host");
  assert.equal(new URL(sent[1].url).host, "example.com");
  assert.equal(sent[1].headers.get("authorization"), "Bearer placeholder", "no credential for another host");
});

test("a host that is neither allowed nor credentialed is refused before anything is sent", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("ok"));
  const response = await egress(props).fetch(new Request("https://elsewhere.example.net/"));
  assert.equal(response.status, 403);
  assert.equal(fetch.mock.callCount(), 0);
});
