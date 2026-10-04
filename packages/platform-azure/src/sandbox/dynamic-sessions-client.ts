/**
 * AgentForEach Skills Layer — ACA Dynamic Sessions Client (fallback backend)
 *
 * REST client for Azure Container Apps Dynamic Sessions (Code Interpreter).
 * The primary backend is ACA Sandboxes (aca-sandboxes-client.ts); see
 * docs/Sandbox-Migration.md for why.
 * Provides sandboxed shell execution + file operations, modeled after
 * OpenAI's shell tool pattern.
 *
 * Authentication: Entra ID tokens for `https://dynamicsessions.io`
 *   (see ../identity.ts).
 *
 * Session Routing:
 *   ACA routes requests to the correct session via the `identifier` query
 *   parameter. This client maps the user (or user and conversation) to a stable
 *   session identifier per conversation.
 *
 * Endpoint pattern:
 *   POST {poolManagementEndpoint}/code/execute?api-version=2024-02-02-preview&identifier={id}
 *   POST {poolManagementEndpoint}/files/upload?api-version=2024-02-02-preview&identifier={id}
 *   GET  {poolManagementEndpoint}/files/content/{name}?api-version=2024-02-02-preview&identifier={id}
 *   GET  {poolManagementEndpoint}/files?api-version=2024-02-02-preview&identifier={id}
 */

import type {
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileWriteArgs,
  SandboxFileWriteResult,
  SandboxFileReadArgs,
  SandboxFileReadResult,
  SandboxFileReadBinaryResult,
  SandboxFileInfo,
  EgressCredential,
  SandboxBackend,
  SandboxCapabilities,
} from "@agentforeach/platform";
import { createHash } from "node:crypto";
import { encodeSandboxIdentifier, readBodyText, SandboxUnsupportedError } from "@agentforeach/platform";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  exportTooLargeError,
  safeRelativePath,
  sandboxReadLimits,
  truncate,
} from "@agentforeach/platform/sandbox/shared";
import { createDefaultTokenProvider, type TokenProvider } from "../identity.js";
import type {
  AcaExecuteRequest,
  AcaExecuteResponse,
  AcaFilesResponse,
  CustomExecRequest,
  CustomExecResponse,
  CustomFileWriteResponse,
  CustomFileReadResponse,
  CustomFileListResponse,
  DynamicSessionsClientConfig,
} from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const API_VERSION = "2024-02-02-preview";

/** Largest response read into memory, unless a call sets its own limit. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

class ResponseTooLargeError extends Error {}

// ============================================================================
// DynamicSessionsClient
// ============================================================================

export class DynamicSessionsClient implements SandboxBackend {
  /** Pooled sessions: no browser, no egress proxy, nothing kept past the cooldown. */
  readonly capabilities: SandboxCapabilities = { browser: false, egressCredentials: false, persistence: "none" };
  private readonly config: DynamicSessionsClientConfig;
  private readonly tokenProvider: TokenProvider;

  constructor(config: DynamicSessionsClientConfig, tokenProvider?: TokenProvider) {
    this.config = config;
    this.tokenProvider = tokenProvider ?? createDefaultTokenProvider();
  }

  // --------------------------------------------------------------------------
  // Shell execution
  // --------------------------------------------------------------------------

  /**
   * Execute a shell command in the sandbox session.
   *
   * - PythonLTS: Wraps the command in a Python subprocess call (ACA only
   *   accepts Python code via code/execute).
   * - CustomContainer: Sends a direct HTTP POST to /exec on the container.
   */
  async exec(
    args: SandboxExecArgs,
    sessionIdentifier: string,
  ): Promise<SandboxExecResult> {
    if (this.config.containerType === "CustomContainer") {
      return this.execCustomContainer(args, sessionIdentifier);
    }
    return this.execPythonLTS(args, sessionIdentifier);
  }

  /** CustomContainer exec — direct HTTP to the sandbox server's /exec endpoint. */
  private async execCustomContainer(
    args: SandboxExecArgs,
    sessionIdentifier: string,
  ): Promise<SandboxExecResult> {
    const timeout = Math.min(
      args.timeout ?? this.config.defaultTimeoutSec,
      this.config.maxTimeoutSec,
    );

    const started = Date.now();

    const body: CustomExecRequest = {
      command: args.command,
      timeout,
    };

    const response = await this.request<CustomExecResponse>(
      "exec",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );

    const durationMs = Date.now() - started;

    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      exitCode: response.exitCode ?? -1,
      timedOut: response.timedOut ?? false,
      truncated: response.truncated ?? false,
      durationMs,
      sessionId: sessionIdentifier,
    };
  }

  /** PythonLTS exec — wraps bash command in Python subprocess wrapper. */
  private async execPythonLTS(
    args: SandboxExecArgs,
    sessionIdentifier: string,
  ): Promise<SandboxExecResult> {
    const timeout = Math.min(
      args.timeout ?? this.config.defaultTimeoutSec,
      this.config.maxTimeoutSec,
    );

    // Wrap bash command in Python subprocess to capture stdout/stderr/exitCode.
    // This runs inside the ACA Code Interpreter's Python runtime.
    const pythonCode = buildShellWrapper(args.command, timeout, this.config.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);

    const started = Date.now();

    const body: AcaExecuteRequest = {
      properties: {
        codeInputType: "inline",
        executionType: "synchronous",
        code: pythonCode,
        timeoutInSeconds: timeout + 5, // Margin for subprocess overhead
      },
    };

    const response = await this.request<AcaExecuteResponse>(
      "code/execute",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );

    const durationMs = Date.now() - started;

    // Parse the structured result from Python wrapper
    return parseExecResult(response, sessionIdentifier, durationMs);
  }

  // --------------------------------------------------------------------------
  // File operations
  // --------------------------------------------------------------------------

  /** Write a file to /mnt/data/ in the sandbox. */
  async fileWrite(
    args: SandboxFileWriteArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileWriteResult> {
    if (this.config.containerType === "CustomContainer") {
      return this.fileWriteCustomContainer(args, sessionIdentifier);
    }
    return this.fileWritePythonLTS(args, sessionIdentifier);
  }

  /** CustomContainer file write — POST /files/write */
  private async fileWriteCustomContainer(
    args: SandboxFileWriteArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileWriteResult> {
    const response = await this.request<CustomFileWriteResponse>(
      "files/write",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify({ filename: args.filename, content: args.content }),
        headers: { "Content-Type": "application/json" },
      },
    );

    return {
      success: response.success,
      filename: response.filename,
      sizeBytes: response.sizeBytes,
      sessionId: sessionIdentifier,
    };
  }

  /** PythonLTS file write — via Python code execution */
  private async fileWritePythonLTS(
    args: SandboxFileWriteArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileWriteResult> {
    // Upload via Python code execution (write the file content)
    const pythonCode = buildFileWriteWrapper(args.filename, args.content);

    const body: AcaExecuteRequest = {
      properties: {
        codeInputType: "inline",
        executionType: "synchronous",
        code: pythonCode,
        timeoutInSeconds: 30,
      },
    };

    const response = await this.request<AcaExecuteResponse>(
      "code/execute",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );

    const sizeBytes = Buffer.byteLength(args.content, "utf-8");
    const success = response.properties.status === "Success";

    return {
      success,
      filename: args.filename,
      sizeBytes,
      sessionId: sessionIdentifier,
    };
  }

  /** Read a file from /mnt/data/ in the sandbox. */
  async fileRead(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadResult> {
    try {
      if (this.config.containerType === "CustomContainer") {
        return await this.fileReadCustomContainer(args, sessionIdentifier);
      }
      return await this.fileReadPythonLTS(args, sessionIdentifier);
    } catch (err) {
      // The custom container returns the whole file; past the response cap
      // it can't be truncated here, so say how to read part of it.
      if (err instanceof ResponseTooLargeError) {
        throw new Error(
          `${args.filename} is too large to read whole. Read part of it with sandbox_exec ` +
            `(for example: head -c 100000 "/mnt/data/${safeRelativePath(args.filename)}").`,
        );
      }
      throw err;
    }
  }

  /** CustomContainer file read — POST /files/read */
  private async fileReadCustomContainer(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadResult> {
    const response = await this.request<CustomFileReadResponse>(
      "files/read",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify({ filename: args.filename }),
        headers: { "Content-Type": "application/json" },
      },
    );

    const { text, truncated } = truncate(response.content, sandboxReadLimits(this.config).maxChars);
    return {
      content: text,
      filename: response.filename,
      sizeBytes: response.sizeBytes,
      sessionId: sessionIdentifier,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** PythonLTS file read — via Python code execution */
  private async fileReadPythonLTS(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadResult> {
    // Read via Python code execution
    const { maxChars } = sandboxReadLimits(this.config);
    const pythonCode = buildFileReadWrapper(args.filename, maxChars + 1);

    const body: AcaExecuteRequest = {
      properties: {
        codeInputType: "inline",
        executionType: "synchronous",
        code: pythonCode,
        timeoutInSeconds: 30,
      },
    };

    const response = await this.request<AcaExecuteResponse>(
      "code/execute",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );

    const { text, truncated } = truncate(response.properties.stdout || "", maxChars);
    return {
      content: text,
      filename: args.filename,
      sizeBytes: Buffer.byteLength(text, "utf-8"),
      sessionId: sessionIdentifier,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /** List files in /mnt/data/ in the sandbox. */
  async fileList(sessionIdentifier: string): Promise<SandboxFileInfo[]> {
    if (this.config.containerType === "CustomContainer") {
      return this.fileListCustomContainer(sessionIdentifier);
    }
    return this.fileListPythonLTS(sessionIdentifier);
  }

  /** CustomContainer file list — GET /files */
  private async fileListCustomContainer(
    sessionIdentifier: string,
  ): Promise<SandboxFileInfo[]> {
    const response = await this.request<CustomFileListResponse>(
      "files",
      sessionIdentifier,
      { method: "GET" },
    );

    return (response.files ?? []).map((f) => ({
      filename: f.filename,
      size: f.size,
      lastModified: f.lastModified,
    }));
  }

  /** PythonLTS file list — via ACA files API */
  private async fileListPythonLTS(
    sessionIdentifier: string,
  ): Promise<SandboxFileInfo[]> {
    const response = await this.request<AcaFilesResponse>(
      "files",
      sessionIdentifier,
      { method: "GET" },
    );

    return (response.value ?? []).map((f) => ({
      filename: f.properties.filename,
      size: f.properties.size,
      lastModified: f.properties.lastModifiedTime,
    }));
  }

  // --------------------------------------------------------------------------
  // Binary file read (for export)
  // --------------------------------------------------------------------------

  /**
   * Read a file from the sandbox as base64-encoded bytes.
   *
   * Used by sandbox_file_export to read binary files (images, PDFs, zips)
   * without UTF-8 corruption. The content is base64-encoded in the container
   * and returned as a string for upload to Blob Storage.
   *
   * - CustomContainer: POSTs to /files/read with encoding=base64.
   * - PythonLTS: Reads the file via Python and base64-encodes it.
   */
  async fileReadBinary(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadBinaryResult> {
    const { maxExportBytes } = sandboxReadLimits(this.config);
    try {
      const result =
        this.config.containerType === "CustomContainer"
          ? await this.fileReadBinaryCustomContainer(args, sessionIdentifier)
          : await this.fileReadBinaryPythonLTS(args, sessionIdentifier);
      // The response cap allows for JSON overhead; hold the file to the limit.
      if (Math.floor((result.contentBase64.length * 3) / 4) > maxExportBytes) {
        throw exportTooLargeError(maxExportBytes);
      }
      return result;
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        throw exportTooLargeError(sandboxReadLimits(this.config).maxExportBytes);
      }
      throw err;
    }
  }

  /** CustomContainer binary read — use exec to base64-encode file content */
  private async fileReadBinaryCustomContainer(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadBinaryResult> {
    const safeFilename = sanitizeFilename(args.filename);

    // Use exec to read and base64-encode the file.
    // This works with any container version (doesn't require server.mjs changes).
    // base64 command is available on Debian 12 via coreutils.
    const response = await this.request<CustomExecResponse>(
      "exec",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify({
          command: `base64 -w0 "/mnt/data/${safeFilename}"`,
          timeout: 60,
        }),
        headers: { "Content-Type": "application/json" },
      },
      this.exportResponseLimit(),
    );

    if (response.exitCode !== 0) {
      throw new Error(
        response.stderr?.trim() || `Failed to read file: ${args.filename}`,
      );
    }

    const b64 = (response.stdout || "").trim();
    const sizeBytes = Math.floor(b64.length * 3 / 4); // approximate

    return {
      contentBase64: b64,
      filename: args.filename,
      sizeBytes,
      sessionId: sessionIdentifier,
    };
  }

  /** PythonLTS binary read — read and base64-encode via Python */
  private async fileReadBinaryPythonLTS(
    args: SandboxFileReadArgs,
    sessionIdentifier: string,
  ): Promise<SandboxFileReadBinaryResult> {
    const safeFilename = sanitizeFilename(args.filename);
    const code = `
import base64, os
filepath = os.path.join('/mnt/data', '${safeFilename}')
with open(filepath, 'rb') as f:
    data = f.read()
print(base64.b64encode(data).decode('ascii'), end='')
`.trim();

    const body: AcaExecuteRequest = {
      properties: {
        codeInputType: "inline",
        executionType: "synchronous",
        code,
        timeoutInSeconds: 60,
      },
    };

    const response = await this.request<AcaExecuteResponse>(
      "code/execute",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
      this.exportResponseLimit(),
    );

    const b64 = response.properties.stdout || "";
    const sizeBytes = Math.floor(b64.length * 3 / 4); // approximate original size

    return {
      contentBase64: b64,
      filename: args.filename,
      sizeBytes,
      sessionId: sessionIdentifier,
    };
  }

  // --------------------------------------------------------------------------
  // Session management helpers
  // --------------------------------------------------------------------------

  /**
   * Execute raw Python code directly in the ACA session's Python process.
   *
   * - PythonLTS: Sends Python code to the code/execute endpoint. Changes to
   *   the session-level Python state (os.environ, variables, imports) persist.
   * - CustomContainer: Runs `python3 -c '<code>'` via the /exec endpoint.
   */
  async execPython(
    code: string,
    sessionIdentifier: string,
    timeoutSec = 30,
  ): Promise<AcaExecuteResponse> {
    if (this.config.containerType === "CustomContainer") {
      // Run Python code via the sandbox server's /exec endpoint
      const escaped = code.replace(/'/g, "'\"'\"'");
      const response = await this.request<CustomExecResponse>(
        "exec",
        sessionIdentifier,
        {
          method: "POST",
          body: JSON.stringify({
            command: `python3 -c '${escaped}'`,
            timeout: timeoutSec,
          }),
          headers: { "Content-Type": "application/json" },
        },
      );

      // Map CustomExecResponse to AcaExecuteResponse shape for caller compat
      return {
        properties: {
          status: response.exitCode === 0 ? "Success" : "Failure",
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
          executionTimeInMilliseconds: 0,
        },
      };
    }

    const body: AcaExecuteRequest = {
      properties: {
        codeInputType: "inline",
        executionType: "synchronous",
        code,
        timeoutInSeconds: timeoutSec,
      },
    };

    return this.request<AcaExecuteResponse>(
      "code/execute",
      sessionIdentifier,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  /**
   * Set environment variables in the sandbox session.
   *
   * - CustomContainer: Calls the /env endpoint on the sandbox server.
   * - PythonLTS: Runs os.environ assignments via execPython.
   */
  async setEnv(
    vars: Record<string, string>,
    sessionIdentifier: string,
  ): Promise<void> {
    // Sessions are destroyed after cooldown, so there is nothing stale to clear.
    if (Object.keys(vars).length === 0) return;

    if (this.config.containerType === "CustomContainer") {
      await this.request(
        "env",
        sessionIdentifier,
        {
          method: "POST",
          body: JSON.stringify({ vars }),
          headers: { "Content-Type": "application/json" },
        },
      );
      return;
    }

    // PythonLTS: set os.environ via Python code
    const lines = Object.entries(vars).map(([key, value]) => {
      const safeKey = key.replace(/[^A-Za-z0-9_]/g, "_");
      const b64Value = Buffer.from(value, "utf-8").toString("base64");
      return `os.environ['${safeKey}'] = base64.b64decode('${b64Value}').decode('utf-8')`;
    });

    const code = `import os, base64\n${lines.join("\n")}\nprint('OK')`;
    await this.execPython(code, sessionIdentifier);
  }

  /**
   * The session identifier: one session per user ("userId" strategy) or per
   * conversation ("sessionId"). A hash of the JSON identifier: unambiguous
   * (a user id containing ":" can't reach another user's session), and
   * within the characters and the 4 to 128 length the pool accepts.
   */
  resolveIdentifier(userId: string, sessionId?: string): string {
    const identifier = encodeSandboxIdentifier(userId, this.config.identifierStrategy === "sessionId" ? sessionId : undefined);
    return `afe-${createHash("sha256").update(identifier).digest("hex")}`;
  }

  /** Check if sandbox is enabled and configured. */
  isReady(): boolean {
    return this.config.enabled && !!this.config.poolManagementEndpoint;
  }

  /** No egress proxy: callers pass credentials with setEnv instead. */
  async setEgressCredentials(_credentials: EgressCredential[], _sessionIdentifier: string): Promise<void> {
    throw new SandboxUnsupportedError("setEgressCredentials", "aca-sessions");
  }

  /** Sessions are destroyed after their cooldown, so there is nothing to delete. */
  async deleteUserSandboxes(_userId: string): Promise<number> {
    return 0;
  }

  // --------------------------------------------------------------------------
  // HTTP plumbing
  // --------------------------------------------------------------------------

  private async request<T>(
    path: string,
    identifier: string,
    init: RequestInit,
    maxResponseBytes = MAX_RESPONSE_BYTES,
  ): Promise<T> {
    const token = await this.tokenProvider.getToken();

    const baseUrl = this.config.poolManagementEndpoint.replace(/\/$/, "");
    const url = `${baseUrl}/${path}?api-version=${API_VERSION}&identifier=${encodeURIComponent(identifier)}`;

    const resp = await fetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(
          Object.entries(init.headers ?? {}).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        ),
        Authorization: `Bearer ${token}`,
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "(empty)");
      throw new Error(
        `ACA sandbox request failed: ${resp.status} ${resp.statusText} — ${body}`,
      );
    }

    const { text, truncated } = await readBodyText(resp, maxResponseBytes);
    if (truncated) {
      throw new ResponseTooLargeError(`ACA sandbox response is larger than ${maxResponseBytes} bytes`);
    }
    return JSON.parse(text) as T;
  }

  /** Read limit for a response carrying a base64 file of up to maxExportBytes. */
  private exportResponseLimit(): number {
    return Math.ceil(sandboxReadLimits(this.config).maxExportBytes / 3) * 4 + 1024 * 1024;
  }
}

// ============================================================================
// Python code wrappers
// ============================================================================

/**
 * Build Python code that runs a shell command via subprocess and outputs
 * structured JSON with stdout, stderr, exit code, and timeout status.
 * This mirrors OpenAI's shell_call_output shape.
 */
function buildShellWrapper(command: string, timeoutSec: number, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS): string {
  // Escape the command for safe embedding in a Python single-quoted string.
  // Order matters: backslashes first, then quotes, then control characters.
  const escaped = command
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\0/g, "\\0");

  return `
import subprocess, json, sys

try:
    result = subprocess.run(
        ['bash', '-c', '${escaped}'],
        capture_output=True,
        text=True,
        timeout=${timeoutSec},
        cwd='/mnt/data'
    )
    output = {
        'stdout': result.stdout[:${maxOutputChars}],
        'stderr': result.stderr[:${maxOutputChars}],
        'exitCode': result.returncode,
        'timedOut': False,
        'truncated': len(result.stdout) > ${maxOutputChars} or len(result.stderr) > ${maxOutputChars}
    }
except subprocess.TimeoutExpired as e:
    output = {
        'stdout': (e.stdout or '')[:${maxOutputChars}] if e.stdout else '',
        'stderr': (e.stderr or '')[:${maxOutputChars}] if e.stderr else '',
        'exitCode': -1,
        'timedOut': True,
        'truncated': False
    }
except Exception as e:
    output = {
        'stdout': '',
        'stderr': str(e)[:${maxOutputChars}],
        'exitCode': -1,
        'timedOut': False,
        'truncated': False
    }

print(json.dumps(output))
`.trim();
}

/** Build Python code that writes content to /mnt/data/<filename>. */
function buildFileWriteWrapper(filename: string, content: string): string {
  // Base64-encode the content to avoid escaping issues
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  const safeFilename = sanitizeFilename(filename);

  return `
import base64, os

content = base64.b64decode('${b64}').decode('utf-8')
filepath = os.path.join('/mnt/data', '${safeFilename}')
os.makedirs(os.path.dirname(filepath) if os.path.dirname(filepath) != '/mnt/data' else '/mnt/data', exist_ok=True)

with open(filepath, 'w') as f:
    f.write(content)

print(f'OK {len(content)} bytes')
`.trim();
}

/**
 * Sanitize a filename for safe embedding in Python and prevent path traversal
 * (keeps files within /mnt/data; see safeRelativePath).
 */
function sanitizeFilename(filename: string): string {
  return safeRelativePath(filename).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Build Python code that reads content from /mnt/data/<filename>. */
function buildFileReadWrapper(filename: string, maxChars: number): string {
  const safeFilename = sanitizeFilename(filename);

  return `
import os

filepath = os.path.join('/mnt/data', '${safeFilename}')

with open(filepath, 'r') as f:
    content = f.read(${maxChars})

print(content, end='')
`.trim();
}

// ============================================================================
// Result parsing
// ============================================================================

/** Parse ACA execution response into our SandboxExecResult shape. */
function parseExecResult(
  response: AcaExecuteResponse,
  sessionId: string,
  durationMs: number,
): SandboxExecResult {
  const { stdout, stderr, status, executionTimeInMilliseconds } =
    response.properties;

  // Attempt to parse structured JSON from our Python wrapper
  try {
    const parsed = JSON.parse(stdout) as {
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut: boolean;
      truncated: boolean;
    };
    return {
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      exitCode: parsed.exitCode,
      timedOut: parsed.timedOut,
      truncated: parsed.truncated,
      durationMs: executionTimeInMilliseconds ?? durationMs,
      sessionId,
    };
  } catch {
    // Fallback: couldn't parse structured output (wrapper itself crashed)
    return {
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: status === "Success" ? 0 : 1,
      timedOut: status === "Timeout",
      truncated: false,
      durationMs: executionTimeInMilliseconds ?? durationMs,
      sessionId,
    };
  }
}
