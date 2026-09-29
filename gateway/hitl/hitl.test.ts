/**
 * AgentForEach HITL Module — Tests
 *
 * Tests the config-driven HITL system:
 *   - Config loading (hitl/config.ts)
 *   - Policy resolution (hitl/policy.ts)
 *   - Form type resolution, intent templating, schema resolution
 *   - Options resolution for single_select / multi_select
 *   - Gate decisions (always, when_args_missing, confirm_only, never)
 *   - Glob pattern matching for tool policies
 *   - Reset / cache invalidation
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resetConfigCache } from "../utils/index.js";
import { authorizeHitlResponse } from "./authorize.js";
import { HitlStore } from "./store.js";
import { InMemoryCosmosDatabase } from "../database/testing/in-memory-cosmos.js";
import type { HitlRunState } from "./types.js";

import {
  loadHitlConfig,
  isHitlEnabled,
  resetHitlConfig,
} from "./config.js";

import {
  getHitlPolicy,
  shouldGate,
  resolveIntent,
  resolveSchema,
  resolveOptions,
} from "./policy.js";

import type {
  HitlFormType,
  HitlToolPolicyConfig,
} from "./types.js";

import {
  HITL_INPUT_EVENT,
  HITL_ORCHESTRATION_NAME,
  HITL_RESUME_ACTIVITY,
  HITL_PUSH_REQUEST_ACTIVITY,
  HITL_TIMEOUT_ACTIVITY,
} from "./types.js";

import {
  REQUEST_USER_INPUT_TOOL,
  buildRequestUserInputTool,
} from "./tool.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * The config tests run against the shipped example (examples/hitl-forms.json
 * at the repo root) rather than agentforeach.json, which carries no example forms
 * or tool policies. That also keeps the example itself loadable. Config is
 * read lazily, so setting this before the first test is early enough.
 */
function findExampleConfig(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "examples", "hitl-forms.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("examples/hitl-forms.json not found");
    dir = parent;
  }
}
process.env.CONFIG_FILE_JSON = findExampleConfig();

/**
 * Ensure config cache is clean before every test.
 */
function resetBeforeTest(): void {
  resetHitlConfig();
}

// ============================================================================
// Config Loading — loadHitlConfig()
// ============================================================================

test("loadHitlConfig — returns a valid config object from the config file", () => {
  resetBeforeTest();
  const config = loadHitlConfig();

  assert.equal(typeof config.enabled, "boolean");
  assert.equal(typeof config.defaultTimeoutSeconds, "number");
  assert.ok(config.forms instanceof Map, "forms should be a Map");
  assert.ok(config.tools instanceof Map, "tools should be a Map");
});

test("loadHitlConfig — hitl is enabled in the example config", () => {
  resetBeforeTest();
  assert.equal(isHitlEnabled(), true);
});

test("loadHitlConfig — caches the result on second call", () => {
  resetBeforeTest();
  const first = loadHitlConfig();
  const second = loadHitlConfig();
  assert.equal(first, second, "should return the same cached object");
});

test("loadHitlConfig — resetHitlConfig clears the cache", () => {
  resetBeforeTest();
  const first = loadHitlConfig();
  resetHitlConfig();
  const second = loadHitlConfig();
  assert.notEqual(first, second, "should return a fresh object after reset");
  // But values should be equivalent
  assert.equal(first.enabled, second.enabled);
  assert.equal(first.defaultTimeoutSeconds, second.defaultTimeoutSeconds);
});

test("loadHitlConfig — defaultTimeoutSeconds is 300", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  assert.equal(config.defaultTimeoutSeconds, 300);
});

// ============================================================================
// Config — Form Definitions
// ============================================================================

test("config forms — create_contact form is loaded", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const form = config.forms.get("create_contact");
  assert.ok(form, "create_contact form should exist");
  assert.equal(form.name, "create_contact");
  assert.equal(form.title, "Create Contact");
  assert.equal(form.formType, "form");
  assert.ok(form.schema, "should have a schema");
  assert.ok(form.uiHints, "should have uiHints");
});

test("config forms — choose_priority is single_select with options", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const form = config.forms.get("choose_priority");
  assert.ok(form);
  assert.equal(form.formType, "single_select");
  assert.equal(form.options?.length, 3);
});

test("config forms — confirm_action is confirmation", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const form = config.forms.get("confirm_action");
  assert.ok(form);
  assert.equal(form.formType, "confirmation");
});

test("config forms — create_contact has uiHints with hiddenFields", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const form = config.forms.get("create_contact");
  assert.ok(form);
  assert.ok(form.uiHints?.hiddenFields?.includes("userId"));
});

test("config customFormTypes — loaded as name → description", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  assert.ok(config.customFormTypes.get("select_contact")?.includes("contact picker"));
});

test("config customFormTypes — names that aren't plain identifiers are ignored", () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "hitl-config-")), "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      hitl: {
        enabled: true,
        customFormTypes: { pick_date: "date picker", "Bad Name": "x", 'x"; drop': "y", ["a".repeat(41)]: "z" },
      },
    }),
  );
  const previous = process.env.CONFIG_FILE_JSON;
  process.env.CONFIG_FILE_JSON = configPath;
  resetConfigCache();
  resetBeforeTest();
  try {
    assert.deepEqual([...loadHitlConfig().customFormTypes.keys()], ["pick_date"]);
  } finally {
    if (previous === undefined) delete process.env.CONFIG_FILE_JSON;
    else process.env.CONFIG_FILE_JSON = previous;
    resetConfigCache();
    resetBeforeTest();
  }
});

// ============================================================================
// Config — Tool Policies
// ============================================================================

test("config tools — example_create_contact has gate: always", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const policy = config.tools.get("example_create_contact");
  assert.ok(policy);
  assert.equal(policy.gate, "always");
  assert.equal(policy.formName, "create_contact");
  assert.ok(policy.resolvedForm, "should have a resolved form");
  assert.equal(policy.resolvedForm?.formType, "form");
});

test("config tools — example_set_priority references choose_priority form", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const policy = config.tools.get("example_set_priority");
  assert.ok(policy);
  assert.equal(policy.gate, "confirm_only");
  assert.equal(policy.formName, "choose_priority");
  assert.equal(policy.formType, "single_select");
});

test("config tools — example_update_record defaults formType to confirmation", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const policy = config.tools.get("example_update_record");
  assert.ok(policy);
  assert.equal(policy.gate, "when_args_missing");
  // No form reference and no explicit formType → defaults to "confirmation"
  assert.equal(policy.formType, "confirmation");
});

test("config tools — example_send_email has confirm_only gate", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const policy = config.tools.get("example_send_email");
  assert.ok(policy);
  assert.equal(policy.gate, "confirm_only");
  assert.equal(policy.intentTemplate, "Send this email to {to}?");
});

test("config tools — uiHints merge: tool-level overrides form-level", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  const policy = config.tools.get("example_update_record");
  assert.ok(policy);
  // Tool has inline uiHints with layout and hiddenFields
  assert.equal(policy.uiHints?.layout, "single-column");
  assert.ok(policy.uiHints?.hiddenFields?.includes("userId"));
});

// ============================================================================
// Policy Lookup — getHitlPolicy()
// ============================================================================

test("getHitlPolicy — returns policy for exact tool name", () => {
  resetBeforeTest();
  const policy = getHitlPolicy("example_create_contact");
  assert.ok(policy);
  assert.equal(policy.toolPattern, "example_create_contact");
  assert.equal(policy.gate, "always");
});

test("getHitlPolicy — returns undefined for unknown tool", () => {
  resetBeforeTest();
  const policy = getHitlPolicy("unknown_tool_xyz");
  assert.equal(policy, undefined);
});

test("getHitlPolicy — returns undefined when HITL is disabled", () => {
  resetBeforeTest();
  // Disable by loading config, then manually setting enabled to false
  // We need to trick the config cache.
  const config = loadHitlConfig();
  // Store original value
  const originalEnabled = config.enabled;
  // Temporarily disable
  (config as any).enabled = false;

  const policy = getHitlPolicy("example_create_contact");
  assert.equal(policy, undefined, "should return undefined when disabled");

  // Restore
  (config as any).enabled = originalEnabled;
});

test("getHitlPolicy — filters out gate: never policies", () => {
  resetBeforeTest();
  // Manually inject a "never" policy to test filtering
  const config = loadHitlConfig();
  config.tools.set("test_never_tool", {
    toolPattern: "test_never_tool",
    gate: "never",
    formType: "confirmation",
  });

  const policy = getHitlPolicy("test_never_tool");
  assert.equal(policy, undefined, "gate: never should return undefined");

  // Clean up
  config.tools.delete("test_never_tool");
});

test("getHitlPolicy — glob pattern matching", () => {
  resetBeforeTest();
  const config = loadHitlConfig();

  // Add a glob policy
  config.tools.set("test_glob_*", {
    toolPattern: "test_glob_*",
    gate: "always",
    formType: "confirmation",
  });

  // Should match
  const p1 = getHitlPolicy("test_glob_foo");
  assert.ok(p1, "should match glob pattern");
  assert.equal(p1.toolPattern, "test_glob_*");

  const p2 = getHitlPolicy("test_glob_bar_baz");
  assert.ok(p2, "should match multi-char wildcard");

  // Should NOT match
  const p3 = getHitlPolicy("other_prefix_glob_foo");
  assert.equal(p3, undefined, "should not match different prefix");

  // Clean up
  config.tools.delete("test_glob_*");
});

test("getHitlPolicy — exact match takes precedence over glob", () => {
  resetBeforeTest();
  const config = loadHitlConfig();

  config.tools.set("prio_*", {
    toolPattern: "prio_*",
    gate: "confirm_only",
    formType: "confirmation",
    intentTemplate: "from glob",
  });
  config.tools.set("prio_exact", {
    toolPattern: "prio_exact",
    gate: "always",
    formType: "form",
    intentTemplate: "from exact",
  });

  const policy = getHitlPolicy("prio_exact");
  assert.ok(policy);
  assert.equal(policy.intentTemplate, "from exact");
  assert.equal(policy.gate, "always");

  // Clean up
  config.tools.delete("prio_*");
  config.tools.delete("prio_exact");
});

// ============================================================================
// Gate Decision — shouldGate()
// ============================================================================

test("shouldGate — gate: always returns true", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
  };
  assert.equal(shouldGate(policy, {}), true);
});

test("shouldGate — gate: confirm_only returns true", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "confirm_only",
    formType: "confirmation",
  };
  assert.equal(shouldGate(policy, { a: 1 }), true);
});

test("shouldGate — gate: never returns false", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "never",
    formType: "confirmation",
  };
  assert.equal(shouldGate(policy, {}), false);
});

test("shouldGate — gate: when_args_missing, all required present → false", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "when_args_missing",
    formType: "form",
  };
  const schema = {
    type: "object",
    required: ["name", "email"],
    properties: {
      name: { type: "string" },
      email: { type: "string" },
    },
  };
  assert.equal(
    shouldGate(policy, { name: "Alice", email: "a@b.com" }, schema),
    false,
  );
});

test("shouldGate — gate: when_args_missing, missing required → true", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "when_args_missing",
    formType: "form",
  };
  const schema = {
    type: "object",
    required: ["name", "email"],
    properties: {
      name: { type: "string" },
      email: { type: "string" },
    },
  };
  assert.equal(
    shouldGate(policy, { name: "Alice" }, schema),
    true,
    "missing email should trigger gate",
  );
});

test("shouldGate — gate: when_args_missing, null value → true", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "when_args_missing",
    formType: "form",
  };
  const schema = { type: "object", required: ["name"] };
  assert.equal(shouldGate(policy, { name: null }, schema), true);
});

test("shouldGate — gate: when_args_missing, empty string → true", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "when_args_missing",
    formType: "form",
  };
  const schema = { type: "object", required: ["name"] };
  assert.equal(shouldGate(policy, { name: "" }, schema), true);
});

test("shouldGate — gate: when_args_missing, no schema → true", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "when_args_missing",
    formType: "form",
  };
  assert.equal(shouldGate(policy, { name: "Alice" }), true);
});

test("shouldGate — gate: when_args_missing, no required in schema → false", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "when_args_missing",
    formType: "form",
  };
  const schema = { type: "object", properties: { name: { type: "string" } } };
  assert.equal(shouldGate(policy, {}, schema), false);
});

// ============================================================================
// Intent Resolution — resolveIntent()
// ============================================================================

test("resolveIntent — substitutes {argName} placeholders", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
    intentTemplate: "Creating party: {name} ({partyType})",
  };
  const result = resolveIntent(policy, {
    name: "Acme Corp",
    partyType: "company",
  });
  assert.equal(result, "Creating party: Acme Corp (company)");
});

test("resolveIntent — keeps unreplaced placeholders intact", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
    intentTemplate: "Party: {name} role: {role}",
  };
  const result = resolveIntent(policy, { name: "Bob" });
  assert.equal(result, "Party: Bob role: {role}");
});

test("resolveIntent — falls back to default template when none specified", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "my_tool",
    gate: "always",
    formType: "form",
  };
  const result = resolveIntent(policy, {});
  assert.equal(result, "Provide input for my_tool");
});

test("resolveIntent — handles null values in args (keeps placeholder)", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
    intentTemplate: "Delete: {name}",
  };
  const result = resolveIntent(policy, { name: null });
  assert.equal(result, "Delete: {name}");
});

test("resolveIntent — handles numeric arg values", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
    intentTemplate: "Set count to {count}",
  };
  const result = resolveIntent(policy, { count: 42 });
  assert.equal(result, "Set count to 42");
});

// ============================================================================
// Schema Resolution — resolveSchema()
// ============================================================================

test("resolveSchema — schemaOverride takes priority", () => {
  const override = { type: "object", properties: { x: { type: "number" } } };
  const formSchema = { type: "object", properties: { y: { type: "string" } } };
  const mcpSchema = { type: "object", properties: { z: { type: "boolean" } } };

  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
    schemaOverride: override,
    resolvedForm: {
      name: "test",
      title: "Test",
      formType: "form",
      schema: formSchema,
    },
  };
  assert.deepStrictEqual(resolveSchema(policy, mcpSchema), override);
});

test("resolveSchema — form schema used when no override", () => {
  const formSchema = { type: "object", properties: { y: { type: "string" } } };
  const mcpSchema = { type: "object", properties: { z: { type: "boolean" } } };

  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
    resolvedForm: {
      name: "test",
      title: "Test",
      formType: "form",
      schema: formSchema,
    },
  };
  assert.deepStrictEqual(resolveSchema(policy, mcpSchema), formSchema);
});

test("resolveSchema — MCP schema used when no override and no form schema", () => {
  const mcpSchema = { type: "object", properties: { z: { type: "boolean" } } };
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
  };
  assert.deepStrictEqual(resolveSchema(policy, mcpSchema), mcpSchema);
});

test("resolveSchema — empty fallback when nothing available", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
  };
  assert.deepStrictEqual(resolveSchema(policy), {
    type: "object",
    properties: {},
  });
});

// ============================================================================
// Options Resolution — resolveOptions()
// ============================================================================

test("resolveOptions — named form options take priority", () => {
  const formOptions = [
    { label: "Option A", value: "a" },
    { label: "Option B", value: "b", description: "Second choice" },
  ];
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "single_select",
    resolvedForm: {
      name: "test",
      title: "Test",
      formType: "single_select",
      options: formOptions,
    },
  };
  const result = resolveOptions(policy, {
    options: [{ label: "LLM Option", value: "llm" }],
  });
  assert.deepStrictEqual(result, formOptions);
});

test("resolveOptions — falls back to LLM-provided options", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "single_select",
  };
  const result = resolveOptions(policy, {
    options: [
      { label: "Party A", value: "p1", description: "First party" },
      { label: "Party B", value: "p2" },
    ],
  });
  assert.ok(result);
  assert.equal(result.length, 2);
  assert.equal(result[0].label, "Party A");
  assert.equal(result[0].value, "p1");
  assert.equal(result[0].description, "First party");
  assert.equal(result[1].label, "Party B");
  assert.equal(result[1].description, undefined);
});

test("resolveOptions — handles raw string-like LLM options", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "multi_select",
  };
  const result = resolveOptions(policy, {
    options: [
      { name: "Alice", id: "u1" },
      { name: "Bob", id: "u2" },
    ],
  });
  assert.ok(result);
  assert.equal(result.length, 2);
  // name → label, id → value
  assert.equal(result[0].label, "Alice");
  assert.equal(result[0].value, "u1");
});

test("resolveOptions — returns undefined when no options available", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "form",
  };
  const result = resolveOptions(policy, {});
  assert.equal(result, undefined);
});

test("resolveOptions — returns undefined when args.options is empty array", () => {
  const policy: HitlToolPolicyConfig = {
    toolPattern: "t",
    gate: "always",
    formType: "single_select",
  };
  const result = resolveOptions(policy, { options: [] });
  assert.equal(result, undefined);
});

// ============================================================================
// Integration — Example config end-to-end
// ============================================================================

test("integration — example_create_contact full pipeline", () => {
  resetBeforeTest();

  const policy = getHitlPolicy("example_create_contact");
  assert.ok(policy, "policy should be found");

  // Gate decision
  assert.equal(shouldGate(policy, {}), true, "always gate");

  // Intent resolution
  const intent = resolveIntent(policy, { name: "Ada Lovelace" });
  assert.equal(intent, "Create a new contact: Ada Lovelace");

  // Schema resolution (from named form)
  const schema = resolveSchema(policy);
  assert.ok(schema.properties, "schema should have properties");
  assert.ok(schema.required, "schema should have required fields");

  // Form type
  assert.equal(policy.formType, "form");
  assert.equal(policy.formName, "create_contact");

  // UI hints (from named form, merged)
  assert.equal(policy.uiHints?.layout, "two-column");
  assert.ok((policy.uiHints?.groups?.length ?? 0) > 0);
});

test("integration — example_set_priority confirm_only with choose_priority form", () => {
  resetBeforeTest();

  const policy = getHitlPolicy("example_set_priority");
  assert.ok(policy);
  assert.equal(policy.gate, "confirm_only");
  assert.equal(policy.formType, "single_select");
  assert.equal(shouldGate(policy, { taskId: "t1", priority: "high" }), true);

  const intent = resolveIntent(policy, { taskId: "t1" });
  assert.equal(intent, "Set priority for task: t1");

  // Options come from the named form, not the model
  assert.deepEqual(
    resolveOptions(policy, {})?.map((o) => o.value),
    ["high", "medium", "low"],
  );
});

test("integration — example_update_record when_args_missing", () => {
  resetBeforeTest();

  const policy = getHitlPolicy("example_update_record");
  assert.ok(policy);

  const schema = {
    type: "object",
    required: ["recordId", "status"],
    properties: {
      recordId: { type: "string" },
      status: { type: "string" },
    },
  };

  // Missing status → should gate
  assert.equal(
    shouldGate(policy, { recordId: "rec-1" }, schema),
    true,
  );

  // All required present → should not gate
  assert.equal(
    shouldGate(
      policy,
      { recordId: "rec-1", status: "done" },
      schema,
    ),
    false,
  );

  const intent = resolveIntent(policy, { recordId: "rec-1" });
  assert.equal(intent, "Update record: rec-1");
});

test("integration — example_delete_* glob confirm_only", () => {
  resetBeforeTest();

  const policy = getHitlPolicy("example_delete_contact");
  assert.ok(policy);
  assert.equal(policy.toolPattern, "example_delete_*");
  assert.equal(policy.gate, "confirm_only");
  assert.equal(shouldGate(policy, {}), true);

  const intent = resolveIntent(policy, {});
  assert.equal(intent, "Delete this item? This cannot be undone.");
});

test("integration — unknown tool returns no policy", () => {
  resetBeforeTest();
  const policy = getHitlPolicy("example_list_contacts");
  assert.equal(policy, undefined, "read-only tools should have no policy");
});

// ============================================================================
// Reset
// ============================================================================

test("resetHitlConfig — forces re-read from disk", () => {
  resetBeforeTest();
  const a = loadHitlConfig();
  resetHitlConfig();
  const b = loadHitlConfig();

  // Different object references but equivalent data
  assert.notEqual(a, b);
  assert.equal(a.enabled, b.enabled);
  assert.equal(a.forms.size, b.forms.size);
  assert.equal(a.tools.size, b.tools.size);
});

test("isHitlEnabled — matches config.enabled", () => {
  resetBeforeTest();
  const config = loadHitlConfig();
  assert.equal(isHitlEnabled(), config.enabled);
});

// ============================================================================
// request_user_input — custom form types from config
// ============================================================================

test("buildRequestUserInputTool — no custom types returns the built-in tool", () => {
  assert.equal(buildRequestUserInputTool(new Map()), REQUEST_USER_INPUT_TOOL);
});

test("buildRequestUserInputTool — appends custom types to the enum and description", () => {
  const tool = buildRequestUserInputTool(
    new Map([
      ["select_contact", "contact picker"],
      ["form", "must not shadow a built-in"],
    ]),
  );
  const typeParam = tool.parameters.properties.type;
  assert.deepEqual(typeParam.enum, [
    ...REQUEST_USER_INPUT_TOOL.parameters.properties.type.enum,
    "select_contact",
  ]);
  assert.match(typeParam.description, /select_contact = contact picker/);
  assert.doesNotMatch(typeParam.description, /must not shadow/);
  // The shared definition is not mutated
  assert.ok(!REQUEST_USER_INPUT_TOOL.parameters.properties.type.enum.includes("select_contact"));
});

// ============================================================================
// Constants & Exports
// ============================================================================

test("HITL constants — all exported and non-empty", () => {
  assert.equal(typeof HITL_INPUT_EVENT, "string");
  assert.ok(HITL_INPUT_EVENT.length > 0);

  assert.equal(typeof HITL_ORCHESTRATION_NAME, "string");
  assert.ok(HITL_ORCHESTRATION_NAME.length > 0);

  assert.equal(typeof HITL_RESUME_ACTIVITY, "string");
  assert.ok(HITL_RESUME_ACTIVITY.length > 0);

  assert.equal(typeof HITL_PUSH_REQUEST_ACTIVITY, "string");
  assert.ok(HITL_PUSH_REQUEST_ACTIVITY.length > 0);

  assert.equal(typeof HITL_TIMEOUT_ACTIVITY, "string");
  assert.ok(HITL_TIMEOUT_ACTIVITY.length > 0);
});

test("HITL_TIMEOUT_ACTIVITY — is distinct from HITL_RESUME_ACTIVITY", () => {
  assert.notEqual(HITL_TIMEOUT_ACTIVITY, HITL_RESUME_ACTIVITY);
});

// ============================================================================
// Input responses: only the owner of a pending request may answer
// ============================================================================


// Partition-scoped like the real store: a request is found only for its owner.
const hitlRequests = new Map<string, { userId: string; status: string }>([
  ["req-1", { userId: "alice", status: "pending" }],
  ["req-2", { userId: "alice", status: "responded" }],
]);
const hitlStoreStub = {
  async get(requestId: string, userId: string) {
    const r = hitlRequests.get(requestId);
    return r && r.userId === userId ? ({ status: r.status } as never) : null;
  },
};

test("authorizeHitlResponse lets the owner answer a pending request", async () => {
  assert.equal(await authorizeHitlResponse(hitlStoreStub, "req-1", "alice"), true);
});

test("authorizeHitlResponse refuses another user's request", async () => {
  assert.equal(await authorizeHitlResponse(hitlStoreStub, "req-1", "mallory"), false);
});

test("authorizeHitlResponse refuses a request that was already answered", async () => {
  assert.equal(await authorizeHitlResponse(hitlStoreStub, "req-2", "alice"), false);
});

test("a pending request outlives its own timeout, even past an hour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 5) });
  const store = new HitlStore(new InMemoryCosmosDatabase());
  await store.initialize();
  const state = {
    requestId: "req-1",
    orchestrationId: "hitl-req-1",
    originalRequest: { userId: "u1", message: "book it" },
    runId: "run-1",
    sessionId: "s1",
    toolRound: 1,
    pendingToolCall: { callId: "c1", name: "book_flight", arguments: {} },
    completedToolResults: [],
    independentToolCalls: [],
    createdAt: Date.now(),
    status: "pending",
    timeoutSeconds: 2 * 3600,
  } as unknown as HitlRunState;
  await store.create(state);

  t.mock.timers.setTime(Date.now() + 2 * 3600 * 1000); // the user answers at the deadline
  assert.ok(await store.get("req-1", "u1"), "still there to resume");
});
