/**
 * AgentForEach Skills Layer — Exec Allowlist
 *
 * Defines which binaries are safe to execute in-process via execFile
 * on the Azure Functions Linux host.
 *
 * Only allowlisted binaries can be invoked. This is the primary security
 * boundary — combined with execFile (no shell, no injection) and array
 * command format, this prevents arbitrary code execution.
 */

// ============================================================================
// Allowed Binaries
// ============================================================================

/**
 * Binaries permitted for in-process execution.
 *
 * These are commonly available on Azure Functions Linux hosts and are
 * safe for typical skill tasks (API calls, data processing, formatting).
 */
export const ALLOWED_BINS = new Set([
  // HTTP / API
  "curl",

  // JSON / Data Processing
  "jq",

  // Text Processing
  "head",
  "tail",
  "sort",
  "uniq",
  "wc",
  "tr",
  "cut",
  "grep",
  "sed",
  "awk",

  // Encoding / Hashing
  "base64",
  "sha256sum",

  // Formatting / Utility
  "date",
  "printf",
  "echo",
]);

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that a binary is in the allowlist.
 *
 * @param bin - Binary name (first element of command array).
 * @returns Error message string if invalid, or null if allowed.
 */
export function validateBinary(bin: string): string | null {
  if (!bin || typeof bin !== "string") {
    return "Empty command: binary name is required as first element";
  }

  // Strip any path prefix — only check the basename
  const basename = bin.split("/").pop() ?? bin;

  if (!ALLOWED_BINS.has(basename)) {
    const available = Array.from(ALLOWED_BINS).sort().join(", ");
    return `Binary "${basename}" is not in the allowlist. Available: ${available}`;
  }

  return null; // valid
}
