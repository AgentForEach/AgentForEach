/**
 * AgentForEach Skills Layer — Sandbox Module
 *
 * Sandboxed shell execution. Modeled after OpenAI's shell tool pattern.
 *
 * Components:
 *   - createSandboxBackend — picks the backend from config
 *   - AcaSandboxesClient   — ACA Sandboxes (primary): suspendable microVM per user
 *   - DynamicSessionsClient — ACA Dynamic Sessions (fallback): pooled, ephemeral
 *     (both from @agentforeach/platform-azure/sandbox, re-exported here)
 *   - SandboxToolHandler  — routes sandbox_exec / file tools from LLM
 *   - getSandboxToolDefinitions — tool schemas registered with the model
 *   - isSandboxTool        — checks if a tool name belongs to sandbox
 *
 * Usage:
 *   ```ts
 *   import { createSandboxBackend, SandboxToolHandler, getSandboxToolDefinitions } from "./sandbox/index.js";
 *
 *   const client = createSandboxBackend(config);
 *   const handler = new SandboxToolHandler(client, credentials, userId, sessionId);
 *   const tools = getSandboxToolDefinitions();
 *   ```
 */

export { AcaSandboxesClient, DynamicSessionsClient } from "@agentforeach/platform-azure/sandbox";
export { createSandboxBackend } from "./factory.js";
export {
  canonicalSandboxProvider,
  getSandboxProviders,
  registerSandboxProvider,
  type SandboxProviderFactory,
} from "./registry.js";
export { containersSandboxOptions, type ContainersSandboxOptions } from "./containers.js";
export {
  SandboxToolHandler,
  getSandboxToolDefinitions,
  isSandboxTool,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_FILE_WRITE_TOOL_NAME,
  SANDBOX_FILE_READ_TOOL_NAME,
  SANDBOX_FILE_LIST_TOOL_NAME,
  SANDBOX_FILE_EXPORT_TOOL_NAME,
  SANDBOX_SKILL_LOAD_TOOL_NAME,
} from "./handler.js";
export { ExportBlobStore } from "./export-store.js";
export type {
  SandboxJsonConfig,
  SandboxConfig,
  SandboxBackend,
  SandboxProvider,
  AcaSandboxesConfig,
  AcaSandboxesJsonConfig,
  ContainersSandboxConfig,
  ContainersSandboxJsonConfig,
  SandboxExecArgs,
  SandboxExecResult,
  SandboxFileWriteArgs,
  SandboxFileWriteResult,
  SandboxFileReadArgs,
  SandboxFileReadResult,
  SandboxFileReadBinaryResult,
  SandboxFileExportResult,
  SandboxFileInfo,
} from "./types.js";
