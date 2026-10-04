import test from "node:test";
import assert from "node:assert/strict";

import { encodeSandboxIdentifier, sandboxIdentifierOwner } from "./identifier.js";

test("identifiers keep users apart, colons and all, and name their owner", () => {
  const pair = encodeSandboxIdentifier("alice", "s1");
  const colon = encodeSandboxIdentifier("alice:s1");
  assert.notEqual(pair, colon, "a user named alice:s1 is not alice's session s1");
  assert.equal(sandboxIdentifierOwner(pair), "alice");
  assert.equal(sandboxIdentifierOwner(colon), "alice:s1");
  assert.equal(encodeSandboxIdentifier("bob"), '["bob"]');
  assert.throws(() => sandboxIdentifierOwner("bob"), /Invalid sandbox identifier/);
  assert.throws(() => sandboxIdentifierOwner('["a","b","c"]'), /Invalid sandbox identifier/);
});
