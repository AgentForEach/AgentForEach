/**
 * AgentForEach Skills Layer — Public API
 *
 * Barrel exports for the prompt-based skills subsystem.
 *
 * Provides:
 *   - Type definitions for skills, credentials, manifests
 *   - Config loader for agentforeach.json "skills" section
 *   - User skill store (Cosmos DB persistence)
 *   - Blob store (Azure Blob Storage for SKILL.md files)
 *   - Exec module (legacy shell execution with allowlist)
 *   - Per-user skill resolution
 *   - Tool handler (skill_list, skill_setup, skill_read, http_fetch)
 *
 * Usage:
 * ```ts
 * import {
 *   loadSkillsConfig,
 *   UserSkillStore,
 *   SkillBlobStore,
 *   resolveUserSkills,
 *   SkillToolHandler,
 *   getSkillToolDefinitions,
 * } from "./skills/index.js";
 *
 * const config = loadSkillsConfig();
 * if (config.enabled) {
 *   const store = new UserSkillStore(db, config.containerId);
 *   const blobStore = new SkillBlobStore(config.storageConnectionString, config.storageContainerName);
 *   const resolved = await resolveUserSkills(blobStore, store, userId);
 *   const handler = new SkillToolHandler(store, blobStore, resolved.statuses, resolved.userCredentials);
 * }
 * ```
 */

// -- Types --
export type {
  SkillFrontmatter,
  CredentialSpec,
  SkillManifest,
  UserSkillConfig,
  SkillStatus,
  SkillAuditEntry,
  SkillsJsonConfig,
  SkillsConfig,
} from "./types.js";

// -- Config --
export { loadSkillsConfig, isSkillsEnabled, resetSkillsConfig } from "./config.js";

// -- Store --
export { UserSkillStore } from "./store.js";

// -- Blob Store --
export { SkillBlobStore } from "./blob-store.js";

// -- Loader --
export { parseSkillFrontmatter, loadSkillMd } from "./loader.js";

// -- Exec --
export { ExecToolHandler, ALLOWED_BINS, validateBinary } from "./exec/index.js";
export type { ExecArgs, ExecResult, ExecConfig } from "./exec/index.js";

// -- Registry --
export {
  type ResolvedSkills,
  resolveUserSkills,
} from "./registry.js";

// -- Handler --
export {
  SkillToolHandler,
  getSkillToolDefinitions,
  isSkillTool,
  SKILL_LIST_TOOL_NAME,
  SKILL_SETUP_TOOL_NAME,
  SKILL_READ_TOOL_NAME,
  HTTP_FETCH_TOOL_NAME,
} from "./handler.js";

// -- Sandbox (ACA Sandboxes, with ACA Dynamic Sessions as fallback) --
export {
  createSandboxBackend,
  AcaSandboxesClient,
  DynamicSessionsClient,
  SandboxToolHandler,
  getSandboxToolDefinitions,
  isSandboxTool,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_FILE_WRITE_TOOL_NAME,
  SANDBOX_FILE_READ_TOOL_NAME,
  SANDBOX_FILE_LIST_TOOL_NAME,
  SANDBOX_FILE_EXPORT_TOOL_NAME,
  SANDBOX_SKILL_LOAD_TOOL_NAME,
  ExportBlobStore,
} from "./sandbox/index.js";
export type {
  SandboxJsonConfig,
  SandboxConfig,
  SandboxBackend,
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileWriteArgs,
  SandboxFileWriteResult,
  SandboxFileReadArgs,
  SandboxFileReadResult,
  SandboxFileReadBinaryResult,
  SandboxFileExportResult,
  SandboxFileInfo,
} from "./sandbox/index.js";

// -- Browser (a real browser inside the user's ACA Sandbox) --
export {
  BrowserToolHandler,
  BROWSER_TOOL_NAME,
  getBrowserToolDefinitions,
  handoffOutcome,
  isBrowserEnabled,
  isBrowserHandoffCall,
  isBrowserTool,
} from "./browser/index.js";
export type { BrowserConfig, BrowserJsonConfig } from "./browser/index.js";
