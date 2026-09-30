/**
 * AgentForEach Client Layer — Tool Policy Tests
 *
 * Verifies that session-type tool gating works correctly:
 *   - interactive: full access
 *   - subagent: blocked write/management tools
 *   - cron: allowlist-only
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyToolPolicy,
  filterToolNames,
  hitlGateAction,
  rejectUnofferedToolCall,
} from "./tool-policy.js";

// ============================================================================
// Helpers
// ============================================================================

interface MockTool {
  name: string;
  description: string;
}

function makeTool(name: string): MockTool {
  return { name, description: `${name} tool` };
}

/** A representative set of all tool categories. */
const ALL_TOOLS: MockTool[] = [
  // Memory
  makeTool("memory_search"),
  makeTool("memory_store"),
  makeTool("memory_forget"),
  makeTool("memory_get"),
  // Cron
  makeTool("cron_create"),
  makeTool("cron_list"),
  makeTool("cron_get"),
  makeTool("cron_update"),
  makeTool("cron_delete"),
  makeTool("cron_runs"),
  // Prompt
  makeTool("prompt_get"),
  makeTool("prompt_update"),
  // Episodes
  makeTool("episode_recall"),
  makeTool("episode_create"),
  makeTool("episode_update"),
  // Web
  makeTool("web_search"),
  makeTool("web_fetch"),
  // Skills
  makeTool("skill_list"),
  makeTool("skill_setup"),
  makeTool("skill_read"),
  makeTool("http_fetch"),
  makeTool("sandbox_exec"),
  makeTool("browser"),
  // Digests
  makeTool("session_search"),
];

const ALL_TOOL_NAMES = ALL_TOOLS.map((t) => t.name);

// ============================================================================
// applyToolPolicy — interactive
// ============================================================================

test("applyToolPolicy — interactive returns all tools unfiltered", () => {
  const result = applyToolPolicy(ALL_TOOLS, "interactive");
  assert.equal(result.length, ALL_TOOLS.length);
  assert.deepEqual(
    result.map((t) => t.name),
    ALL_TOOL_NAMES,
  );
});

// ============================================================================
// applyToolPolicy — subagent
// ============================================================================

test("applyToolPolicy — subagent blocks cron write tools", () => {
  const result = applyToolPolicy(ALL_TOOLS, "subagent");
  const names = new Set(result.map((t) => t.name));

  assert.ok(!names.has("cron_create"), "cron_create should be blocked");
  assert.ok(!names.has("cron_update"), "cron_update should be blocked");
  assert.ok(!names.has("cron_delete"), "cron_delete should be blocked");

  // Read tools should still be available
  assert.ok(names.has("cron_list"), "cron_list should be allowed");
  assert.ok(names.has("cron_get"), "cron_get should be allowed");
  assert.ok(names.has("cron_runs"), "cron_runs should be allowed");
});

test("applyToolPolicy — subagent blocks prompt_update but allows prompt_get", () => {
  const result = applyToolPolicy(ALL_TOOLS, "subagent");
  const names = new Set(result.map((t) => t.name));

  assert.ok(!names.has("prompt_update"), "prompt_update should be blocked");
  assert.ok(names.has("prompt_get"), "prompt_get should be allowed");
});

test("applyToolPolicy — subagent blocks episode write tools but allows recall", () => {
  const result = applyToolPolicy(ALL_TOOLS, "subagent");
  const names = new Set(result.map((t) => t.name));

  assert.ok(!names.has("episode_create"), "episode_create should be blocked");
  assert.ok(!names.has("episode_update"), "episode_update should be blocked");
  assert.ok(names.has("episode_recall"), "episode_recall should be allowed");
});

test("applyToolPolicy — subagent blocks skill_setup and memory_forget", () => {
  const result = applyToolPolicy(ALL_TOOLS, "subagent");
  const names = new Set(result.map((t) => t.name));

  assert.ok(!names.has("skill_setup"), "skill_setup should be blocked");
  assert.ok(!names.has("memory_forget"), "memory_forget should be blocked");
});

test("applyToolPolicy — subagent allows memory read/write, web, skills execution, digests", () => {
  const result = applyToolPolicy(ALL_TOOLS, "subagent");
  const names = new Set(result.map((t) => t.name));

  assert.ok(names.has("memory_search"), "memory_search should be allowed");
  assert.ok(names.has("memory_store"), "memory_store should be allowed");
  assert.ok(names.has("memory_get"), "memory_get should be allowed");
  assert.ok(names.has("web_search"), "web_search should be allowed");
  assert.ok(names.has("web_fetch"), "web_fetch should be allowed");
  assert.ok(names.has("skill_list"), "skill_list should be allowed");
  assert.ok(names.has("skill_read"), "skill_read should be allowed");
  assert.ok(names.has("http_fetch"), "http_fetch should be allowed");
  assert.ok(names.has("sandbox_exec"), "sandbox_exec should be allowed");
  assert.ok(names.has("session_search"), "session_search should be allowed");
});

// ============================================================================
// applyToolPolicy — cron
// ============================================================================

test("applyToolPolicy — cron only allows allowlisted tools", () => {
  const result = applyToolPolicy(ALL_TOOLS, "cron");
  const names = new Set(result.map((t) => t.name));

  // Should have only the cron-allowed tools
  assert.ok(names.has("memory_search"), "memory_search should be allowed");
  assert.ok(names.has("memory_get"), "memory_get should be allowed");
  assert.ok(names.has("cron_list"), "cron_list should be allowed");
  assert.ok(names.has("cron_get"), "cron_get should be allowed");
  assert.ok(names.has("cron_runs"), "cron_runs should be allowed");
  assert.ok(names.has("skill_read"), "skill_read should be allowed");
  assert.ok(names.has("http_fetch"), "http_fetch should be allowed");
  assert.ok(names.has("sandbox_exec"), "sandbox_exec should be allowed");
  assert.ok(names.has("browser"), "browser should be allowed (capped per run)");
  assert.ok(names.has("web_search"), "web_search should be allowed");
  assert.ok(names.has("web_fetch"), "web_fetch should be allowed");
  assert.ok(names.has("session_search"), "session_search should be allowed");
});

test("applyToolPolicy — cron blocks all write/management tools", () => {
  const result = applyToolPolicy(ALL_TOOLS, "cron");
  const names = new Set(result.map((t) => t.name));

  assert.ok(!names.has("memory_store"), "memory_store should be blocked");
  assert.ok(!names.has("memory_forget"), "memory_forget should be blocked");
  assert.ok(!names.has("cron_create"), "cron_create should be blocked");
  assert.ok(!names.has("cron_update"), "cron_update should be blocked");
  assert.ok(!names.has("cron_delete"), "cron_delete should be blocked");
  assert.ok(!names.has("prompt_get"), "prompt_get should be blocked");
  assert.ok(!names.has("prompt_update"), "prompt_update should be blocked");
  assert.ok(!names.has("episode_recall"), "episode_recall should be blocked");
  assert.ok(!names.has("episode_create"), "episode_create should be blocked");
  assert.ok(!names.has("episode_update"), "episode_update should be blocked");
  assert.ok(!names.has("skill_list"), "skill_list should be blocked");
  assert.ok(!names.has("skill_setup"), "skill_setup should be blocked");
});

test("applyToolPolicy — cron with empty input returns empty", () => {
  const result = applyToolPolicy([], "cron");
  assert.equal(result.length, 0);
});

// ============================================================================
// filterToolNames — mirrors applyToolPolicy for string arrays
// ============================================================================

test("filterToolNames — interactive returns all names", () => {
  const result = filterToolNames(ALL_TOOL_NAMES, "interactive");
  assert.deepEqual(result, ALL_TOOL_NAMES);
});

test("filterToolNames — subagent filters same tools as applyToolPolicy", () => {
  const policyResult = applyToolPolicy(ALL_TOOLS, "subagent").map((t) => t.name);
  const nameResult = filterToolNames(ALL_TOOL_NAMES, "subagent");
  assert.deepEqual(nameResult, policyResult);
});

test("filterToolNames — cron filters same tools as applyToolPolicy", () => {
  const policyResult = applyToolPolicy(ALL_TOOLS, "cron").map((t) => t.name);
  const nameResult = filterToolNames(ALL_TOOL_NAMES, "cron");
  assert.deepEqual(nameResult, policyResult);
});

// ============================================================================
// Edge cases
// ============================================================================

test("applyToolPolicy — unknown session type returns all tools", () => {
  const result = applyToolPolicy(ALL_TOOLS, "unknown" as any);
  assert.equal(result.length, ALL_TOOLS.length);
});

test("applyToolPolicy — preserves tool object identity", () => {
  const result = applyToolPolicy(ALL_TOOLS, "interactive");
  assert.equal(result[0], ALL_TOOLS[0], "Should return same object references");
});

// ============================================================================
// Dispatch-time enforcement
// ============================================================================

test("dispatch: a tool offered this turn may run", () => {
  assert.equal(rejectUnofferedToolCall("memory_search", new Set(["memory_search"])), null);
});

test("dispatch: a hidden or blocked tool name is rejected even if the model calls it", () => {
  const offered = new Set(
    applyToolPolicy(
      [{ name: "memory_search" }, { name: "cron_create" }, { name: "admin_tool" }],
      "subagent",
      new Set(["admin_tool"]),
    ).map((t) => t.name),
  );
  for (const name of ["cron_create", "admin_tool", "made_up_tool"]) {
    const rejection = rejectUnofferedToolCall(name, offered);
    assert.ok(rejection, name);
    assert.equal(JSON.parse(rejection).error, true);
  }
});

test("hitl gate: ungated calls execute", () => {
  assert.equal(hitlGateAction(false, false), "execute");
  assert.equal(hitlGateAction(false, true), "execute");
});

test("hitl gate: gated calls suspend when possible and are refused otherwise", () => {
  assert.equal(hitlGateAction(true, true), "suspend");
  // Telegram, WhatsApp, cron and resumed runs have no invocation context.
  assert.equal(hitlGateAction(true, false), "deny");
});
