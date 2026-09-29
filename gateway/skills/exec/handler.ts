/**
 * AgentForEach Skills Layer — Exec Tool Handler
 *
 * Executes shell commands using child_process.execFile (no shell, no injection).
 *
 * Security model:
 *   - Command is an array: [binary, ...args] — no shell parsing
 *   - Binary validated against strict allowlist before execution
 *   - User credentials injected as environment variables (never in args)
 *   - Output truncated to prevent LLM context overflow
 *   - Timeout enforced (default 30s, max 120s)
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { validateBinary } from "./allowlist.js";
import { DEFAULT_EXEC_CONFIG, type ExecArgs, type ExecConfig, type ExecResult } from "./types.js";

const execFileAsync = promisify(execFileCb);

// ============================================================================
// Exec Tool Handler
// ============================================================================

export class ExecToolHandler {
  private credentials: Record<string, string>;
  private config: ExecConfig;

  /**
   * @param credentials - User's API keys/tokens to inject as env vars.
   * @param config - Exec configuration (timeouts, output limits).
   */
  constructor(
    credentials: Record<string, string>,
    config: ExecConfig = DEFAULT_EXEC_CONFIG,
  ) {
    this.credentials = credentials;
    this.config = config;
  }

  /**
   * Execute a shell command.
   *
   * @param args - Parsed arguments from the LLM tool call.
   * @returns JSON string with ExecResult for the LLM.
   */
  async handle(args: ExecArgs): Promise<string> {
    const startMs = Date.now();

    // Validate command
    if (!args.command || !Array.isArray(args.command) || args.command.length === 0) {
      return JSON.stringify({
        error: "Invalid command: must be a non-empty array of strings. Example: [\"curl\", \"-s\", \"https://example.com\"]",
      });
    }

    const [binary, ...restArgs] = args.command;

    // Validate binary against allowlist
    const validationError = validateBinary(binary);
    if (validationError) {
      return JSON.stringify({ error: validationError });
    }

    // Resolve timeout
    const timeoutSec = Math.min(
      Math.max(1, args.timeout ?? this.config.defaultTimeoutSec),
      this.config.maxTimeoutSec,
    );

    // Build environment: inherit process env + user credentials
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.credentials,
    };

    try {
      const { stdout, stderr } = await execFileAsync(binary, restArgs, {
        timeout: timeoutSec * 1000,
        maxBuffer: this.config.maxOutputChars * 2, // bytes > chars, give headroom
        env,
      });

      const result = this.buildResult(stdout, stderr, 0, startMs);
      return JSON.stringify(result);
    } catch (err: unknown) {
      // execFile errors include exit code and partial output
      const execErr = err as {
        code?: string | number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };

      if (execErr.killed || execErr.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        const result = this.buildResult(
          execErr.stdout ?? "",
          execErr.stderr ?? `Command timed out after ${timeoutSec}s or exceeded output buffer`,
          124, // timeout exit code convention
          startMs,
        );
        return JSON.stringify(result);
      }

      const exitCode = typeof execErr.code === "number" ? execErr.code : 1;
      const result = this.buildResult(
        execErr.stdout ?? "",
        execErr.stderr ?? (err instanceof Error ? err.message : "Unknown error"),
        exitCode,
        startMs,
      );
      return JSON.stringify(result);
    }
  }

  /** Build ExecResult with output truncation. */
  private buildResult(
    stdout: string,
    stderr: string,
    exitCode: number,
    startMs: number,
  ): ExecResult {
    const maxChars = this.config.maxOutputChars;
    let truncated = false;

    if (stdout.length > maxChars) {
      stdout = stdout.slice(0, maxChars);
      truncated = true;
    }
    if (stderr.length > maxChars) {
      stderr = stderr.slice(0, maxChars);
      truncated = true;
    }

    return {
      stdout,
      stderr,
      exitCode,
      truncated,
      durationMs: Date.now() - startMs,
    };
  }
}
