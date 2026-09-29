/**
 * AgentForEach Utilities — resetAllConfig Tests
 *
 * Validates that every module-level config cache can be reset through
 * the aggregated `resetAllConfig()` function and that `loadConfigSection`
 * works correctly after a full reset cycle.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resetAllConfig,
  CONFIG_RESET_FUNCTIONS,
} from "./reset-all-config.js";
import { loadConfigSection, resetConfigCache } from "./config.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("CONFIG_RESET_FUNCTIONS — contains all expected modules", () => {
  const modules = CONFIG_RESET_FUNCTIONS.map((f) => f.module);

  // Core
  assert.ok(modules.includes("utils (root JSON)"), "missing utils (root JSON)");

  // Domain modules
  const expected = [
    "auth",
    "channels",
    "channels/telegram",
    "cron",
    "digests",
    "episodes",
    "identity",
    "knowledge",
    "link-understanding",
    "llms",
    "mcp",
    "memory",
    "prompt/text",
    "prompt/onboarding",
    "prompt/mode",
    "prompt/templates",
    "sessions",
    "skills",
    "usage",
    "web",
    "websocket",
    "hitl",
    "credits",
  ];

  for (const mod of expected) {
    assert.ok(modules.includes(mod), `missing module: ${mod}`);
  }

  // 1 core + the domain modules above, nothing unlisted
  assert.equal(CONFIG_RESET_FUNCTIONS.length, expected.length + 1);
});

test("CONFIG_RESET_FUNCTIONS — every entry has a callable reset", () => {
  for (const { module, reset } of CONFIG_RESET_FUNCTIONS) {
    assert.equal(typeof reset, "function", `${module} reset is not a function`);
  }
});

test("resetAllConfig — calls all resets without throwing", () => {
  const count = resetAllConfig();
  assert.equal(count, CONFIG_RESET_FUNCTIONS.length);
});

test("resetAllConfig — loadConfigSection still works after full reset", () => {
  // Load a section to populate the cache
  const before = loadConfigSection<Record<string, unknown>>("llms");

  // Reset everything
  resetAllConfig();

  // Loading again should re-read from disk and return the same value
  const after = loadConfigSection<Record<string, unknown>>("llms");

  // Both should be defined (agentforeach.json should have an llms section)
  // or both undefined — the point is they match
  assert.deepStrictEqual(after, before);
});

test("resetAllConfig — can be called multiple times safely", () => {
  resetAllConfig();
  resetAllConfig();
  resetAllConfig();

  // No throw = pass.  Verify the core cache still responds correctly.
  const section = loadConfigSection<Record<string, unknown>>("auth");
  // Just verify we get something back (undefined is fine if no auth config)
  assert.ok(section === undefined || typeof section === "object");
});

test("resetConfigCache alone — only clears root JSON cache", () => {
  // Load to warm the cache
  loadConfigSection("llms");

  // Reset only the root cache
  resetConfigCache();

  // loadConfigSection should still work (re-reads from disk)
  const section = loadConfigSection<Record<string, unknown>>("llms");
  assert.ok(section === undefined || typeof section === "object");
});
