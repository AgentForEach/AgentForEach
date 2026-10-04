/**
 * AgentForEach Skills Layer — Sandbox Tool Handler
 *
 * Provides sandboxed shell execution via a SandboxBackend (ACA Sandboxes, or
 * ACA Dynamic Sessions as the fallback).
 * Modeled after OpenAI's shell tool pattern:
 *
 *   OpenAI shell_call            AgentForEach sandbox_exec
 *   ─────────────────            ──────────────────
 *   container_auto               session per userId
 *   commands[]                   command (bash string)
 *   domain_secrets               credentials injected at the egress proxy
 *   /mnt/data file I/O           sandbox_file_write / _read
 *   shell_call_output            SandboxExecResult
 *
 * Tools exposed:
 *   - sandbox_exec        — run bash command(s) in sandbox
 *   - sandbox_file_write  — write a file to /mnt/data/
 *   - sandbox_file_read   — read a file from /mnt/data/
 *   - sandbox_file_list   — list files in /mnt/data/
 *   - sandbox_file_export — export a sandbox file to Blob Storage (download link)
 *   - sandbox_skill_load  — load a skill zip package into the sandbox
 *
 * Security:
 *   - One sandbox per user (ACA Sandboxes; Hyper-V isolated sessions in the
 *     Dynamic Sessions fallback)
 *   - Credentials bound to hosts are added by the sandbox's egress proxy and
 *     never enter it; the env var holds a placeholder. Credentials without
 *     hosts (or on a backend without egress injection) are env vars, set
 *     outside the tool arguments
 *   - Credential values are redacted from tool results (SkillToolHandler)
 *   - Output truncated to prevent LLM context overflow
 *   - Timeout enforced (capped by skills.sandbox maxTimeoutSec)
 *   - Network access controlled by skills.sandbox.networkAccess
 */

import type { ToolDefinition } from "../../memory/types.js";
import type {
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileWriteArgs,
  SandboxFileReadArgs,
} from "./types.js";
import type { EgressCredential, SandboxBackend } from "./types.js";
import type { CredentialBinding } from "../types.js";
import { EGRESS_INJECTED_PLACEHOLDER, formatCredential } from "../credentials.js";
import type { SkillBlobStore } from "../blob-store.js";
import type { ExportBlobStore } from "./export-store.js";

// ============================================================================
// Tool Names
// ============================================================================

export const SANDBOX_EXEC_TOOL_NAME = "sandbox_exec";
export const SANDBOX_FILE_WRITE_TOOL_NAME = "sandbox_file_write";
export const SANDBOX_FILE_READ_TOOL_NAME = "sandbox_file_read";
export const SANDBOX_FILE_LIST_TOOL_NAME = "sandbox_file_list";
export const SANDBOX_FILE_EXPORT_TOOL_NAME = "sandbox_file_export";
export const SANDBOX_SKILL_LOAD_TOOL_NAME = "sandbox_skill_load";

const SANDBOX_TOOL_NAMES = new Set([
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_FILE_WRITE_TOOL_NAME,
  SANDBOX_FILE_READ_TOOL_NAME,
  SANDBOX_FILE_LIST_TOOL_NAME,
  SANDBOX_FILE_EXPORT_TOOL_NAME,
  SANDBOX_SKILL_LOAD_TOOL_NAME,
]);

// ============================================================================
// Tool Definitions
// ============================================================================

const SANDBOX_EXEC_TOOL: ToolDefinition = {
  type: "function",
  name: SANDBOX_EXEC_TOOL_NAME,
  description:
    "Execute a bash command in a secure sandbox container. Use for code execution, data processing, " +
    "file manipulation, or anything beyond a simple HTTP call. " +
    "Supports any command — no allowlist restrictions. " +
    "Files in /mnt/data/ persist across calls. " +
    "Available tools depend on the sandbox image (the default image has python3, pip, node, npm, git and jq); " +
    "check with `command -v` if unsure. Outbound network may be restricted. " +
    "User credentials are available as environment variables. " +
    "For simple API/HTTP calls, prefer http_fetch instead (lighter weight).",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          'Bash command(s) to execute. Runs as `bash -c "<command>"`. ' +
          'Example: "pip install pandas && python3 script.py"',
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds. The server applies its default and caps long values.",
      },
    },
    required: ["command"],
  },
};

const SANDBOX_FILE_WRITE_TOOL: ToolDefinition = {
  type: "function",
  name: SANDBOX_FILE_WRITE_TOOL_NAME,
  description:
    "Write a file to the sandbox at /mnt/data/<filename>. " +
    "Use this to create scripts, data files, or config before running sandbox_exec.",
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description: 'Filename (stored in /mnt/data/). Example: "script.py".',
      },
      content: {
        type: "string",
        description: "File content (text).",
      },
    },
    required: ["filename", "content"],
  },
};

const SANDBOX_FILE_READ_TOOL: ToolDefinition = {
  type: "function",
  name: SANDBOX_FILE_READ_TOOL_NAME,
  description:
    "Read a file from the sandbox at /mnt/data/<filename>. " +
    "Use this to retrieve output files or inspect results.",
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description: "Filename to read from /mnt/data/.",
      },
    },
    required: ["filename"],
  },
};

const SANDBOX_FILE_LIST_TOOL: ToolDefinition = {
  type: "function",
  name: SANDBOX_FILE_LIST_TOOL_NAME,
  description:
    "List files in the sandbox at /mnt/data/. " +
    "Returns filenames, sizes, and last-modified timestamps.",
  parameters: {
    type: "object",
    properties: {},
  },
};

const SANDBOX_SKILL_LOAD_TOOL: ToolDefinition = {
  type: "function",
  name: SANDBOX_SKILL_LOAD_TOOL_NAME,
  description:
    "Load a skill's zip package from Blob Storage into the sandbox. " +
    "Downloads the skill's zip, transfers it to the sandbox, and extracts all files " +
    "into /mnt/data/<skill_id>/. Returns the SKILL.md content and a file listing. " +
    "After loading, use sandbox_exec to run the skill's scripts. " +
    "This is the preferred way to load multi-file skills into the sandbox.",
  parameters: {
    type: "object",
    properties: {
      skill_id: {
        type: "string",
        description:
          'The skill identifier (e.g., "weather"). Must match a skill from skill_list.',
      },
    },
    required: ["skill_id"],
  },
};

const SANDBOX_FILE_EXPORT_TOOL: ToolDefinition = {
  type: "function",
  name: SANDBOX_FILE_EXPORT_TOOL_NAME,
  description:
    "Export a file from the sandbox and generate a download link for the user. " +
    "Reads the file from /mnt/data/, uploads it to cloud storage, and returns a " +
    "time-limited download URL (24h). Use this when the user needs to download a " +
    "file created in the sandbox (CSV, PDF, image, code output, etc.). " +
    "Works with both text and binary files.",
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description:
          'Filename to export from /mnt/data/. Example: "report.csv" or "chart.png".',
      },
    },
    required: ["filename"],
  },
};

const SANDBOX_TOOLS: ToolDefinition[] = [
  SANDBOX_EXEC_TOOL,
  SANDBOX_FILE_WRITE_TOOL,
  SANDBOX_FILE_READ_TOOL,
  SANDBOX_FILE_LIST_TOOL,
  SANDBOX_FILE_EXPORT_TOOL,
  SANDBOX_SKILL_LOAD_TOOL,
];

// ============================================================================
// Public Helpers
// ============================================================================

/** Get all sandbox tool definitions. */
export function getSandboxToolDefinitions(): ToolDefinition[] {
  return SANDBOX_TOOLS;
}

/** Check whether a tool name is a sandbox tool. */
export function isSandboxTool(toolName: string): boolean {
  return SANDBOX_TOOL_NAMES.has(toolName);
}

// ============================================================================
// Sandbox Tool Handler
// ============================================================================

/**
 * Handles sandbox tool calls from the LLM.
 *
 * On first sandbox_exec call, injects user credentials as env vars into the
 * session (so subsequent commands can use $API_KEY etc. without leaking
 * credentials in tool call arguments).
 */
export class SandboxToolHandler {
  private client: SandboxBackend;
  private credentialBindings: Record<string, CredentialBinding>;
  private credentials: Record<string, string>;
  private userId: string;
  private sessionIdOverride?: string;
  private credentialsInjected = false;
  private blobStore?: SkillBlobStore;
  private exportStore?: ExportBlobStore;
  private isSkillEnabled?: (skillId: string) => boolean;

  /**
   * @param client - ACA sandbox client.
   * @param credentials - User's API keys/tokens to inject as env vars.
   * @param userId - User ID for session routing.
   * @param sessionId - Optional session/conversation ID for per-session isolation.
   * @param blobStore - Optional blob store for loading skill zip packages.
   * @param exportStore - Optional export store for sandbox_file_export.
   */
  constructor(
    client: SandboxBackend,
    credentials: Record<string, string>,
    userId: string,
    sessionId?: string,
    blobStore?: SkillBlobStore,
    exportStore?: ExportBlobStore,
    credentialBindings: Record<string, CredentialBinding> = {},
    /** When given, sandbox_skill_load refuses skills the user hasn't enabled. */
    isSkillEnabled?: (skillId: string) => boolean,
  ) {
    this.isSkillEnabled = isSkillEnabled;
    this.client = client;
    this.credentials = credentials;
    this.credentialBindings = credentialBindings;
    this.userId = userId;
    this.sessionIdOverride = sessionId;
    this.blobStore = blobStore;
    this.exportStore = exportStore;
  }

  /** Check whether this handler can handle the given tool name. */
  isSandboxTool(toolName: string): boolean {
    return SANDBOX_TOOL_NAMES.has(toolName);
  }

  /** Handle a sandbox tool call. */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const identifier = this.identifier();

    switch (toolName) {
      case SANDBOX_EXEC_TOOL_NAME:
        return this.handleExec(args, identifier);
      case SANDBOX_FILE_WRITE_TOOL_NAME:
        return this.handleFileWrite(args, identifier);
      case SANDBOX_FILE_READ_TOOL_NAME:
        return this.handleFileRead(args, identifier);
      case SANDBOX_FILE_LIST_TOOL_NAME:
        return this.handleFileList(identifier);
      case SANDBOX_FILE_EXPORT_TOOL_NAME:
        return this.handleFileExport(args, identifier);
      case SANDBOX_SKILL_LOAD_TOOL_NAME:
        return this.handleSkillLoad(args, identifier);
      default:
        return JSON.stringify({ error: `Unknown sandbox tool: ${toolName}` });
    }
  }

  /**
   * Run a command another tool built (the browser) in this user's sandbox,
   * after the same once-per-turn credential rewrite sandbox_exec gets.
   */
  async runCommand(command: string, timeoutSec: number): Promise<SandboxExecResult> {
    const identifier = this.identifier();
    await this.ensureCredentialsInjected(identifier);
    return this.client.exec({ command, timeout: timeoutSec }, identifier);
  }

  /** Write a text file under /mnt/data for a command another tool runs next (the browser's handoff payload). */
  async writeFile(filename: string, content: string): Promise<void> {
    await this.client.fileWrite({ filename, content }, this.identifier());
  }

  /** A /mnt/data file as base64 (for the model to see an image), or undefined if empty or over `maxBytes`. */
  async readFileBase64(filename: string, maxBytes: number): Promise<string | undefined> {
    const file = await this.client.fileReadBinary({ filename }, this.identifier());
    if (!file.contentBase64 || file.sizeBytes > maxBytes) return undefined;
    return file.contentBase64;
  }

  /** Export a /mnt/data file as a download link; the same result as sandbox_file_export. */
  exportFile(filename: string): Promise<string> {
    return this.handleFileExport({ filename }, this.identifier());
  }

  /**
   * Hosts the egress proxy adds this user's credentials to. The browser keeps
   * pages from sending their own requests there (the proxy would sign them).
   */
  injectedHosts(): string[] {
    if (!this.client.capabilities.egressCredentials) return [];
    return Object.entries(this.credentialBindings)
      .filter(([key, binding]) => binding?.header && this.credentials[key] !== undefined)
      .flatMap(([, binding]) => binding.hosts);
  }

  private identifier(): string {
    return this.client.resolveIdentifier(this.userId, this.sessionIdOverride);
  }

  // --------------------------------------------------------------------------
  // sandbox_exec
  // --------------------------------------------------------------------------

  private async handleExec(
    args: Record<string, unknown>,
    identifier: string,
  ): Promise<string> {
    const command = String(args.command ?? "");
    if (!command.trim()) {
      return JSON.stringify({
        error:
          'Missing required parameter: command. Example: "ls -la /mnt/data"',
      });
    }

    // Inject credentials as env vars on first exec (lazy, once per handler)
    await this.ensureCredentialsInjected(identifier);

    const execArgs: SandboxExecArgs = {
      command,
      timeout: typeof args.timeout === "number" ? args.timeout : undefined,
    };

    try {
      const result = await this.client.exec(execArgs, identifier);
      return JSON.stringify(result);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Sandbox execution failed";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // sandbox_file_write
  // --------------------------------------------------------------------------

  private async handleFileWrite(
    args: Record<string, unknown>,
    identifier: string,
  ): Promise<string> {
    const filename = String(args.filename ?? "");
    const content = String(args.content ?? "");

    if (!filename.trim()) {
      return JSON.stringify({ error: "Missing required parameter: filename" });
    }

    const writeArgs: SandboxFileWriteArgs = { filename, content };

    try {
      const result = await this.client.fileWrite(writeArgs, identifier);
      return JSON.stringify(result);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "File write failed";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // sandbox_file_read
  // --------------------------------------------------------------------------

  private async handleFileRead(
    args: Record<string, unknown>,
    identifier: string,
  ): Promise<string> {
    const filename = String(args.filename ?? "");
    if (!filename.trim()) {
      return JSON.stringify({ error: "Missing required parameter: filename" });
    }

    const readArgs: SandboxFileReadArgs = { filename };

    try {
      const result = await this.client.fileRead(readArgs, identifier);
      return JSON.stringify(result);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "File read failed";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // sandbox_file_list
  // --------------------------------------------------------------------------

  private async handleFileList(identifier: string): Promise<string> {
    try {
      const files = await this.client.fileList(identifier);
      return JSON.stringify({ files, sessionId: identifier });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "File list failed";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // sandbox_file_export
  // --------------------------------------------------------------------------

  /**
   * Export a file from the sandbox to Blob Storage and return a SAS download URL.
   *
   * Flow:
   *   1. Read file from sandbox as base64 (supports binary)
   *   2. Upload to Azure Blob Storage (user-exports container)
   *   3. Generate time-limited SAS URL
   *   4. Return download URL to LLM → LLM presents link to user
   */
  private async handleFileExport(
    args: Record<string, unknown>,
    identifier: string,
  ): Promise<string> {
    const filename = String(args.filename ?? "").trim();
    if (!filename) {
      return JSON.stringify({
        error: 'Missing required parameter: filename. Example: "report.csv"',
      });
    }

    if (!this.exportStore) {
      return JSON.stringify({
        error:
          "File export not configured. The export blob store is not available.",
      });
    }

    try {
      // 1. Read file as base64 from sandbox
      const binaryResult = await this.client.fileReadBinary(
        { filename },
        identifier,
      );

      if (!binaryResult.contentBase64) {
        return JSON.stringify({
          error: `File "${filename}" is empty or could not be read from sandbox.`,
        });
      }

      // 2. Decode base64 to Buffer
      const content = Buffer.from(binaryResult.contentBase64, "base64");

      // 3. Upload to Blob Storage and get SAS URL
      const result = await this.exportStore.upload(
        this.userId,
        filename,
        content,
      );

      return JSON.stringify({
        success: true,
        downloadUrl: result.downloadUrl,
        filename,
        sizeBytes: result.sizeBytes,
        expiresAt: result.expiresAt,
        sessionId: identifier,
        hint: `File exported successfully. Share this download link with the user: ${result.downloadUrl}`,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "File export failed";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // sandbox_skill_load
  // --------------------------------------------------------------------------

  /**
   * Load a skill zip package from Blob Storage into the sandbox.
   *
   * Flow:
   *   1. Download {skillId}/skill.zip from Blob Storage
   *   2. Base64-encode the zip bytes
   *   3. Write the base64 string to /mnt/data/_skill_load.b64 in sandbox
   *   4. Decode + unzip into /mnt/data/{skillId}/
   *   5. Return SKILL.md content + file listing
   *
   * This enables multi-file skills: the LLM reads SKILL.md for instructions,
   * then runs sandbox_exec to execute the skill's scripts.
   */
  private async handleSkillLoad(
    args: Record<string, unknown>,
    identifier: string,
  ): Promise<string> {
    const skillId = String(args.skill_id ?? "").trim();
    if (!skillId) {
      return JSON.stringify({
        error:
          'Missing required parameter: skill_id. Example: "weather"',
      });
    }

    // Validate skill_id: alphanumeric, hyphens, underscores only (no shell metacharacters)
    if (!/^[a-zA-Z0-9_-]+$/.test(skillId)) {
      return JSON.stringify({
        error: "Invalid skill_id: must contain only letters, numbers, hyphens, and underscores.",
      });
    }

    if (this.isSkillEnabled && !this.isSkillEnabled(skillId)) {
      return JSON.stringify({
        error: `Skill "${skillId}" is not enabled. Use skill_setup to enable it first.`,
      });
    }

    if (!this.blobStore) {
      return JSON.stringify({
        error:
          "Blob store not configured. Cannot load skill zip packages.",
      });
    }

    // Inject credentials before loading (skills may need env vars)
    await this.ensureCredentialsInjected(identifier);

    try {
      // 1. Check if zip exists
      const hasZip = await this.blobStore.hasSkillZip(skillId);
      if (!hasZip) {
        return JSON.stringify({
          error: `No skill.zip found for skill "${skillId}". ` +
            "Upload a zip to {skillId}/skill.zip in the skills blob container.",
        });
      }

      // 2. Download zip from Blob Storage
      const zipBuffer = await this.blobStore.downloadSkillZip(skillId);
      const base64Zip = zipBuffer.toString("base64");

      // 3. Write base64 to sandbox
      await this.client.fileWrite(
        { filename: "_skill_load.b64", content: base64Zip },
        identifier,
      );

      // 4. Decode, unzip, clean up, list files
      const unzipCmd = [
        `base64 -d /mnt/data/_skill_load.b64 > /mnt/data/${skillId}.zip`,
        `mkdir -p /mnt/data/${skillId}`,
        `unzip -o /mnt/data/${skillId}.zip -d /mnt/data/${skillId}`,
        `rm -f /mnt/data/_skill_load.b64 /mnt/data/${skillId}.zip`,
        `find /mnt/data/${skillId} -type f | sort`,
      ].join(" && ");

      const unzipResult = await this.client.exec(
        { command: unzipCmd, timeout: 30 },
        identifier,
      );

      if (unzipResult.exitCode !== 0) {
        return JSON.stringify({
          error: `Failed to extract skill zip: ${unzipResult.stderr || "unknown error"}`,
          exitCode: unzipResult.exitCode,
        });
      }

      // 5. Read SKILL.md from sandbox (if it exists in the zip)
      let skillMdContent: string | undefined;
      try {
        const readResult = await this.client.fileRead(
          { filename: `${skillId}/SKILL.md` },
          identifier,
        );
        skillMdContent = readResult.content;
      } catch {
        // SKILL.md may not exist in the zip — that's fine
      }

      // Parse file listing from stdout
      const files = unzipResult.stdout
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => f.replace(/^\/mnt\/data\//, ""));

      return JSON.stringify({
        success: true,
        skillId,
        filesExtracted: files,
        skillMd: skillMdContent ?? null,
        sessionId: identifier,
        hint: skillMdContent
          ? "Read the SKILL.md content above for usage instructions, then use sandbox_exec to run the skill."
          : `No SKILL.md found in zip. Files extracted to /mnt/data/${skillId}/. Use sandbox_exec to explore and run them.`,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load skill zip";
      return JSON.stringify({ error: msg });
    }
  }

  // --------------------------------------------------------------------------
  // Credential Injection
  // --------------------------------------------------------------------------

  /**
   * Make the user's credentials available to sandbox commands.
   * Runs once per handler instance (lazy init on first exec call).
   *
   * Credentials whose skill declares `hosts` + `header` are injected by the
   * egress proxy when the backend supports it (ACA Sandboxes): the secret
   * never enters the sandbox, and the env var holds a placeholder so scripts
   * that send `Authorization: Bearer $TOKEN` still work (the proxy overwrites
   * the header). Everything else is set as env vars, mirroring OpenAI's
   * domain_secrets. Both are rewritten every turn, even when empty, because
   * ACA Sandboxes keep their disk and policy between turns and a revoked
   * secret must not linger.
   */
  private async ensureCredentialsInjected(identifier: string): Promise<void> {
    if (this.credentialsInjected) return;

    const vars: Record<string, string> = {};
    const injected: EgressCredential[] = [];
    for (const [key, value] of Object.entries(this.credentials)) {
      const safeKey = key.replace(/[^A-Za-z0-9_]/g, "_");
      const binding = this.credentialBindings[key];
      if (this.client.capabilities.egressCredentials && binding?.header) {
        injected.push({
          key: safeKey,
          hosts: binding.hosts,
          header: binding.header,
          value: formatCredential(binding, value),
        });
        vars[safeKey] = EGRESS_INJECTED_PLACEHOLDER;
      } else {
        vars[safeKey] = value;
      }
    }

    try {
      if (this.client.capabilities.egressCredentials) {
        await this.client.setEgressCredentials(injected, identifier);
      }
      await this.client.setEnv(vars, identifier);
    } catch (err: unknown) {
      // Non-fatal: credentials may not inject, but exec should still work.
      const msg = err instanceof Error ? err.message : "unknown error";
      console.warn(`[sandbox] Failed to inject credentials: ${msg}`);
    }

    this.credentialsInjected = true;
  }
}
