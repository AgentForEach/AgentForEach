/**
 * AgentForEach MCP Layer — Public API
 *
 * Barrel exports for the Model Context Protocol integration.
 *
 * Provides:
 *   - Type definitions for MCP config and tools
 *   - Config loader for agentforeach.json "mcp" section
 *   - McpManager (connection management + tool discovery)
 *   - Tool handler (definitions + call routing for the runner)
 *
 * Usage:
 * ```ts
 * import {
 *   loadMcpConfig,
 *   isMcpEnabled,
 *   McpManager,
 *   getMcpToolDefinitions,
 *   isMcpTool,
 *   handleMcpToolCall,
 * } from "./mcp/index.js";
 *
 * const config = loadMcpConfig();
 * if (config.enabled) {
 *   const manager = new McpManager(config.servers);
 *   await manager.initialize();
 *   const tools = getMcpToolDefinitions(manager);
 *   // ... register tools in the runner
 * }
 * ```
 */

// -- Types --
export type {
  McpJsonConfig,
  McpServerJsonConfig,
  McpConfig,
  McpServerConfig,
  McpToolInfo,
  McpToolCallResult,
  McpResourceInfo,
  McpResourceContent,
  McpPromptInfo,
  McpResolvedPrompt,
  McpServerInfo,
} from "./types.js";

// -- Config --
export { loadMcpConfig, isMcpEnabled, resetMcpConfig } from "./config.js";

// -- Client --
export { McpManager } from "./client.js";

// -- Handler --
export {
  getMcpToolDefinitions,
  isMcpTool,
  handleMcpToolCall,
  getMcpServerContext,
} from "./handler.js";
