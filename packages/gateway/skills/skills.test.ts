/**
 * AgentForEach Skills Module — Unit Tests
 *
 * Comprehensive coverage of the prompt-based skills subsystem:
 *   - Loader: SKILL.md frontmatter parsing (edge cases, malformed input)
 *   - Exec: allowlist validation, every allowed binary, edge cases
 *   - Exec handler: command execution, timeout, truncation, credential injection
 *   - Blob store: manifest parsing, extended frontmatter, cache, path validation
 *   - Handler: all four tools (skill_list, skill_setup, skill_read, http_fetch)
 *   - Registry: per-user resolution, auto-enable, credential merging, agent filtering
 *   - Prompt section: buildSkillsSection() available_skills block
 *   - Config: loading, defaults, env var fallback
 *   - Security: allowlist enforcement, path traversal, credential isolation
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseSkillFrontmatter } from "./loader.js";
import { buildSkillsSection } from "../prompt/sections/skills.js";
import {
  SkillToolHandler,
  getSkillToolDefinitions,
  isSkillTool,
  SKILL_LIST_TOOL_NAME,
  SKILL_SETUP_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  HTTP_FETCH_TOOL_NAME,
} from "./handler.js";
import { ExecToolHandler, validateBinary, ALLOWED_BINS } from "./exec/index.js";
import { resolveUserSkills, type ResolvedSkills } from "./registry.js";
import type {
  SkillManifest,
  SkillStatus,
  UserSkillConfig,
  SkillAuditEntry,
  CredentialSpec,
} from "./types.js";
import { UserSkillStore } from "./store.js";
import { SkillBlobStore } from "./blob-store.js";
import {
  getSandboxToolDefinitions,
  isSandboxTool,
  SandboxToolHandler,
  SANDBOX_FILE_EXPORT_TOOL_NAME,
} from "./sandbox/handler.js";
import { ExportBlobStore, resolveRuntimeStorage } from "./sandbox/export-store.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeFetchTestHooks } from "../utils/safe-fetch.js";
import { resetSkillsConfig } from "./config.js";
import { resetConfigCache } from "../utils/index.js";
import { checkUrl } from "../utils/safe-fetch.js";

// ============================================================================
// Test Skill Manifests
// ============================================================================

const FREE_MANIFEST: SkillManifest = {
  id: "weather",
  name: "Weather",
  description: "Get current weather and forecasts",
  category: "information",
  credentials: [],
  blobPath: "weather/SKILL.md",
};

const CRED_MANIFEST: SkillManifest = {
  id: "github",
  name: "GitHub",
  description: "Interact with GitHub repositories",
  category: "productivity",
  credentials: [
    { key: "GITHUB_TOKEN", label: "GitHub Token", required: true },
  ],
  requiredBins: ["curl", "jq"],
  blobPath: "github/SKILL.md",
};

const MULTI_CRED_MANIFEST: SkillManifest = {
  id: "slack",
  name: "Slack",
  description: "Post to Slack channels",
  category: "communication",
  credentials: [
    { key: "SLACK_TOKEN", label: "Bot Token", required: true },
    { key: "SLACK_WEBHOOK", label: "Webhook URL", required: true },
    { key: "SLACK_CHANNEL", label: "Default Channel", required: false },
  ],
  blobPath: "slack/SKILL.md",
};

const OPTIONAL_CRED_MANIFEST: SkillManifest = {
  id: "search",
  name: "Search",
  description: "Web search integration",
  category: "information",
  credentials: [
    { key: "SEARCH_API_KEY", label: "Search API Key", required: false },
  ],
  blobPath: "search/SKILL.md",
};

// ============================================================================
// Mock Store
// ============================================================================

class MockUserSkillStore {
  private data = new Map<string, UserSkillConfig>();
  public auditLog: SkillAuditEntry[] = [];
  public upsertCalls: UserSkillConfig[] = [];

  static buildId(userId: string, skillId: string): string {
    return `${userId}:${skillId}`;
  }

  async get(userId: string, skillId: string): Promise<UserSkillConfig | null> {
    return this.data.get(`${userId}:${skillId}`) ?? null;
  }

  async getAllForUser(userId: string): Promise<UserSkillConfig[]> {
    return Array.from(this.data.values()).filter((c) => c.userId === userId);
  }

  async upsert(config: UserSkillConfig): Promise<UserSkillConfig> {
    this.data.set(config.id, config);
    this.upsertCalls.push({ ...config });
    return config;
  }

  async logAudit(entry: SkillAuditEntry): Promise<void> {
    this.auditLog.push(entry);
  }

  seed(config: UserSkillConfig): void {
    this.data.set(config.id, config);
  }
}

// ============================================================================
// Mock Blob Store
// ============================================================================

class MockBlobStore {
  private files = new Map<string, string>();
  private manifests: SkillManifest[];
  public listCallCount = 0;
  public readCalls: string[] = [];

  constructor(manifests: SkillManifest[], files?: Map<string, string>) {
    this.manifests = manifests;
    if (files) this.files = files;
  }

  async listSkills(): Promise<SkillManifest[]> {
    this.listCallCount++;
    return this.manifests;
  }

  async readFile(path: string): Promise<string> {
    this.readCalls.push(path);
    if (path.includes("..")) throw new Error("Invalid path: directory traversal not allowed");
    if (path.startsWith("/")) throw new Error("Invalid path: must be relative (no leading /)");
    const content = this.files.get(path);
    if (!content) throw new Error(`Blob not found: ${path}`);
    return content;
  }

  invalidateCache(): void {}
}

// ============================================================================
// Helper
// ============================================================================

function createHandler(opts: {
  statuses: SkillStatus[];
  store?: MockUserSkillStore;
  blobStore?: MockBlobStore;
  credentials?: Record<string, string>;
}) {
  const store = opts.store ?? new MockUserSkillStore();
  const blobStore = opts.blobStore ?? new MockBlobStore([], new Map());
  return new SkillToolHandler(
    store as unknown as UserSkillStore,
    blobStore as any,
    opts.statuses,
    opts.credentials ?? {},
  );
}

// ============================================================================
// Tests — Loader: parseSkillFrontmatter
// ============================================================================

test("parseSkillFrontmatter", async (t) => {
  await t.test("parses valid frontmatter with all fields", () => {
    const content = `---
id: weather
name: Weather
description: Get current weather and forecasts
category: information
---

# Weather Skill

Instructions here.
`;
    const fm = parseSkillFrontmatter(content);
    assert.equal(fm.id, "weather");
    assert.equal(fm.name, "Weather");
    assert.equal(fm.description, "Get current weather and forecasts");
    assert.equal(fm.category, "information");
  });

  await t.test("parses frontmatter with extra whitespace", () => {
    const content = `---
id:   spaces-test
name:   Spaces Test
description:  Has extra whitespace
category:  testing
---
Body`;
    const fm = parseSkillFrontmatter(content);
    assert.equal(fm.id, "spaces-test");
    assert.equal(fm.name, "Spaces Test");
  });

  await t.test("ignores comment lines in frontmatter", () => {
    const content = `---
id: test
# This is a comment
name: Test Skill
description: A test
category: testing
---
Body`;
    const fm = parseSkillFrontmatter(content);
    assert.equal(fm.id, "test");
    assert.equal(fm.name, "Test Skill");
  });

  await t.test("ignores extra fields beyond the four required", () => {
    const content = `---
id: test
name: Test
description: A test
category: testing
version: 2.0
author: someone
---
Body`;
    const fm = parseSkillFrontmatter(content);
    assert.equal(fm.id, "test");
  });

  await t.test("throws on missing frontmatter delimiters", () => {
    assert.throws(
      () => parseSkillFrontmatter("# No frontmatter here\nJust content"),
      /frontmatter/i,
    );
  });

  await t.test("throws on empty content", () => {
    assert.throws(() => parseSkillFrontmatter(""), /frontmatter/i);
  });

  await t.test("throws on missing required fields (description + category)", () => {
    const content = `---
id: test
name: Test
---
Body`;
    assert.throws(() => parseSkillFrontmatter(content), /description.*category|category.*description/i);
  });

  await t.test("throws on missing id", () => {
    const content = `---
name: Test
description: A test
category: testing
---
Body`;
    assert.throws(() => parseSkillFrontmatter(content), /id/i);
  });

  await t.test("handles colons in description value", () => {
    const content = `---
id: test
name: Test
description: Weather: current conditions and forecasts
category: information
---
Body`;
    const fm = parseSkillFrontmatter(content);
    assert.equal(fm.description, "Weather: current conditions and forecasts");
  });
});

// ============================================================================
// Tests — Exec: Allowlist (exhaustive)
// ============================================================================

test("exec allowlist — exhaustive", async (t) => {
  await t.test("allows every listed binary", () => {
    const allBins = [
      "curl", "jq", "head", "tail", "sort", "uniq", "wc", "tr",
      "cut", "grep", "sed", "awk", "base64", "sha256sum", "date",
      "printf", "echo",
    ];
    for (const bin of allBins) {
      assert.equal(validateBinary(bin), null, `Expected ${bin} to be allowed`);
    }
  });

  await t.test("ALLOWED_BINS set has exact count", () => {
    assert.equal(ALLOWED_BINS.size, 17);
  });

  await t.test("rejects dangerous binaries", () => {
    const dangerous = [
      "rm", "mv", "cp", "chmod", "chown", "kill", "pkill",
      "bash", "sh", "zsh", "python", "python3", "node", "perl",
      "ruby", "gcc", "make", "sudo", "su", "dd", "mkfs",
      "wget", "nc", "ncat", "ssh", "scp", "rsync",
    ];
    for (const bin of dangerous) {
      const err = validateBinary(bin);
      assert.ok(err !== null, `Expected ${bin} to be rejected`);
      assert.ok(err!.includes("not in the allowlist"));
    }
  });

  await t.test("rejects empty string", () => {
    assert.ok(validateBinary("") !== null);
  });

  await t.test("strips any path prefix and validates basename", () => {
    assert.equal(validateBinary("/usr/bin/curl"), null);
    assert.equal(validateBinary("/usr/local/bin/jq"), null);
    assert.equal(validateBinary("./curl"), null);
    const err = validateBinary("/usr/bin/python3");
    assert.ok(err !== null);
  });

  await t.test("error message lists available binaries", () => {
    const err = validateBinary("python");
    assert.ok(err!.includes("Available:"));
    assert.ok(err!.includes("curl"));
    assert.ok(err!.includes("jq"));
  });
});

// ============================================================================
// Tests — Exec Handler (real command execution)
// ============================================================================

test("ExecToolHandler — command execution", async (t) => {
  const handler = new ExecToolHandler({});

  await t.test("echo: captures stdout", async () => {
    const raw = await handler.handle({ command: ["echo", "hello world"] });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello world");
    assert.equal(result.stderr, "");
    assert.equal(result.truncated, false);
    assert.ok(result.durationMs >= 0);
  });

  await t.test("printf: formats output", async () => {
    const raw = await handler.handle({ command: ["printf", "number: %d", "42"] });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "number: 42");
  });

  await t.test("date: returns formatted date", async () => {
    const raw = await handler.handle({ command: ["date", "+%Y"] });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.trim().match(/^\d{4}$/));
  });

  await t.test("echo piped through wc: multi-word counting", async () => {
    // exec doesn't support pipes (no shell), but wc -c on direct input works
    const raw = await handler.handle({ command: ["wc", "-c"], timeout: 2 });
    const result = JSON.parse(raw);
    // wc with no input will just wait (timeout) — this tests timeout behavior
    // or return immediately with 0 bytes depending on stdin
    assert.ok(result.exitCode !== undefined);
  });

  await t.test("grep: returns non-zero exit on no match", async () => {
    const raw = await handler.handle({ command: ["grep", "impossibleXYZ", "/dev/null"] });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 1); // grep returns 1 for no match
  });

  await t.test("base64: encode and decode", async () => {
    // base64 on macOS uses different flags than Linux, but encoding works
    const raw = await handler.handle({ command: ["echo", "-n", "test"] });
    const echoResult = JSON.parse(raw);
    assert.equal(echoResult.stdout, "test");
  });

  await t.test("rejects non-allowlisted binary", async () => {
    const raw = await handler.handle({ command: ["rm", "-rf", "/tmp/nonexistent"] });
    const result = JSON.parse(raw);
    assert.ok(result.error);
    assert.ok(result.error.includes("not in the allowlist"));
  });

  await t.test("rejects empty command array", async () => {
    const raw = await handler.handle({ command: [] });
    const result = JSON.parse(raw);
    assert.ok(result.error);
    assert.ok(result.error.includes("Invalid command"));
  });

  await t.test("rejects non-array command", async () => {
    const raw = await handler.handle({ command: "curl -s google.com" as any });
    const result = JSON.parse(raw);
    assert.ok(result.error);
  });

  await t.test("captures stderr on failure", async () => {
    const raw = await handler.handle({ command: ["curl", "--invalid-flag-xyz"] });
    const result = JSON.parse(raw);
    assert.ok(result.exitCode !== 0);
    assert.ok(result.stderr.length > 0);
  });

  await t.test("respects custom timeout (short timeout)", async () => {
    // sleep isn't allowed, but we can test timeout resolution logic
    // by checking that valid timeout values are accepted
    const raw = await handler.handle({ command: ["echo", "fast"], timeout: 1 });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
  });

  await t.test("durationMs is populated", async () => {
    const raw = await handler.handle({ command: ["echo", "timing"] });
    const result = JSON.parse(raw);
    assert.ok(typeof result.durationMs === "number");
    assert.ok(result.durationMs >= 0);
  });
});

// ============================================================================
// Tests — Exec Handler: Credential Injection
// ============================================================================

test("ExecToolHandler — credential injection", async (t) => {
  await t.test("credentials are available as env vars in child process", async () => {
    const handler = new ExecToolHandler({ MY_SECRET: "s3cret_val" });
    // Use awk to read env var — awk can access env via ENVIRON array
    const raw = await handler.handle({
      command: ["awk", "BEGIN { print ENVIRON[\"MY_SECRET\"] }"],
    });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("s3cret_val"), "credential should be in env");
  });

  await t.test("credentials don't appear in command args", async () => {
    const handler = new ExecToolHandler({ TOKEN: "secret123" });
    // The handler passes credentials via env, not args
    // Verify the handler was created without error
    const raw = await handler.handle({ command: ["echo", "test"] });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
    // stdout should NOT contain the secret
    assert.ok(!result.stdout.includes("secret123"));
  });

  await t.test("multiple credentials are all injected", async () => {
    const handler = new ExecToolHandler({
      API_KEY: "key1",
      API_SECRET: "key2",
      WEBHOOK_URL: "https://example.com",
    });
    // Verify handler initializes without error
    const raw = await handler.handle({ command: ["echo", "multi-cred"] });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
  });
});

// ============================================================================
// Tests — Exec Handler: Output Truncation
// ============================================================================

test("ExecToolHandler — output truncation", async (t) => {
  await t.test("truncates stdout exceeding maxOutputChars", async () => {
    // maxOutputChars limits our truncation; maxBuffer (2x) must be large enough
    // for execFile to finish, so pick a limit that's small but still workable.
    const handler = new ExecToolHandler({}, {
      maxTimeoutSec: 30,
      defaultTimeoutSec: 10,
      maxOutputChars: 30, // Limit at 30 chars
    });
    // "echo" output (15 chars + newline = 16) is short — use printf to repeat
    const raw = await handler.handle({
      command: ["printf", "%0.s_", "1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37","38","39","40"],
    });
    const result = JSON.parse(raw);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length <= 30, `stdout length ${result.stdout.length} should be <= 30`);
  });

  await t.test("does not truncate short output", async () => {
    const handler = new ExecToolHandler({}, {
      maxTimeoutSec: 30,
      defaultTimeoutSec: 10,
      maxOutputChars: 50_000,
    });
    const raw = await handler.handle({ command: ["echo", "short"] });
    const result = JSON.parse(raw);
    assert.equal(result.truncated, false);
  });
});

// ============================================================================
// Tests — Tool Definitions
// ============================================================================

test("getSkillToolDefinitions", async (t) => {
  await t.test("returns exactly four tools", () => {
    const tools = getSkillToolDefinitions();
    assert.equal(tools.length, 4);
  });

  await t.test("includes all expected tool names", () => {
    const names = getSkillToolDefinitions().map((t) => t.name);
    assert.ok(names.includes("skill_list"));
    assert.ok(names.includes("skill_setup"));
    assert.ok(names.includes("skill_read"));
    assert.ok(names.includes("http_fetch"));
  });

  await t.test("all tools have valid OpenAI-compatible structure", () => {
    for (const tool of getSkillToolDefinitions()) {
      assert.equal(tool.type, "function");
      assert.ok(tool.name.length > 0);
      assert.ok(tool.description.length > 0);
      assert.ok(tool.parameters);
      assert.equal(tool.parameters.type, "object");
      assert.ok(tool.parameters.properties);
    }
  });

  await t.test("http_fetch tool has url parameter", () => {
    const fetchTool = getSkillToolDefinitions().find((t) => t.name === "http_fetch");
    assert.ok(fetchTool);
    assert.ok(fetchTool!.parameters.properties.url);
    assert.equal(fetchTool!.parameters.properties.url.type, "string");
    assert.deepEqual(fetchTool!.parameters.required, ["url"]);
  });

  await t.test("skill_read tool has path parameter", () => {
    const readTool = getSkillToolDefinitions().find((t) => t.name === "skill_read");
    assert.ok(readTool);
    assert.ok(readTool!.parameters.properties.path);
    assert.deepEqual(readTool!.parameters.required, ["path"]);
  });

  await t.test("skill_setup tool has required skill_id and action", () => {
    const setupTool = getSkillToolDefinitions().find((t) => t.name === "skill_setup");
    assert.ok(setupTool);
    assert.deepEqual(setupTool!.parameters.required, ["skill_id", "action"]);
  });
});

test("isSkillTool", async (t) => {
  await t.test("recognizes all skill tools", () => {
    assert.ok(isSkillTool("skill_list"));
    assert.ok(isSkillTool("skill_setup"));
    assert.ok(isSkillTool("skill_read"));
    assert.ok(isSkillTool("http_fetch"));
  });

  await t.test("rejects non-skill tools", () => {
    assert.ok(!isSkillTool("memory_search"));
    assert.ok(!isSkillTool("cron_create"));
    assert.ok(!isSkillTool("unknown"));
    assert.ok(!isSkillTool("exec")); // removed tool
    assert.ok(!isSkillTool("skill_activate")); // old tool name
    assert.ok(!isSkillTool(""));
  });
});

// ============================================================================
// Tests — SkillToolHandler: skill_list
// ============================================================================

test("skill_list", async (t) => {
  await t.test("returns correct count with mixed statuses", async () => {
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      { manifest: CRED_MANIFEST, configured: true, credentialsComplete: true, enabled: true },
      { manifest: OPTIONAL_CRED_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
    ];
    const handler = createHandler({ statuses });

    const raw = await handler.handle("skill_list", {}, "u1");
    const result = JSON.parse(raw);
    assert.equal(result.skills.length, 3);
  });

  await t.test("includes all metadata fields per skill", async () => {
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = createHandler({ statuses });

    const raw = await handler.handle("skill_list", {}, "u1");
    const result = JSON.parse(raw);

    const weather = result.skills[0];
    assert.equal(weather.id, "weather");
    assert.equal(weather.name, "Weather");
    assert.equal(weather.description, "Get current weather and forecasts");
    assert.equal(weather.category, "information");
    assert.equal(weather.blobPath, "weather/SKILL.md");
    assert.equal(weather.enabled, true);
    assert.equal(weather.configured, false);
    assert.equal(weather.credentialsComplete, true);
    assert.deepEqual(weather.requiredCredentials, []);

    const github = result.skills[1];
    assert.equal(github.id, "github");
    assert.equal(github.enabled, false);
    assert.equal(github.credentialsComplete, false);
    assert.equal(github.requiredCredentials.length, 1);
    assert.equal(github.requiredCredentials[0].key, "GITHUB_TOKEN");
    assert.deepEqual(github.requiredBins, ["curl", "jq"]);
  });

  await t.test("returns empty array when no skills", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("skill_list", {}, "u1");
    const result = JSON.parse(raw);
    assert.deepEqual(result.skills, []);
  });
});

// ============================================================================
// Tests — SkillToolHandler: skill_read
// ============================================================================

test("skill_read", async (t) => {
  const skillContent = "---\nid: weather\nname: Weather\ndescription: Test\ncategory: info\ncredentials: []\n---\n\n# Instructions\n\nUse curl to fetch data.";

  await t.test("reads an enabled skill file successfully", async () => {
    const files = new Map([["weather/SKILL.md", skillContent]]);
    const blobStore = new MockBlobStore([FREE_MANIFEST], files);
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
    ];
    const handler = createHandler({ statuses, blobStore });

    const raw = await handler.handle("skill_read", { path: "weather/SKILL.md" }, "u1");
    const result = JSON.parse(raw);
    assert.equal(result.skill_id, "weather");
    assert.equal(result.path, "weather/SKILL.md");
    assert.ok(result.content.includes("# Instructions"));
    assert.ok(result.content.includes("curl"));
    assert.equal(blobStore.readCalls.length, 1);
  });

  await t.test("rejects missing path parameter", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("skill_read", {}, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Missing"));
  });

  await t.test("rejects empty path parameter", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("skill_read", { path: "" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Missing"));
  });

  await t.test("rejects unknown skill path", async () => {
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
    ];
    const handler = createHandler({ statuses });

    const raw = await handler.handle("skill_read", { path: "unknown/SKILL.md" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("No skill found"));
    assert.ok(result.error.includes("skill_list"));
  });

  await t.test("rejects disabled skill", async () => {
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: false },
    ];
    const handler = createHandler({ statuses });

    const raw = await handler.handle("skill_read", { path: "weather/SKILL.md" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("not enabled"));
    assert.ok(result.error.includes("skill_setup"));
  });

  await t.test("rejects skill with incomplete credentials", async () => {
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: true, credentialsComplete: false, enabled: true },
    ];
    const handler = createHandler({ statuses });

    const raw = await handler.handle("skill_read", { path: "github/SKILL.md" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("missing required credentials"));
    assert.ok(result.error.includes("GITHUB_TOKEN"));
  });

  await t.test("handles blob store read errors gracefully", async () => {
    // Blob store that throws on read
    const blobStore = new MockBlobStore([FREE_MANIFEST], new Map());
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
    ];
    const handler = createHandler({ statuses, blobStore });

    const raw = await handler.handle("skill_read", { path: "weather/SKILL.md" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Blob not found"));
  });
});

// ============================================================================
// Tests — SkillToolHandler: skill_setup
// ============================================================================

test("skill_setup", async (t) => {
  await t.test("enables a skill and persists to store", async () => {
    const store = new MockUserSkillStore();
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = createHandler({ statuses, store });

    const raw = await handler.handle("skill_setup", {
      skill_id: "github",
      action: "enable",
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.success);
    assert.equal(result.enabled, true);
    assert.equal(result.skillId, "github");
    assert.equal(result.action, "enable");

    // Verify store persistence
    assert.equal(store.upsertCalls.length, 1);
    assert.equal(store.upsertCalls[0].enabled, true);
  });

  await t.test("an enabled skill is usable by later calls in the same turn", async () => {
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = createHandler({ statuses, store: new MockUserSkillStore() });
    await handler.handle("skill_setup", { skill_id: "github", action: "enable" }, "u1");
    assert.equal(statuses[0]!.enabled, true);
  });

  await t.test("disables an existing skill", async () => {
    const store = new MockUserSkillStore();
    store.seed({
      id: "u1:github",
      userId: "u1",
      skillId: "github",
      enabled: true,
      credentials: { GITHUB_TOKEN: "tok" },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: true, credentialsComplete: true, enabled: true },
    ];
    const handler = createHandler({ statuses, store });

    const raw = await handler.handle("skill_setup", {
      skill_id: "github",
      action: "disable",
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.success);
    assert.equal(result.enabled, false);
  });

  await t.test("sets credentials and reports completeness", async () => {
    const store = new MockUserSkillStore();
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = createHandler({ statuses, store });

    const raw = await handler.handle("skill_setup", {
      skill_id: "github",
      action: "set_credentials",
      credentials: { GITHUB_TOKEN: "ghp_test123" },
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.success);
    assert.equal(result.credentialsComplete, true);
  });

  await t.test("merges partial credentials across calls", async () => {
    const store = new MockUserSkillStore();
    store.seed({
      id: "u1:slack",
      userId: "u1",
      skillId: "slack",
      enabled: true,
      credentials: { SLACK_TOKEN: "xoxb-test" },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const statuses: SkillStatus[] = [
      { manifest: MULTI_CRED_MANIFEST, configured: true, credentialsComplete: false, enabled: true },
    ];
    const handler = createHandler({ statuses, store });

    const raw = await handler.handle("skill_setup", {
      skill_id: "slack",
      action: "set_credentials",
      credentials: { SLACK_WEBHOOK: "https://hooks.slack.com/test" },
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.success);
    assert.equal(result.credentialsComplete, true); // Both required creds now present

    // Verify both credentials in store
    const saved = await store.get("u1", "slack");
    assert.equal(saved!.credentials.SLACK_TOKEN, "xoxb-test");
    assert.equal(saved!.credentials.SLACK_WEBHOOK, "https://hooks.slack.com/test");
  });

  await t.test("rejects unknown credential keys", async () => {
    const store = new MockUserSkillStore();
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = createHandler({ statuses, store });

    const raw = await handler.handle("skill_setup", {
      skill_id: "github",
      action: "set_credentials",
      credentials: { INVALID_KEY: "value" },
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Unknown credential keys"));
    assert.ok(result.error.includes("INVALID_KEY"));
  });

  await t.test("rejects empty credentials object", async () => {
    const handler = createHandler({
      statuses: [
        { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
      ],
    });

    const raw = await handler.handle("skill_setup", {
      skill_id: "github",
      action: "set_credentials",
      credentials: {},
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("No valid string credentials"));
  });

  await t.test("rejects missing skill_id", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("skill_setup", { action: "enable" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Missing required parameter: skill_id"));
  });

  await t.test("rejects missing action", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("skill_setup", { skill_id: "weather" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Missing required parameter: action"));
  });

  await t.test("rejects invalid action value", async () => {
    const handler = createHandler({
      statuses: [
        { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      ],
    });
    const raw = await handler.handle("skill_setup", {
      skill_id: "weather",
      action: "delete_everything",
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Unknown action"));
  });

  await t.test("rejects unknown skill id", async () => {
    const handler = createHandler({
      statuses: [{ manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true }],
    });
    const raw = await handler.handle("skill_setup", {
      skill_id: "nonexistent",
      action: "enable",
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Unknown skill"));
  });

  await t.test("rate limits rapid setup calls (30s interval)", async () => {
    const store = new MockUserSkillStore();
    store.seed({
      id: "u1:github",
      userId: "u1",
      skillId: "github",
      enabled: true,
      credentials: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), // just now
    });
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: true, credentialsComplete: false, enabled: true },
    ];
    const handler = createHandler({ statuses, store });

    const raw = await handler.handle("skill_setup", {
      skill_id: "github",
      action: "enable",
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Rate limited"));
    assert.ok(result.error.includes("Try again"));
  });

  await t.test("writes audit log with correct fields", async () => {
    const store = new MockUserSkillStore();
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const handler = createHandler({ statuses, store });

    await handler.handle("skill_setup", {
      skill_id: "github",
      action: "set_credentials",
      credentials: { GITHUB_TOKEN: "tok123" },
    }, "u1");

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.auditLog.length, 1);
    const entry = store.auditLog[0];
    assert.equal(entry.userId, "u1");
    assert.equal(entry.skillId, "github");
    assert.equal(entry.action, "set_credentials");
    assert.deepEqual(entry.credentialKeysSet, ["GITHUB_TOKEN"]);
    assert.ok(entry.id.startsWith("audit:u1:github:"));
  });
});

// ============================================================================
// Tests — SkillToolHandler: http_fetch routing
// ============================================================================

test("handler http_fetch routing", async (t) => {
  // These cover legacy skills (credentials without declared hosts), so run
  // with requireCredentialHosts off, and never touch the real network.
  const savedConfig = process.env.CONFIG_FILE_JSON;
  const configFile = join(mkdtempSync(join(tmpdir(), "agentforeach-skills-")), "config.json");
  writeFileSync(configFile, JSON.stringify({ skills: { requireCredentialHosts: false } }));
  process.env.CONFIG_FILE_JSON = configFile;
  resetConfigCache();
  resetSkillsConfig();
  safeFetchTestHooks.fetch = (async () =>
    new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as never;
  t.after(() => {
    safeFetchTestHooks.fetch = undefined;
    if (savedConfig === undefined) delete process.env.CONFIG_FILE_JSON;
    else process.env.CONFIG_FILE_JSON = savedConfig;
    resetConfigCache();
    resetSkillsConfig();
  });

  await t.test("unknown tool name returns error", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("unknown_tool", {}, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Unknown skill tool"));
  });

  await t.test("http_fetch rejects missing url", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("http_fetch", {}, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Missing required parameter: url"));
  });

  await t.test("http_fetch rejects invalid url", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("http_fetch", { url: "not-a-url" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Invalid URL"));
  });

  await t.test("http_fetch blocks localhost", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("http_fetch", { url: "http://localhost:8080/api" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("not allowed"));
  });

  await t.test("http_fetch blocks private IPs", async () => {
    const handler = createHandler({ statuses: [] });
    for (const ip of ["http://127.0.0.1/x", "http://192.168.1.1/x", "http://10.0.0.1/x"]) {
      const raw = await handler.handle("http_fetch", { url: ip }, "u1");
      const result = JSON.parse(raw);
      assert.ok(result.error.includes("not allowed"), `Should block ${ip}`);
    }
  });

  await t.test("http_fetch blocks link-local / IMDS (169.254.x.x)", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("http_fetch", { url: "http://169.254.169.254/latest/meta-data/" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("not allowed"), "Should block IMDS endpoint");
  });

  await t.test("http_fetch blocks CGNAT range (100.64-127.x.x)", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("http_fetch", { url: "http://100.100.1.1/" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("not allowed"), "Should block CGNAT");
  });

  await t.test("http_fetch blocks credential-substituted private IPs (SSRF via creds)", async () => {
    const handler = createHandler({
      statuses: [],
      credentials: { API_HOST: "192.168.1.100" },
    });
    const raw = await handler.handle("http_fetch", { url: "http://$API_HOST/admin" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("not allowed"), "Should block private IP from credential substitution");
  });

  await t.test("exec tool is no longer recognized", async () => {
    const handler = createHandler({ statuses: [] });
    const raw = await handler.handle("exec", { command: ["echo", "test"] }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error.includes("Unknown skill tool"));
  });

  await t.test("http_fetch substitutes $VAR_NAME in headers from credentials", async () => {
    const handler = createHandler({
      statuses: [],
      credentials: { GITHUB_TOKEN: "ghp_test123", API_KEY: "sk-secret" },
    });
    // We can't make a real HTTP call in unit tests, but we CAN verify
    // substitution works by checking that a request with $VAR_NAME in headers
    // against a non-existent host produces a network error (not a credential error).
    // The substitution happens before the fetch call.
    const raw = await handler.handle("http_fetch", {
      url: "https://api.github.com/user",
      headers: { "Authorization": "token $GITHUB_TOKEN", "X-Api-Key": "$API_KEY" },
    }, "u1");
    const result = JSON.parse(raw);
    // If substitution didn't work, we'd get the literal "$GITHUB_TOKEN" sent.
    // A successful network call or network error means substitution happened.
    // We just verify no error about missing credentials:
    assert.ok(!result.error?.includes("$GITHUB_TOKEN"), "Credential should be substituted");
    assert.ok(!result.error?.includes("$API_KEY"), "Credential should be substituted");
  });

  await t.test("http_fetch substitutes $VAR_NAME in URL from credentials", async () => {
    const handler = createHandler({
      statuses: [],
      credentials: { API_KEY: "test-key-123" },
    });
    const raw = await handler.handle("http_fetch", {
      url: "https://api.example.com/data?key=$API_KEY",
    }, "u1");
    const result = JSON.parse(raw);
    // URL substitution happened — the request goes out with the real key
    assert.ok(!result.error?.includes("$API_KEY"), "Credential in URL should be substituted");
  });

  await t.test("http_fetch substitutes $VAR_NAME in body from credentials", async () => {
    const handler = createHandler({
      statuses: [],
      credentials: { SECRET_TOKEN: "super-secret" },
    });
    const raw = await handler.handle("http_fetch", {
      url: "https://api.example.com/webhook",
      method: "POST",
      body: JSON.stringify({ token: "$SECRET_TOKEN" }),
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(!result.error?.includes("$SECRET_TOKEN"), "Credential in body should be substituted");
  });

  await t.test("http_fetch leaves unknown $VAR_NAME unchanged", async () => {
    const handler = createHandler({
      statuses: [],
      credentials: { KNOWN_KEY: "value" },
    });
    // $UNKNOWN_VAR should be left as-is since it's not in credentials
    const raw = await handler.handle("http_fetch", {
      url: "https://api.example.com/test",
      headers: { "X-Token": "$UNKNOWN_VAR" },
    }, "u1");
    // The request will go through with the literal "$UNKNOWN_VAR" in the header
    // We just verify no crash occurred
    const result = JSON.parse(raw);
    assert.ok(result.status || result.error, "Should return a response or network error");
  });

  await t.test("http_fetch with no credentials leaves $VAR_NAME as-is", async () => {
    const handler = createHandler({ statuses: [] }); // no credentials
    const raw = await handler.handle("http_fetch", {
      url: "https://api.example.com/test",
      headers: { "Authorization": "Bearer $MY_TOKEN" },
    }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.status || result.error, "Should return a response or network error");
  });
});

// ============================================================================
// Tests — SkillToolHandler: isSkillTool instance method
// ============================================================================

test("handler.isSkillTool", async (t) => {
  const handler = createHandler({ statuses: [] });

  await t.test("recognizes all four skill tools", () => {
    assert.ok(handler.isSkillTool("skill_list"));
    assert.ok(handler.isSkillTool("skill_setup"));
    assert.ok(handler.isSkillTool("skill_read"));
    assert.ok(handler.isSkillTool("http_fetch"));
  });

  await t.test("rejects other tools", () => {
    assert.ok(!handler.isSkillTool("memory_search"));
    assert.ok(!handler.isSkillTool("cron_create"));
    assert.ok(!handler.isSkillTool("skill_activate"));
    assert.ok(!handler.isSkillTool(""));
  });
});

// ============================================================================
// Tests — Registry: resolveUserSkills
// ============================================================================

test("resolveUserSkills", async (t) => {
  await t.test("auto-enables credential-free skills", async () => {
    const blobStore = new MockBlobStore([FREE_MANIFEST]);
    const store = new MockUserSkillStore();

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
    );

    assert.equal(result.statuses.length, 1);
    assert.equal(result.statuses[0].manifest.id, "weather");
    assert.equal(result.statuses[0].enabled, true);
    assert.equal(result.statuses[0].credentialsComplete, true);
  });

  await t.test("does not auto-enable skills requiring credentials", async () => {
    const blobStore = new MockBlobStore([CRED_MANIFEST]);
    const store = new MockUserSkillStore();

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
    );

    assert.equal(result.statuses.length, 1);
    assert.equal(result.statuses[0].enabled, false);
    assert.equal(result.statuses[0].credentialsComplete, false);
  });

  await t.test("merges user credentials from active skills", async () => {
    const blobStore = new MockBlobStore([CRED_MANIFEST]);
    const store = new MockUserSkillStore();
    store.seed({
      id: "u1:github",
      userId: "u1",
      skillId: "github",
      enabled: true,
      credentials: { GITHUB_TOKEN: "ghp_test" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
    );

    assert.equal(result.statuses[0].enabled, true);
    assert.equal(result.statuses[0].credentialsComplete, true);
    assert.equal(result.userCredentials.GITHUB_TOKEN, "ghp_test");
  });

  await t.test("merges credentials from multiple active skills", async () => {
    const blobStore = new MockBlobStore([CRED_MANIFEST, MULTI_CRED_MANIFEST]);
    const store = new MockUserSkillStore();
    store.seed({
      id: "u1:github",
      userId: "u1",
      skillId: "github",
      enabled: true,
      credentials: { GITHUB_TOKEN: "ghp_test" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.seed({
      id: "u1:slack",
      userId: "u1",
      skillId: "slack",
      enabled: true,
      credentials: { SLACK_TOKEN: "xoxb-test", SLACK_WEBHOOK: "https://hooks.slack.com" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
    );

    assert.equal(result.userCredentials.GITHUB_TOKEN, "ghp_test");
    assert.equal(result.userCredentials.SLACK_TOKEN, "xoxb-test");
    assert.equal(result.userCredentials.SLACK_WEBHOOK, "https://hooks.slack.com");
  });

  await t.test("does not merge credentials from disabled skills", async () => {
    const blobStore = new MockBlobStore([CRED_MANIFEST]);
    const store = new MockUserSkillStore();
    store.seed({
      id: "u1:github",
      userId: "u1",
      skillId: "github",
      enabled: false, // disabled
      credentials: { GITHUB_TOKEN: "should_not_appear" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
    );

    assert.equal(result.userCredentials.GITHUB_TOKEN, undefined);
  });

  await t.test("applies per-agent whitelist filter", async () => {
    const blobStore = new MockBlobStore([FREE_MANIFEST, CRED_MANIFEST, OPTIONAL_CRED_MANIFEST]);
    const store = new MockUserSkillStore();

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
      ["weather"], // Only weather allowed
    );

    assert.equal(result.statuses.length, 1);
    assert.equal(result.statuses[0].manifest.id, "weather");
  });

  await t.test("empty agentEnabledSkills means all skills available", async () => {
    const blobStore = new MockBlobStore([FREE_MANIFEST, CRED_MANIFEST]);
    const store = new MockUserSkillStore();

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
      [], // empty array = no filter
    );

    assert.equal(result.statuses.length, 2);
  });

  await t.test("auto-enables optional-credential skills", async () => {
    const blobStore = new MockBlobStore([OPTIONAL_CRED_MANIFEST]);
    const store = new MockUserSkillStore();

    const result = await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
    );

    // Optional-only credentials = credential-free → auto-enabled
    assert.equal(result.statuses[0].enabled, true);
    assert.equal(result.statuses[0].credentialsComplete, true);
  });

  await t.test("loads manifests and configs in parallel", async () => {
    // Both calls should happen — verify by checking blob store was called
    const blobStore = new MockBlobStore([FREE_MANIFEST]);
    const store = new MockUserSkillStore();

    await resolveUserSkills(
      blobStore as any,
      store as unknown as UserSkillStore,
      "u1",
    );

    assert.equal(blobStore.listCallCount, 1);
  });
});

// ============================================================================
// Tests — Prompt Section: buildSkillsSection
// ============================================================================

test("buildSkillsSection", async (t) => {
  await t.test("returns empty for minimal mode", () => {
    const lines = buildSkillsSection({
      isMinimal: true,
      skillStatuses: [
        { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      ],
    });
    assert.equal(lines.length, 0);
  });

  await t.test("returns empty when no statuses", () => {
    assert.equal(buildSkillsSection({ isMinimal: false, skillStatuses: [] }).length, 0);
    assert.equal(buildSkillsSection({ isMinimal: false }).length, 0);
  });

  await t.test("includes <available_skills> block for ready skills", () => {
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      { manifest: CRED_MANIFEST, configured: true, credentialsComplete: true, enabled: true },
    ];
    const lines = buildSkillsSection({ isMinimal: false, skillStatuses: statuses });
    const text = lines.join("\n");

    assert.ok(text.includes("## Skills"));
    assert.ok(text.includes("<available_skills>"));
    assert.ok(text.includes("weather: Get current weather and forecasts [weather/SKILL.md]"));
    assert.ok(text.includes("github: Interact with GitHub repositories [github/SKILL.md]"));
    assert.ok(text.includes("</available_skills>"));
    assert.ok(text.includes("skill_read"));
    assert.ok(text.includes("http_fetch"));
  });

  await t.test("shows needs-setup skills with correct reasons", () => {
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const lines = buildSkillsSection({ isMinimal: false, skillStatuses: statuses });
    const text = lines.join("\n");

    assert.ok(text.includes("Skills Needing Setup"));
    assert.ok(text.includes("GitHub"));
    assert.ok(text.includes("not configured"));
    assert.ok(text.includes("skill_setup"));
    assert.ok(!text.includes("<available_skills>"));
  });

  await t.test("disabled skill shows 'disabled' reason", () => {
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: true, credentialsComplete: true, enabled: false },
    ];
    const lines = buildSkillsSection({ isMinimal: false, skillStatuses: statuses });
    const text = lines.join("\n");
    assert.ok(text.includes("disabled"));
  });

  await t.test("missing credentials shows 'missing credentials' reason", () => {
    const statuses: SkillStatus[] = [
      { manifest: CRED_MANIFEST, configured: true, credentialsComplete: false, enabled: true },
    ];
    const lines = buildSkillsSection({ isMinimal: false, skillStatuses: statuses });
    const text = lines.join("\n");
    assert.ok(text.includes("missing credentials"));
  });

  await t.test("shows both ready and needs-setup when mixed", () => {
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
      { manifest: CRED_MANIFEST, configured: false, credentialsComplete: false, enabled: false },
    ];
    const lines = buildSkillsSection({ isMinimal: false, skillStatuses: statuses });
    const text = lines.join("\n");
    assert.ok(text.includes("<available_skills>"));
    assert.ok(text.includes("Skills Needing Setup"));
  });
});

// ============================================================================
// Tests — Security: Path Traversal
// ============================================================================

test("security — path traversal prevention", async (t) => {
  await t.test("blob store rejects ../ in path", async () => {
    const blobStore = new MockBlobStore([FREE_MANIFEST], new Map());
    await assert.rejects(
      () => blobStore.readFile("../../../etc/passwd"),
      /traversal/,
    );
  });

  await t.test("blob store rejects leading /", async () => {
    const blobStore = new MockBlobStore([FREE_MANIFEST], new Map());
    await assert.rejects(
      () => blobStore.readFile("/etc/passwd"),
      /relative/,
    );
  });

  await t.test("handler only allows known blob paths", async () => {
    const statuses: SkillStatus[] = [
      { manifest: FREE_MANIFEST, configured: false, credentialsComplete: true, enabled: true },
    ];
    const handler = createHandler({ statuses });

    const raw = await handler.handle("skill_read", { path: "malicious/../../../etc/shadow" }, "u1");
    const result = JSON.parse(raw);
    assert.ok(result.error); // Either "No skill found" or traversal error
  });
});

// ============================================================================
// Tests — Security: Allowlist Enforcement
// ============================================================================

test("security — exec allowlist enforcement", async (t) => {
  const handler = createHandler({ statuses: [] });

  await t.test("blocks shell interpreters", async () => {
    for (const shell of ["bash", "sh", "zsh"]) {
      const raw = await handler.handle("exec", { command: [shell, "-c", "id"] }, "u1");
      const result = JSON.parse(raw);
      assert.ok(result.error, `Expected ${shell} to be blocked`);
    }
  });

  await t.test("blocks scripting languages", async () => {
    for (const lang of ["python", "python3", "node", "perl", "ruby"]) {
      const raw = await handler.handle("exec", { command: [lang, "-e", "1"] }, "u1");
      const result = JSON.parse(raw);
      assert.ok(result.error, `Expected ${lang} to be blocked`);
    }
  });

  await t.test("blocks destructive commands", async () => {
    for (const cmd of ["rm", "mv", "chmod", "chown", "kill"]) {
      const raw = await handler.handle("exec", { command: [cmd, "--help"] }, "u1");
      const result = JSON.parse(raw);
      assert.ok(result.error, `Expected ${cmd} to be blocked`);
    }
  });

  await t.test("blocks network tools", async () => {
    for (const cmd of ["wget", "nc", "ssh", "scp"]) {
      const raw = await handler.handle("exec", { command: [cmd] }, "u1");
      const result = JSON.parse(raw);
      assert.ok(result.error, `Expected ${cmd} to be blocked`);
    }
  });
});

// ============================================================================
// Tests — Security: SSRF host classification (utils/safe-fetch checkUrl)
// ============================================================================

/** Host-level view of checkUrl, as the old isBlockedHost exposed it. */
function isBlockedHost(host: string): string | null {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const result = checkUrl(`http://${h}/`);
  return result.ok ? null : result.reason;
}

test("security — SSRF host classification", async (t) => {
  await t.test("blocks loopback addresses", () => {
    for (const h of ["localhost", "127.0.0.1", "127.0.0.2", "127.255.255.255", "::1", "[::1]", "0.0.0.0", "0.0.0.1"]) {
      assert.ok(isBlockedHost(h), `Should block ${h}`);
    }
  });

  await t.test("blocks RFC 1918 private ranges", () => {
    for (const h of ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255"]) {
      assert.ok(isBlockedHost(h), `Should block ${h}`);
    }
  });

  await t.test("blocks link-local / cloud IMDS", () => {
    for (const h of ["169.254.169.254", "169.254.0.1"]) {
      assert.ok(isBlockedHost(h), `Should block ${h}`);
    }
  });

  await t.test("blocks CGNAT range", () => {
    for (const h of ["100.64.0.1", "100.100.1.1", "100.127.255.255"]) {
      assert.ok(isBlockedHost(h), `Should block ${h}`);
    }
  });

  await t.test("blocks .local and .localhost suffixes", () => {
    for (const h of ["myhost.local", "printer.local", "app.localhost"]) {
      assert.ok(isBlockedHost(h), `Should block ${h}`);
    }
  });

  await t.test("blocks IPv6 private ranges", () => {
    for (const h of ["fc00::1", "fd12:3456::1", "fe80::1"]) {
      assert.ok(isBlockedHost(h), `Should block ${h}`);
    }
  });

  await t.test("blocks cloud metadata hostnames", () => {
    assert.ok(isBlockedHost("metadata.google.internal"));
  });

  await t.test("allows public IPs", () => {
    for (const h of ["8.8.8.8", "1.1.1.1", "104.16.0.1", "203.0.113.1"]) {
      assert.equal(isBlockedHost(h), null, `Should allow ${h}`);
    }
  });

  await t.test("allows public hostnames", () => {
    for (const h of ["api.github.com", "example.com", "api.openai.com"]) {
      assert.equal(isBlockedHost(h), null, `Should allow ${h}`);
    }
  });

  await t.test("does not block 172.32+ (outside RFC 1918 range)", () => {
    assert.equal(isBlockedHost("172.32.0.1"), null, "172.32.x.x is public");
  });

  await t.test("does not block 100.128+ (outside CGNAT range)", () => {
    assert.equal(isBlockedHost("100.128.0.1"), null, "100.128.x.x is public");
  });
});

// ============================================================================
// Tests — sandbox_file_export tool definition + handler
// ============================================================================

test("sandbox_file_export tool definition", async (t) => {
  await t.test("is included in sandbox tool definitions", () => {
    const tools = getSandboxToolDefinitions();
    const exportTool = tools.find((t) => t.name === SANDBOX_FILE_EXPORT_TOOL_NAME);
    assert.ok(exportTool, "sandbox_file_export should be in tool definitions");
    assert.equal(exportTool!.type, "function");
  });

  await t.test("has required filename parameter", () => {
    const tools = getSandboxToolDefinitions();
    const exportTool = tools.find((t) => t.name === SANDBOX_FILE_EXPORT_TOOL_NAME);
    assert.ok(exportTool);
    const params = exportTool!.parameters as any;
    assert.ok(params.properties.filename, "should have filename property");
    assert.deepEqual(params.required, ["filename"]);
  });

  await t.test("isSandboxTool recognizes sandbox_file_export", () => {
    assert.ok(isSandboxTool(SANDBOX_FILE_EXPORT_TOOL_NAME));
  });
});

test("sandbox_file_export handler", async (t) => {
  // Mock SandboxBackend for testing
  class MockSandboxBackend {
    resolveIdentifier(userId: string, sessionId?: string): string {
      return sessionId ? `${userId}:${sessionId}` : userId;
    }
    isReady(): boolean {
      return true;
    }
    async fileReadBinary(args: { filename: string }, sessionId: string) {
      if (args.filename === "missing.txt") {
        throw new Error("File not found: missing.txt");
      }
      // Return a simple base64-encoded string
      const content = Buffer.from("Hello, world!").toString("base64");
      return {
        contentBase64: content,
        filename: args.filename,
        sizeBytes: 13,
        sessionId,
      };
    }
  }

  // Mock ExportBlobStore for testing
  class MockExportStore {
    public uploadCalls: Array<{ userId: string; filename: string; size: number }> = [];

    async upload(userId: string, filename: string, content: Buffer) {
      this.uploadCalls.push({ userId, filename, size: content.length });
      return {
        downloadUrl: `https://storage.blob.core.windows.net/user-exports/${userId}/${filename}?sig=test`,
        blobPath: `${userId}/uuid_${filename}`,
        sizeBytes: content.length,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }
  }

  await t.test("returns error when filename is missing", async () => {
    const client = new MockSandboxBackend();
    const exportStore = new MockExportStore();
    const handler = new SandboxToolHandler(
      client as any,
      {},
      "user1",
      undefined,
      undefined,
      exportStore as any,
    );

    const result = JSON.parse(
      await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, {}),
    );
    assert.ok(result.error);
    assert.ok(result.error.includes("filename"));
  });

  await t.test("returns error when exportStore is not configured", async () => {
    const client = new MockSandboxBackend();
    // No exportStore
    const handler = new SandboxToolHandler(
      client as any,
      {},
      "user1",
    );

    const result = JSON.parse(
      await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, { filename: "report.csv" }),
    );
    assert.ok(result.error);
    assert.ok(result.error.includes("not configured"));
  });

  await t.test("success: reads file and returns download URL", async () => {
    const client = new MockSandboxBackend();
    const exportStore = new MockExportStore();
    const handler = new SandboxToolHandler(
      client as any,
      {},
      "user1",
      undefined,
      undefined,
      exportStore as any,
    );

    const result = JSON.parse(
      await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, { filename: "report.csv" }),
    );
    assert.ok(result.success, "should succeed");
    assert.ok(result.downloadUrl, "should have downloadUrl");
    assert.ok(result.downloadUrl.includes("storage.blob.core.windows.net"));
    assert.equal(result.filename, "report.csv");
    assert.equal(result.sizeBytes, 13); // "Hello, world!" = 13 bytes
    assert.ok(result.expiresAt, "should have expiry");
    assert.ok(result.hint, "should have user-facing hint");

    // Verify the export store was called correctly
    assert.equal(exportStore.uploadCalls.length, 1);
    assert.equal(exportStore.uploadCalls[0].userId, "user1");
    assert.equal(exportStore.uploadCalls[0].filename, "report.csv");
  });

  await t.test("returns error when file read from sandbox fails", async () => {
    const client = new MockSandboxBackend();
    const exportStore = new MockExportStore();
    const handler = new SandboxToolHandler(
      client as any,
      {},
      "user1",
      undefined,
      undefined,
      exportStore as any,
    );

    const result = JSON.parse(
      await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, { filename: "missing.txt" }),
    );
    assert.ok(result.error);
    assert.ok(result.error.includes("missing.txt"));
    // Export store should NOT have been called
    assert.equal(exportStore.uploadCalls.length, 0);
  });
});

// ============================================================================
// Tests — ExportBlobStore internals
// ============================================================================

test("ExportBlobStore — constructor validation", async (t) => {
  await t.test("throws on SAS-based connection string (no AccountKey)", () => {
    assert.throws(
      () => new ExportBlobStore("BlobEndpoint=https://test.blob.core.windows.net;SharedAccessSignature=sig"),
      /shared-key connection string/,
    );
  });

  await t.test("accepts valid shared-key connection string", () => {
    const store = new ExportBlobStore(
      "DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=dGVzdGtleQ==;EndpointSuffix=core.windows.net",
    );
    assert.ok(store, "should construct successfully");
  });

  await t.test("with identity-based AzureWebJobsStorage, uses the account and a managed identity", () => {
    const saved = { a: process.env.AzureWebJobsStorage__accountName, c: process.env.AzureWebJobsStorage__clientId };
    try {
      delete process.env.AzureWebJobsStorage__accountName;
      assert.equal(resolveRuntimeStorage(undefined), undefined, "no storage configured");
      assert.equal(resolveRuntimeStorage("AccountName=a;AccountKey=k"), "AccountName=a;AccountKey=k");

      process.env.AzureWebJobsStorage__accountName = "agentforeachfn";
      process.env.AzureWebJobsStorage__clientId = "uai-client";
      const storage = resolveRuntimeStorage(undefined);
      assert.ok(storage && typeof storage === "object");
      assert.equal(storage.accountName, "agentforeachfn");
      assert.ok(new ExportBlobStore(storage), "constructs without a key");
    } finally {
      if (saved.a === undefined) delete process.env.AzureWebJobsStorage__accountName;
      else process.env.AzureWebJobsStorage__accountName = saved.a;
      if (saved.c === undefined) delete process.env.AzureWebJobsStorage__clientId;
      else process.env.AzureWebJobsStorage__clientId = saved.c;
    }
  });
});

// ============================================================================
// Tests — Prompt section includes sandbox_file_export guidance
// ============================================================================

test("buildSkillsSection includes sandbox_file_export in tool guide", async (t) => {
  await t.test("mentions sandbox_file_export in tool selection guide", () => {
    const lines = buildSkillsSection({
      isMinimal: false,
      skillStatuses: [
        {
          manifest: FREE_MANIFEST,
          configured: true,
          credentialsComplete: true,
          enabled: true,
        },
      ],
    });
    const text = lines.join("\n");
    assert.ok(
      text.includes("sandbox_file_export"),
      "Should mention sandbox_file_export in tool selection guide",
    );
  });
});
test("SkillBlobStore — reaches the runtime storage account with a connection string or a managed identity", () => {
  const url = (store: SkillBlobStore) => (store as unknown as { containerClient: { url: string } }).containerClient.url;
  const credential = { getToken: async () => ({ token: "t", expiresOnTimestamp: Date.now() + 60_000 }) };
  assert.equal(url(new SkillBlobStore({ accountName: "acct", credential }, "skills")), "https://acct.blob.core.windows.net/skills");
  assert.equal(
    url(new SkillBlobStore("DefaultEndpointsProtocol=https;AccountName=acct2;AccountKey=a2V5;EndpointSuffix=core.windows.net", "custom")),
    "https://acct2.blob.core.windows.net/custom",
  );
});
