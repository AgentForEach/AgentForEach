import assert from "node:assert/strict";
import test from "node:test";
import type { HandlerContext, HttpRequestLike } from "@agentforeach/platform";
import { handleClientEvent, realtimeClientEvents } from "./client-events.js";
import { routes as wsMessageRoutes } from "./ws-message.js";

const context: HandlerContext = { invocationId: "inv-1", log() {}, warn() {}, error() {}, trace() {} };
const event = (data: string) => handleClientEvent({ userId: "u1", connectionId: "c1", text: async () => data }, context);
const json = (body: unknown) => JSON.parse(String(body));

test("client events: ping, and the messages refused before any work", async () => {
  const pong = await event('{"type":"ping"}');
  assert.equal(pong.status, 200);
  assert.equal(json(pong.body).type, "pong");
  assert.equal(pong.headers?.["Content-Type"], "application/json");

  assert.deepEqual([(await event("{not json")).status, json((await event("{not json")).body)], [400, { error: "Invalid JSON payload" }]);
  assert.deepEqual(json((await event("null")).body), { error: "Invalid message payload" });
  assert.deepEqual(json((await event('{"type":7}')).body), { error: "Invalid message payload" });
  assert.deepEqual(json((await event('{"type":"dance"}')).body), { error: "Unknown message type" });
  assert.equal((await event(JSON.stringify({ type: "chat", message: "x".repeat(4 * 1024 * 1024) }))).status, 413);
  assert.deepEqual(json((await event('{"type":"chat","message":"  "}')).body), { error: "Empty message" });
  assert.equal((await event('{"type":"chat","message":"hi","sessionId":"../x"}')).status, 400);
  assert.deepEqual(json((await event('{"type":"input_response"}')).body), { error: "Missing or invalid requestId" });
});

test("the Web PubSub upstream route checks the caller, then hands over the message", async () => {
  const handler = wsMessageRoutes.find((r) => r.name === "wsMessage")!.handler;
  const request = (method: string, headers: Record<string, string>, body = ""): HttpRequestLike =>
    ({
      method,
      url: "https://gw.example/api/ws/message",
      headers: new Headers(headers),
      query: new URLSearchParams(),
      params: {},
      text: async () => body,
      json: async () => JSON.parse(body),
    }) as unknown as HttpRequestLike;

  const preflight = await handler(request("OPTIONS", { "WebHook-Request-Origin": "afe.webpubsub.azure.com" }), context);
  assert.equal(preflight.headers?.["WebHook-Allowed-Origin"], "afe.webpubsub.azure.com");

  const saved = { s: process.env.WEBPUBSUB_UPSTREAM_SHARED_SECRET, c: process.env.WEBPUBSUB_CONNECTION_STRING };
  delete process.env.WEBPUBSUB_CONNECTION_STRING;
  process.env.WEBPUBSUB_UPSTREAM_SHARED_SECRET = "s3cret";
  try {
    const ce = { "x-webpubsub-upstream-secret": "s3cret", "ce-specversion": "1.0", "ce-type": "azure.webpubsub.user.message" };
    const anonymous = await handler(request("POST", ce, '{"type":"ping"}'), context);
    assert.deepEqual([anonymous.status, json(anonymous.body)], [401, { error: "Missing user identity" }]);
    const forged = await handler(request("POST", { ...ce, "x-webpubsub-upstream-secret": "wrong", "ce-userId": "u1", "ce-connectionId": "c1" }, '{"type":"ping"}'), context);
    assert.deepEqual([forged.status, json(forged.body)], [401, { error: "Unauthorized upstream caller" }]);
    const pong = await handler(request("POST", { ...ce, "ce-userId": "u1", "ce-connectionId": "c1" }, '{"type":"ping"}'), context);
    assert.equal(pong.status, 200);
    assert.equal(json(pong.body).type, "pong");
  } finally {
    if (saved.s === undefined) delete process.env.WEBPUBSUB_UPSTREAM_SHARED_SECRET;
    else process.env.WEBPUBSUB_UPSTREAM_SHARED_SECRET = saved.s;
    if (saved.c !== undefined) process.env.WEBPUBSUB_CONNECTION_STRING = saved.c;
  }
});

test("client events from a self-run hub: a 2xx body is the reply, anything else fails the event", async () => {
  const kept: Promise<unknown>[] = [];
  const onEvent = realtimeClientEvents((work) => kept.push(work));
  const reply = await onEvent({ userId: "u1", connectionId: "c1", event: "message", dataType: "json", data: { type: "ping" } });
  assert.equal((reply as { reply: { type: string } }).reply.type, "pong");
  await assert.rejects(
    onEvent({ userId: "u1", connectionId: "c1", event: "message", dataType: "json", data: { type: "dance" } }),
    /Unknown message type/,
  );
});
