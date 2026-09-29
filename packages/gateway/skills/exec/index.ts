/**
 * AgentForEach Skills Layer — Exec Module
 *
 * Shell execution tool with allowlisted binaries and array command format.
 */

export { ExecToolHandler } from "./handler.js";
export { ALLOWED_BINS, validateBinary } from "./allowlist.js";
export {
  DEFAULT_EXEC_CONFIG,
  type ExecArgs,
  type ExecResult,
  type ExecConfig,
} from "./types.js";
