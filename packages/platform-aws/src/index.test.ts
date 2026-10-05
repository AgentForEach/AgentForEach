import test from "node:test";
import assert from "node:assert/strict";
import { AWS_AGENTCORE_PROVIDER } from "./index.js";

test("the AgentCore backend's provider name", () => {
  assert.equal(AWS_AGENTCORE_PROVIDER, "aws-agentcore");
});
