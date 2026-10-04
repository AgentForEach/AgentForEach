import test from "node:test";
import assert from "node:assert/strict";

import { backgroundTurnsEnabled, chatTurnIds } from "./chat-turn.js";
import { isValidSessionId } from "../sessions/ids.js";
import { createHash } from "node:crypto";

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

test("a user id with a newline can't share a run with another user's key", () => {
  // "a\nb" + "c" and "a" + "b\nc" would hash the same text if joined with "\n".
  assert.notDeepEqual(chatTurnIds("a\nb", "c"), chatTurnIds("a", "b\nc"));
  // Ordinary ids keep the exact ids they had before (in-flight retries still match).
  const h = createHash("sha256").update("u1\nkey-123").digest("hex");
  assert.equal(chatTurnIds("u1", "key-123").instanceId, `chat-${h.slice(0, 32)}`);
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
