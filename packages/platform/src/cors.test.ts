import test from "node:test";
import assert from "node:assert/strict";
import { corsHeaders, corsPolicy } from "./cors.js";

const allow = { methods: "GET,OPTIONS", headers: "Content-Type, Authorization" };

test("with no origins configured, any origin is allowed without credentials", () => {
  const policy = corsPolicy(undefined);
  assert.deepEqual(policy.origins, []);
  assert.deepEqual(corsHeaders(policy, "https://app.example", allow), {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
});

test("a listed origin is reflected, with credentials and Vary", () => {
  const policy = corsPolicy(" https://a.example , https://b.example,, ");
  assert.deepEqual(policy.origins, ["https://a.example", "https://b.example"]);
  const headers = corsHeaders(policy, "https://b.example", allow);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://b.example");
  assert.equal(headers["Access-Control-Allow-Credentials"], "true");
  assert.equal(headers.Vary, "Origin");
});

test("an origin that isn't listed is answered with the first listed one, so the browser refuses it", () => {
  const headers = corsHeaders(corsPolicy("https://a.example,https://b.example"), "https://evil.example", allow);
  assert.equal(headers["Access-Control-Allow-Origin"], "https://a.example");
});

test("a request without an Origin (not a browser) gets the wildcard", () => {
  const headers = corsHeaders(corsPolicy("https://a.example"), null, allow);
  assert.equal(headers["Access-Control-Allow-Origin"], "*");
  assert.equal(headers["Access-Control-Allow-Credentials"], undefined);
});
