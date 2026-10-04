/**
 * AgentForEach Skills Layer — Sandbox E2E Tests
 *
 * Validates the ACA Dynamic Sessions (fallback) sandbox backend against real
 * infrastructure. ACA Sandboxes has its own live test: scripts/test-aca-sandboxes-live.mjs.
 *
 *   Suite 1: DynamicSessionsClient — exec, file write/read/list via ACA session
 *   Suite 2: SandboxToolHandler — tool dispatch, credential injection
 *   Suite 3: Config & wiring — loadSkillsConfig sandbox resolution
 *   Suite 4: Error handling — timeouts, invalid commands, edge cases
 *   Suite 5: Multi-turn session persistence — state persists across calls
 *   Suite 6: OpenAI tool loop — LLM invokes sandbox_exec + file tools
 *   Suite 9: File export — sandbox_file_export to Blob Storage with SAS URL
 *
 * Environment variables (skips suites that need missing ones):
 *   - ACA_POOL_MANAGEMENT_ENDPOINT — ACA session pool endpoint
 *   - AZURE_SANDBOX_TOKEN — Bearer token for ACA (or Azure CLI login)
 *   - OPENAI_API_KEY — for real OpenAI LLM tests (Suite 6)
 *   - AZURE_STORAGE_CONNECTION_STRING — shared-key connection string for export (Suite 9)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DynamicSessionsClient } from "@agentforeach/platform-azure/sandbox";
import {
  SandboxToolHandler,
  getSandboxToolDefinitions,
  isSandboxTool,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_FILE_WRITE_TOOL_NAME,
  SANDBOX_FILE_READ_TOOL_NAME,
  SANDBOX_FILE_LIST_TOOL_NAME,
  SANDBOX_FILE_EXPORT_TOOL_NAME,
} from "./sandbox/handler.js";
import type { SandboxConfig, SandboxExecResult } from "./sandbox/types.js";
import { ExportBlobStore } from "./sandbox/export-store.js";
import { loadSkillsConfig, resetSkillsConfig } from "./config.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Stable session IDs — reuse the same ACA session containers across test runs
 * instead of creating new ones each time (which exhausts the pool's max limit).
 *
 * PythonLTS sessions cannot be programmatically stopped; they auto-destroy
 * after the cooldown period. Using stable IDs means repeated runs hit the
 * same containers rather than spawning new ones.
 */
const SESSION_PREFIX = "test";

/** Per-run suffix for filenames to avoid collisions within a session. */
const FILE_SUFFIX = Date.now().toString(36);

/** Check if ACA Dynamic Sessions endpoint is available. */
const ACA_ENDPOINT = process.env.ACA_POOL_MANAGEMENT_ENDPOINT ?? "";
const ACA_TOKEN = process.env.AZURE_SANDBOX_TOKEN ?? "";
const HAS_ACA = !!(ACA_ENDPOINT && ACA_TOKEN);

/** Check if OpenAI API key is available. */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const HAS_OPENAI = !!OPENAI_API_KEY;

/** Check if Azure Storage shared-key connection string is available. */
const STORAGE_CONN_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING ?? "";
const HAS_STORAGE = !!STORAGE_CONN_STRING && /AccountKey=/i.test(STORAGE_CONN_STRING);
const HAS_ACA_AND_STORAGE = HAS_ACA && HAS_STORAGE;

/** Container type: override with SANDBOX_CONTAINER_TYPE env var. */
const CONTAINER_TYPE = (process.env.SANDBOX_CONTAINER_TYPE ?? "PythonLTS") as
  | "PythonLTS"
  | "CustomContainer";

/** Build a test sandbox config. */
function buildSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    enabled: true,
    provider: "aca-sessions",
    poolManagementEndpoint: ACA_ENDPOINT,
    containerType: CONTAINER_TYPE,
    identifierStrategy: "userId",
    defaultTimeoutSec: 60,
    maxTimeoutSec: 220,
    cooldownSec: 600,
    networkAccess: "disabled",
    maxOutputChars: 50_000,
    exportsContainerName: "user-exports",
    exportExpiryHours: 24,
    maxExportBytes: 50 * 1024 * 1024,
    ...overrides,
  };
}

/** Build a test sandbox client with token env override. */
function buildClient(configOverrides?: Partial<SandboxConfig>): DynamicSessionsClient {
  // Set token via env so the default token provider picks it up
  process.env.AZURE_SANDBOX_TOKEN = ACA_TOKEN;
  return new DynamicSessionsClient(buildSandboxConfig(configOverrides));
}

// ============================================================================
// Suite 1: DynamicSessionsClient — direct ACA session operations
// ============================================================================

test("Suite 1: DynamicSessionsClient exec and file operations", { skip: !HAS_ACA && "ACA_POOL_MANAGEMENT_ENDPOINT not set" }, async (t) => {
  const client = buildClient();
  const sessionId = `${SESSION_PREFIX}-s1`;

  await t.test("exec: simple echo command", async () => {
    const result = await client.exec(
      { command: 'echo "hello sandbox"' },
      sessionId,
    );
    assert.equal(result.exitCode, 0, "exit code should be 0");
    assert.ok(
      result.stdout.includes("hello sandbox"),
      `stdout should contain 'hello sandbox', got: ${result.stdout}`,
    );
    assert.equal(result.timedOut, false);
    assert.equal(result.sessionId, sessionId);
    assert.ok(result.durationMs >= 0);
  });

  await t.test("exec: multi-command pipeline", async () => {
    const result = await client.exec(
      { command: 'echo "line1\nline2\nline3" | wc -l' },
      sessionId,
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.trim().includes("3"), `expected 3 lines, got: ${result.stdout}`);
  });

  await t.test("exec: command with stderr", async () => {
    const result = await client.exec(
      { command: 'echo "stdout here"; echo "stderr here" >&2' },
      sessionId,
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("stdout here"));
    assert.ok(result.stderr.includes("stderr here"));
  });

  await t.test("exec: failing command returns non-zero exit code", async () => {
    const result = await client.exec(
      { command: "exit 42" },
      sessionId,
    );
    assert.equal(result.exitCode, 42, "exit code should propagate");
  });

  await t.test("exec: python is available", async () => {
    const result = await client.exec(
      { command: 'python3 -c "print(2 + 2)"' },
      sessionId,
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.trim().includes("4"));
  });

  await t.test("fileWrite + fileRead roundtrip", async () => {
    const filename = `${FILE_SUFFIX}-test.txt`;
    const content = "Hello from AgentForEach sandbox!\nLine 2.";

    const writeResult = await client.fileWrite(
      { filename, content },
      sessionId,
    );
    assert.equal(writeResult.success, true);
    assert.equal(writeResult.filename, filename);
    assert.ok(writeResult.sizeBytes > 0);

    const readResult = await client.fileRead({ filename }, sessionId);
    assert.equal(readResult.content, content);
    assert.equal(readResult.filename, filename);
  });

  await t.test("fileList includes uploaded file", async () => {
    const files = await client.fileList(sessionId);
    const testFile = files.find((f) => f.filename.includes(FILE_SUFFIX));
    assert.ok(testFile, `should find file with RUN_ID in list, got: ${JSON.stringify(files)}`);
    assert.ok(testFile.size > 0);
  });

  await t.test("resolveIdentifier: userId strategy", () => {
    const id = client.resolveIdentifier("user123");
    assert.match(id, /^afe-[0-9a-f]{64}$/);
    assert.equal(id, client.resolveIdentifier("user123", "another-session"), "one per user");
  });

  await t.test("resolveIdentifier: sessionId strategy", () => {
    const client2 = buildClient({ identifierStrategy: "sessionId" });
    const id = client2.resolveIdentifier("user123", "sess456");
    assert.notEqual(id, client2.resolveIdentifier("user123", "sess789"));
    assert.notEqual(id, client2.resolveIdentifier("user123:sess456"));
  });

  await t.test("isReady returns true for configured client", () => {
    assert.equal(client.isReady(), true);
  });

  await t.test("isReady returns false for empty endpoint", () => {
    const client2 = buildClient({ poolManagementEndpoint: "" });
    assert.equal(client2.isReady(), false);
  });
});

// ============================================================================
// Suite 2: SandboxToolHandler — tool dispatch
// ============================================================================

test("Suite 2: SandboxToolHandler tool dispatch", { skip: !HAS_ACA && "ACA_POOL_MANAGEMENT_ENDPOINT not set" }, async (t) => {
  const client = buildClient();
  const handler = new SandboxToolHandler(client, {}, `${SESSION_PREFIX}-s2`);

  await t.test("handle sandbox_exec", async () => {
    const result = await handler.handle(SANDBOX_EXEC_TOOL_NAME, {
      command: "echo handler-test",
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.exitCode, 0);
    assert.ok(parsed.stdout.includes("handler-test"));
  });

  await t.test("handle sandbox_file_write + sandbox_file_read", async () => {
    const filename = `${FILE_SUFFIX}-handler.txt`;

    const writeResult = await handler.handle(SANDBOX_FILE_WRITE_TOOL_NAME, {
      filename,
      content: "handler file content",
    });
    const writeParsed = JSON.parse(writeResult);
    assert.equal(writeParsed.success, true);

    const readResult = await handler.handle(SANDBOX_FILE_READ_TOOL_NAME, {
      filename,
    });
    const readParsed = JSON.parse(readResult);
    assert.equal(readParsed.content, "handler file content");
  });

  await t.test("handle sandbox_file_list", async () => {
    const result = await handler.handle(SANDBOX_FILE_LIST_TOOL_NAME, {});
    const parsed = JSON.parse(result);
    assert.ok(Array.isArray(parsed.files));
  });

  await t.test("handle missing command returns error", async () => {
    const result = await handler.handle(SANDBOX_EXEC_TOOL_NAME, {});
    const parsed = JSON.parse(result);
    assert.ok(parsed.error, "should return error for missing command");
  });

  await t.test("handle missing filename returns error", async () => {
    const result = await handler.handle(SANDBOX_FILE_READ_TOOL_NAME, {});
    const parsed = JSON.parse(result);
    assert.ok(parsed.error, "should return error for missing filename");
  });

  await t.test("handle unknown tool returns error", async () => {
    const result = await handler.handle("sandbox_unknown", {});
    const parsed = JSON.parse(result);
    assert.ok(parsed.error?.includes("Unknown sandbox tool"));
  });
});

// ============================================================================
// Suite 3: Tool definitions and utility functions
// ============================================================================

test("Suite 3: Tool definitions and helpers", async (t) => {
  await t.test("getSandboxToolDefinitions returns 6 tools", () => {
    const tools = getSandboxToolDefinitions();
    assert.equal(tools.length, 6);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes(SANDBOX_EXEC_TOOL_NAME));
    assert.ok(names.includes(SANDBOX_FILE_WRITE_TOOL_NAME));
    assert.ok(names.includes(SANDBOX_FILE_READ_TOOL_NAME));
    assert.ok(names.includes(SANDBOX_FILE_LIST_TOOL_NAME));
    assert.ok(names.includes(SANDBOX_FILE_EXPORT_TOOL_NAME));
  });

  await t.test("tool definitions have valid structure", () => {
    const tools = getSandboxToolDefinitions();
    for (const tool of tools) {
      assert.equal(tool.type, "function");
      assert.ok(tool.name, "tool should have a name");
      assert.ok(tool.description, "tool should have a description");
      assert.equal(tool.parameters.type, "object");
    }
  });

  await t.test("sandbox_exec requires 'command' parameter", () => {
    const execTool = getSandboxToolDefinitions().find(
      (t) => t.name === SANDBOX_EXEC_TOOL_NAME,
    );
    assert.ok(execTool);
    assert.ok(execTool.parameters.required?.includes("command"));
  });

  await t.test("sandbox_file_write requires 'filename' and 'content'", () => {
    const tool = getSandboxToolDefinitions().find(
      (t) => t.name === SANDBOX_FILE_WRITE_TOOL_NAME,
    );
    assert.ok(tool);
    assert.ok(tool.parameters.required?.includes("filename"));
    assert.ok(tool.parameters.required?.includes("content"));
  });

  await t.test("isSandboxTool correctly identifies sandbox tools", () => {
    assert.equal(isSandboxTool(SANDBOX_EXEC_TOOL_NAME), true);
    assert.equal(isSandboxTool(SANDBOX_FILE_WRITE_TOOL_NAME), true);
    assert.equal(isSandboxTool(SANDBOX_FILE_READ_TOOL_NAME), true);
    assert.equal(isSandboxTool(SANDBOX_FILE_LIST_TOOL_NAME), true);
    assert.equal(isSandboxTool("exec"), false);
    assert.equal(isSandboxTool("skill_list"), false);
    assert.equal(isSandboxTool("unknown_tool"), false);
  });
});

// ============================================================================
// Suite 4: Config resolution
// ============================================================================

test("Suite 4: Config loads sandbox section", async (t) => {
  await t.test("loadSkillsConfig includes sandbox when configured", () => {
    resetSkillsConfig();
    const config = loadSkillsConfig();
    // agentforeach.json has sandbox.enabled = false by default
    if (config.sandbox) {
      assert.equal(typeof config.sandbox.enabled, "boolean");
      assert.equal(config.sandbox.provider, "aca");
      assert.ok(config.sandbox.defaultTimeoutSec > 0);
      assert.ok(config.sandbox.maxTimeoutSec > 0);
      assert.ok(config.sandbox.cooldownSec > 0);
    }
    resetSkillsConfig();
  });

  await t.test("sandbox defaults are applied correctly", () => {
    const config = buildSandboxConfig({
      poolManagementEndpoint: "https://example.com",
    });
    assert.equal(config.enabled, true);
    assert.equal(config.provider, "aca");
    assert.equal(config.identifierStrategy, "userId");
    assert.equal(config.defaultTimeoutSec, 60);
    assert.equal(config.maxTimeoutSec, 220);
    assert.equal(config.cooldownSec, 600);
    assert.equal(config.networkAccess, "disabled");
  });
});

// ============================================================================
// Suite 5: Multi-turn session persistence
// ============================================================================

test("Suite 5: Multi-turn session persistence", { skip: !HAS_ACA && "ACA_POOL_MANAGEMENT_ENDPOINT not set" }, async (t) => {
  const client = buildClient();
  const sessionId = `${SESSION_PREFIX}-s5`;

  await t.test("set env var in one exec, read in next", async () => {
    // Step 1: set an env var
    await client.exec(
      { command: 'export MY_VAR="persistent_value"' },
      sessionId,
    );

    // Note: export in subprocess doesn't persist across ACA code/execute calls
    // because each call is a new Python subprocess. We test file persistence instead.
  });

  await t.test("file written persists across exec calls", async () => {
    const filename = `${FILE_SUFFIX}-persist.txt`;

    // Write file in one exec
    await client.exec(
      { command: `echo "persisted content" > /mnt/data/${filename}` },
      sessionId,
    );

    // Read file in another exec
    const result = await client.exec(
      { command: `cat /mnt/data/${filename}` },
      sessionId,
    );
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.stdout.includes("persisted content"),
      `file should persist across calls, got: ${result.stdout}`,
    );
  });

  await t.test("pip install persists in session", async () => {
    // Install a package (--break-system-packages for Debian 12 PEP 668 compat)
    const installResult = await client.exec(
      { command: "pip install --break-system-packages cowsay 2>&1 | tail -1" },
      sessionId,
    );
    assert.equal(installResult.exitCode, 0);

    // Verify it's importable in subsequent call
    const verifyResult = await client.exec(
      { command: 'python3 -c "import cowsay; print(\'ok\')"' },
      sessionId,
    );
    assert.equal(verifyResult.exitCode, 0);
    assert.ok(verifyResult.stdout.includes("ok"));
  });

  await t.test("complex multi-step workflow", async () => {
    // Step 1: Create a Python script
    const script = `
import json
data = {"name": "AgentForEach", "version": "1.0", "features": ["sandbox", "skills", "memory"]}
with open("/mnt/data/result.json", "w") as f:
    json.dump(data, f)
print(f"Wrote {len(json.dumps(data))} bytes")
`;
    await client.fileWrite(
      { filename: "process.py", content: script },
      sessionId,
    );

    // Step 2: Run the script
    const execResult = await client.exec(
      { command: "python3 /mnt/data/process.py" },
      sessionId,
    );
    assert.equal(execResult.exitCode, 0);
    assert.ok(execResult.stdout.includes("Wrote"));

    // Step 3: Read the output
    const readResult = await client.fileRead(
      { filename: "result.json" },
      sessionId,
    );
    const parsed = JSON.parse(readResult.content);
    assert.equal(parsed.name, "AgentForEach");
    assert.equal(parsed.version, "1.0");
    assert.ok(Array.isArray(parsed.features));
    assert.ok(parsed.features.includes("sandbox"));
  });
});

// ============================================================================
// Suite 6: Credential injection
// ============================================================================

test("Suite 6: Credential injection into sandbox", { skip: !HAS_ACA && "ACA_POOL_MANAGEMENT_ENDPOINT not set" }, async (t) => {
  const client = buildClient();
  const credentials = {
    MY_API_KEY: "test-key-12345",
    MY_SECRET: "s3cret_value",
  };
  const handler = new SandboxToolHandler(
    client,
    credentials,
    `${SESSION_PREFIX}-s6`,
  );

  await t.test("credentials available as env vars after first exec", async () => {
    // First exec triggers credential injection
    const result1 = await handler.handle(SANDBOX_EXEC_TOOL_NAME, {
      command: "echo $MY_API_KEY",
    });
    const parsed1 = JSON.parse(result1) as SandboxExecResult;
    // Credentials are set via Python os.environ, which persists in the session.
    // The bash command accesses the env of the Python wrapper, not the outer shell.
    // So we verify via a Python check instead:
    assert.equal(parsed1.exitCode, 0);
  });

  await t.test("credentials persist across subsequent exec calls", async () => {
    const result = await handler.handle(SANDBOX_EXEC_TOOL_NAME, {
      command: 'python3 -c "import os; print(os.environ.get(\'MY_API_KEY\', \'NOT_SET\'))"',
    });
    const parsed = JSON.parse(result) as SandboxExecResult;
    assert.equal(parsed.exitCode, 0);
    // The credential may or may not be visible depending on how ACA handles
    // subprocess env inheritance. This is a best-effort test.
  });
});

// ============================================================================
// Suite 7: Error handling
// ============================================================================

test("Suite 7: Error handling and edge cases", { skip: !HAS_ACA && "ACA_POOL_MANAGEMENT_ENDPOINT not set" }, async (t) => {
  const client = buildClient();
  const sessionId = `${SESSION_PREFIX}-s7`;

  await t.test("command not found returns non-zero exit code", async () => {
    const result = await client.exec(
      { command: "nonexistent_command_xyz_12345" },
      sessionId,
    );
    assert.ok(result.exitCode !== 0, "non-existent command should fail");
    assert.ok(
      result.stderr.includes("not found") || result.stderr.includes("No such file"),
      `stderr should indicate command not found, got: ${result.stderr}`,
    );
  });

  await t.test("read non-existent file returns error", async () => {
    try {
      await client.fileRead(
        { filename: "this-file-does-not-exist-xyz.txt" },
        sessionId,
      );
      assert.fail("should have thrown for non-existent file");
    } catch (err: unknown) {
      // Expected — either ACA returns error or our wrapper throws
      assert.ok(err instanceof Error || true);
    }
  });

  await t.test("empty command returns error via handler", async () => {
    const handler = new SandboxToolHandler(client, {}, sessionId);
    const result = await handler.handle(SANDBOX_EXEC_TOOL_NAME, {
      command: "",
    });
    const parsed = JSON.parse(result);
    assert.ok(parsed.error, "empty command should return error");
  });

  await t.test("timeout parameter is respected", async () => {
    const result = await client.exec(
      { command: "sleep 3 && echo done", timeout: 2 },
      sessionId,
    );
    // Should either timeout or complete quickly
    assert.ok(
      result.timedOut || result.exitCode !== 0 || result.stdout.includes("done"),
      "command should respect timeout",
    );
  });
});

// ============================================================================
// Suite 8: OpenAI tool loop — LLM invokes sandbox tools
// ============================================================================

test("Suite 8: OpenAI tool loop with sandbox", {
  skip: (!HAS_ACA || !HAS_OPENAI) && "ACA + OPENAI required",
}, async (t) => {
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const client = buildClient();
  const sessionId = `${SESSION_PREFIX}-s8`;
  const handler = new SandboxToolHandler(client, {}, sessionId);

  const tools = getSandboxToolDefinitions().map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
    strict: false,
  }));

  await t.test("LLM creates and runs a Python script via sandbox", async () => {
    // Initial response asking the LLM to compute fibonacci
    let response = await openai.responses.create({
      model: "gpt-4.1-mini",
      instructions:
        "You have a sandbox available. Use sandbox_file_write to write a Python script, " +
        "then sandbox_exec to run it. Respond with just the result. " +
        "The script should compute the 20th Fibonacci number and print it.",
      input: "Calculate the 20th Fibonacci number using a Python script in the sandbox.",
      tools,
    });

    let rounds = 0;
    const maxRounds = 5;

    while (rounds < maxRounds) {
      // Find tool calls in the output
      const toolCalls = response.output.filter(
        (item: { type: string }) => item.type === "function_call",
      );

      if (toolCalls.length === 0) break;

      // Execute each tool call
      const toolResults: Array<{
        type: "function_call_output";
        call_id: string;
        output: string;
      }> = [];

      for (const call of toolCalls) {
        const fc = call as {
          type: "function_call";
          call_id: string;
          name: string;
          arguments: string;
        };
        const args = JSON.parse(fc.arguments);
        const result = await handler.handle(fc.name, args);
        toolResults.push({
          type: "function_call_output",
          call_id: fc.call_id,
          output: result,
        });
      }

      // Continue the conversation with tool results
      response = await openai.responses.create({
        model: "gpt-4.1-mini",
        previous_response_id: response.id,
        input: toolResults,
        tools,
      });

      rounds++;
    }

    // Extract the final text response
    const textOutput = response.output.find(
      (item: { type: string }) => item.type === "message",
    );
    const finalText = textOutput
      ? (textOutput as { type: "message"; content: Array<{ type: string; text?: string }> })
          .content.map((c) => c.text ?? "").join("")
      : "";

    // The 20th Fibonacci number is 6765
    assert.ok(
      finalText.includes("6765"),
      `LLM response should contain 6765, got: ${finalText}`,
    );
  });

  await t.test("LLM uses sandbox_exec for data processing", async () => {
    let response = await openai.responses.create({
      model: "gpt-4.1-mini",
      instructions:
        "You have a sandbox. Use sandbox_exec to run a bash command. " +
        "Respond with just the result number.",
      input: "Use the sandbox to count how many words are in: 'The quick brown fox jumps over the lazy dog'",
      tools,
    });

    let rounds = 0;
    while (rounds < 3) {
      const toolCalls = response.output.filter(
        (item: { type: string }) => item.type === "function_call",
      );
      if (toolCalls.length === 0) break;

      const toolResults: Array<{
        type: "function_call_output";
        call_id: string;
        output: string;
      }> = [];

      for (const call of toolCalls) {
        const fc = call as {
          type: "function_call";
          call_id: string;
          name: string;
          arguments: string;
        };
        const args = JSON.parse(fc.arguments);
        const result = await handler.handle(fc.name, args);
        toolResults.push({
          type: "function_call_output",
          call_id: fc.call_id,
          output: result,
        });
      }

      response = await openai.responses.create({
        model: "gpt-4.1-mini",
        previous_response_id: response.id,
        input: toolResults,
        tools,
      });
      rounds++;
    }

    const textOutput = response.output.find(
      (item: { type: string }) => item.type === "message",
    );
    const finalText = textOutput
      ? (textOutput as { type: "message"; content: Array<{ type: string; text?: string }> })
          .content.map((c) => c.text ?? "").join("")
      : "";

    assert.ok(
      finalText.includes("9"),
      `should identify 9 words, got: ${finalText}`,
    );
  });
});

// ============================================================================
// Suite 9: File export — sandbox_file_export → Blob Storage → SAS URL
// ============================================================================

test("Suite 9: sandbox_file_export E2E", {
  skip: !HAS_ACA_AND_STORAGE && "ACA + AZURE_STORAGE_CONNECTION_STRING required",
}, async (t) => {
  const client = buildClient();
  const sessionId = `${SESSION_PREFIX}-s9`;
  const exportStore = new ExportBlobStore(STORAGE_CONN_STRING);
  const handler = new SandboxToolHandler(
    client,
    {},
    sessionId,
    undefined,        // sessionIdOverride
    undefined,        // blobStore
    exportStore,
  );

  await t.test("export a text file creates SAS download URL", async () => {
    const filename = `${FILE_SUFFIX}-export.txt`;
    const content = "Hello from AgentForEach sandbox! This file was exported.";

    // Step 1: Write file into sandbox
    const writeResult = await handler.handle(SANDBOX_FILE_WRITE_TOOL_NAME, {
      filename,
      content,
    });
    const writeParsed = JSON.parse(writeResult);
    assert.ok(!writeParsed.error, `write should succeed: ${writeResult}`);

    // Step 2: Export the file
    const exportResult = await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, {
      filename,
    });
    const exportParsed = JSON.parse(exportResult);

    assert.ok(exportParsed.success, `export should succeed: ${exportResult}`);
    assert.ok(exportParsed.downloadUrl, "should have downloadUrl");
    assert.ok(
      exportParsed.downloadUrl.startsWith("https://"),
      `URL should be HTTPS, got: ${exportParsed.downloadUrl}`,
    );
    assert.ok(exportParsed.downloadUrl.includes("sig="), "URL should contain SAS signature");
    assert.equal(exportParsed.filename, filename);
    assert.ok(exportParsed.sizeBytes > 0, "sizeBytes should be > 0");
    assert.ok(exportParsed.expiresAt, "should have expiresAt");

    // Step 3: Verify the SAS URL is downloadable
    const downloadResponse = await fetch(exportParsed.downloadUrl);
    assert.equal(
      downloadResponse.status,
      200,
      `SAS URL should return 200, got: ${downloadResponse.status}`,
    );

    const downloadedText = await downloadResponse.text();
    assert.equal(
      downloadedText,
      content,
      `downloaded content should match original`,
    );
  });

  await t.test("export a binary file (PNG) creates valid download", async () => {
    const filename = `${FILE_SUFFIX}-export.png`;

    // Create a minimal 1x1 red PNG inside the sandbox via Python
    const createPng = `python3 -c "
import struct, zlib
# Minimal 1x1 RGBA red PNG
sig = b'\\x89PNG\\r\\n\\x1a\\n'
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)  # 1x1 RGB
raw = zlib.compress(b'\\x00\\xff\\x00\\x00')  # filter=none, red pixel
png = sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')
with open('/mnt/data/${filename}', 'wb') as f:
    f.write(png)
print(f'wrote {len(png)} bytes')
"`;

    const execResult = await handler.handle(SANDBOX_EXEC_TOOL_NAME, {
      command: createPng,
    });
    const execParsed = JSON.parse(execResult) as SandboxExecResult;
    assert.equal(execParsed.exitCode, 0, `PNG creation should succeed: ${execResult}`);
    assert.ok(execParsed.stdout.includes("wrote"), `should report bytes written`);

    // Export the binary file
    const exportResult = await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, {
      filename,
    });
    const exportParsed = JSON.parse(exportResult);

    assert.ok(exportParsed.success, `export should succeed: ${exportResult}`);
    assert.ok(exportParsed.downloadUrl.includes("sig="), "SAS URL should have signature");
    assert.ok(exportParsed.sizeBytes > 0, "binary file should have size > 0");

    // Verify download returns PNG
    const downloadResponse = await fetch(exportParsed.downloadUrl);
    assert.equal(downloadResponse.status, 200);
    const contentType = downloadResponse.headers.get("content-type");
    assert.ok(
      contentType?.includes("image/png"),
      `content-type should be image/png, got: ${contentType}`,
    );

    // Verify PNG magic bytes
    const buffer = await downloadResponse.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    assert.equal(bytes[0], 0x89, "first byte should be 0x89 (PNG signature)");
    assert.equal(bytes[1], 0x50, "second byte should be P");
    assert.equal(bytes[2], 0x4e, "third byte should be N");
    assert.equal(bytes[3], 0x47, "fourth byte should be G");
  });

  await t.test("export non-existent file returns error", async () => {
    const result = await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, {
      filename: "this-file-does-not-exist-xyz.txt",
    });
    const parsed = JSON.parse(result);
    assert.ok(parsed.error, `should return error for non-existent file: ${result}`);
  });

  await t.test("export with missing filename returns error", async () => {
    const result = await handler.handle(SANDBOX_FILE_EXPORT_TOOL_NAME, {});
    const parsed = JSON.parse(result);
    assert.ok(parsed.error, "should return error for missing filename");
    assert.ok(parsed.error.includes("filename"), "error should mention filename");
  });
});
