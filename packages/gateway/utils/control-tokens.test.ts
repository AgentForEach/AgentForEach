import test from "node:test";
import assert from "node:assert/strict";

import { stripControlTokens } from "./control-tokens.js";

test("a reply that is only a control token means send nothing", () => {
  for (const t of ["NO_REPLY", " no_reply ", "**NO_REPLY**", "HEARTBEAT_OK.", "`NO_REPLY`"]) {
    assert.equal(stripControlTokens(t), "", t);
  }
});

test("a control token on its own line is removed from a real reply", () => {
  assert.equal(stripControlTokens("Done, reminder set.\nNO_REPLY"), "Done, reminder set.");
});

test("normal text mentioning the token isn't touched", () => {
  const text = "Reply with NO_REPLY if you want me to stay quiet.";
  assert.equal(stripControlTokens(text), text);
});
