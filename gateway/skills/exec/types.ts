/**
 * AgentForEach Skills Layer — Exec Types
 *
 * Type definitions for the shell execution tool.
 */

// ============================================================================
// Exec Arguments (from LLM tool call)
// ============================================================================

/** Arguments for the `exec` tool. */
export interface ExecArgs {
  /** Command as array: [binary, ...args]. e.g., ["curl", "-s", "https://api.example.com"]. */
  command: string[];
  /** Timeout in seconds (default: 30, max: 120). */
  timeout?: number;
}

// ============================================================================
// Exec Result (returned to LLM)
// ============================================================================

/** Result of a shell command execution. */
export interface ExecResult {
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** Process exit code. */
  exitCode: number;
  /** Whether output was truncated to fit within limits. */
  truncated: boolean;
  /** Wall-clock execution time in milliseconds. */
  durationMs: number;
}

// ============================================================================
// Exec Configuration
// ============================================================================

/** Configuration for the exec tool handler. */
export interface ExecConfig {
  /** Maximum allowed timeout in seconds. */
  maxTimeoutSec: number;
  /** Default timeout in seconds when not specified. */
  defaultTimeoutSec: number;
  /** Maximum output characters returned to LLM. */
  maxOutputChars: number;
}

/** Default exec configuration. */
export const DEFAULT_EXEC_CONFIG: ExecConfig = {
  maxTimeoutSec: 120,
  defaultTimeoutSec: 30,
  maxOutputChars: 50_000,
};
