import test from "node:test";
import assert from "node:assert/strict";

import { authorizeLinkCreate } from "./policy.js";
import type { AuthContext } from "../auth/types.js";

const user = (roles: string[] = []): AuthContext => ({ userId: "alice", roles, source: "jwt" });
const body = { channel: "telegram", channelUserId: "12345" };

test("non-admins can't create links directly, even for themselves", () => {
  // Pairing is the proof of channel ownership; a direct link would let a
  // user claim someone else's channel account.
  const own = authorizeLinkCreate(user(), body);
  assert.equal(own.ok, false);
  assert.equal(!own.ok && own.status, 403);
  const other = authorizeLinkCreate(user(), { ...body, userId: "victim" });
  assert.equal(!other.ok && other.status, 403);
});

test("admins can link a channel account to any user", () => {
  const d = authorizeLinkCreate(user(["admin"]), { ...body, userId: "bob" });
  assert.deepEqual(d, { ok: true, targetUserId: "bob", channel: "telegram", channelUserId: "12345" });
  const self = authorizeLinkCreate(user(["admin"]), { channel: " Telegram ", channelUserId: " 12345 " });
  assert.deepEqual(self, { ok: true, targetUserId: "alice", channel: "telegram", channelUserId: "12345" });
});

test("channel and channelUserId are required", () => {
  const d = authorizeLinkCreate(user(["admin"]), { channel: "telegram" });
  assert.equal(!d.ok && d.status, 400);
});
