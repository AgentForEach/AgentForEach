import test from "node:test";
import assert from "node:assert/strict";

import { backgroundTurnsEnabled, chatTurnIds } from "./chat-turn.js";
import { isValidSessionId } from "../sessions/ids.js";

test("a retried request maps onto the same run, orchestration and session", () => {
  const a = chatTurnIds("u1", "key-123");
  const b = chatTurnIds("u1", "key-123");
  assert.deepEqual(a, b);
  assert.match(a.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isValidSessionId(a.newSessionId), true);
  assert.notDeepEqual(chatTurnIds("u2", "key-123"), a, "keys are per user");
  const x = chatTurnIds("u1");
  const y = chatTurnIds("u1");
  assert.notEqual(x.runId, y.runId, "no key: a fresh run each time");
  assert.notEqual(x.newSessionId, y.newSessionId);
  assert.equal(isValidSessionId(x.newSessionId), true);
});

test("background turns: on in the cloud with a real-time provider, overridable", () => {
  const keys = ["CHAT_ASYNC_TURNS", "WEBSITE_SITE_NAME", "WEBSOCKET_PROVIDER"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(backgroundTurnsEnabled(), false, "local dev runs turns in the request");

    process.env.WEBSITE_SITE_NAME = "agentforeach-func";
    process.env.WEBSOCKET_PROVIDER = "azure-webpubsub";
    assert.equal(backgroundTurnsEnabled(), true);

    process.env.WEBSOCKET_PROVIDER = "noop";
    assert.equal(backgroundTurnsEnabled(), false, "no socket to deliver the reply");

    process.env.CHAT_ASYNC_TURNS = "true";
    assert.equal(backgroundTurnsEnabled(), true);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
