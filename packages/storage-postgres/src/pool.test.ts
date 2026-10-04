import test from "node:test";
import assert from "node:assert/strict";
import { createPool } from "./adapter.js";

const options = (pool: unknown) => (pool as { options: Record<string, unknown> }).options;

test("idleTimeoutMs reaches pg: 0 keeps idle connections until the pool ends; unset leaves pg's default", async () => {
  const kept = createPool({ connectionString: "postgres://u:p@127.0.0.1:1/db", idleTimeoutMs: 0 });
  assert.equal(options(kept).idleTimeoutMillis, 0);
  const usual = createPool({ connectionString: "postgres://u:p@127.0.0.1:1/db" });
  assert.equal(options(usual).idleTimeoutMillis, 10_000);
  await Promise.all([kept.end(), usual.end()]);
});
