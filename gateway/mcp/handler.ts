/**
 * AgentForEach MCP Layer — Tool Handler
 *
 * Bridges MCP tool definitions into AgentForEach's native tool system.
 * Converts discovered MCP tools into the domain-level ToolDefinition
 * format used by all AgentForEach subsystems, and handles tool call routing.
 *
 * Also builds MCP server context (instructions, resources, prompts)
 * for injection into the system prompt so the LLM understands each
 * server's purpose and behavioral guidance.
 */

import type { ToolDefinition } from "../memory/types.js";
import type { McpManager } from "./client.js";
import type { McpToolInfo } from "./types.js";

// ============================================================================
// Tool Definition Conversion
// ============================================================================

/**
 * Convert MCP tools to AgentForEach's domain-level ToolDefinition format.
 *
 * These get mapped to provider-level FunctionToolDefinitions in runner.ts
 * alongside memory, cron, prompt, and other native tools.
 *
 * @param mcpManager - The MCP manager with connected servers
 * @returns Tool definitions ready for the AgentForEach tool registration system
 */
export function getMcpToolDefinitions(mcpManager: McpManager): ToolDefinition[] {
  const mcpTools = mcpManager.getAllTools();

  return mcpTools.map((tool) => mcpToolToDefinition(tool));
}

/**
 * Convert a single MCP tool to AgentForEach's ToolDefinition.
 */
function mcpToolToDefinition(tool: McpToolInfo): ToolDefinition {
  const schema = tool.inputSchema;

  return {
    type: "function",
    name: tool.name,
    description: `[MCP:${tool.serverName}] ${tool.description}`,
    parameters: {
      type: "object",
      properties: (schema.properties as Record<string, { type: string; description: string }>) ?? {},
      required: (schema.required as string[]) ?? [],
      additionalProperties: false,
    },
  };
}

// ============================================================================
// Tool Call Routing
// ============================================================================

/**
 * Check if a tool name belongs to an MCP server.
 *
 * @param toolName   - The tool name from a function_call output item
 * @param mcpManager - The MCP manager (may be undefined if MCP is disabled)
 */
export function isMcpTool(toolName: string, mcpManager?: McpManager): boolean {
  return mcpManager?.isMcpTool(toolName) ?? false;
}

/**
 * Handle an MCP tool call from the LLM.
 *
 * Routes the call through the MCP manager to the correct server,
 * and returns the result as a string (matching AgentForEach's tool result format).
 *
 * @param toolName   - Namespaced tool name (e.g. "github_create_issue")
 * @param args       - Tool arguments (already parsed from JSON)
 * @param mcpManager - The MCP manager
 * @param userId     - Optional calling user ID (forwarded to MCP server if forwardAuth is enabled)
 * @returns String result for feeding back to the LLM
 */
export async function handleMcpToolCall(
  toolName: string,
  args: Record<string, unknown>,
  mcpManager: McpManager,
  userId?: string,
  context?: { channelName?: string; channelChatId?: string },
): Promise<string> {
  const result = await mcpManager.callTool(toolName, args, userId, context);

  if (result.isError) {
    return JSON.stringify({
      error: true,
      message: result.content,
    });
  }

  return result.content;
}

// ============================================================================
// MCP Server Context (for system prompt injection)
// ============================================================================

/**
 * Build a context string from all connected MCP servers' metadata.
 *
 * Aggregates instructions, resources, and prompts from each server
 * into a single block suitable for injection into the system prompt.
 * This gives the LLM behavioral guidance and awareness of each
 * server's purpose.
 *
 * @param mcpManager - The MCP manager with connected servers
 * @returns A formatted context string, or undefined if no context available
 */
export function getMcpServerContext(mcpManager: McpManager): string | undefined {
  const infos = mcpManager.getServerInfos();
  if (infos.length === 0) return undefined;

  const sections: string[] = [];

  for (const info of infos) {
    // Skip servers that have no meaningful context to inject
    const hasInstructions = !!info.instructions?.trim();
    const hasResources = info.resources.length > 0;
    const hasPrompts = info.prompts.some((p) => p.content.trim().length > 0);
    if (!hasInstructions && !hasResources && !hasPrompts) continue;

    const serverSections: string[] = [];
    const displayName = info.serverName ?? info.name;
    const version = info.serverVersion ? ` v${info.serverVersion}` : "";

    serverSections.push(`### MCP Server: ${displayName}${version}`);

    // Instructions (behavioral guidance from the server)
    if (info.instructions?.trim()) {
      serverSections.push("");
      serverSections.push("**Server Instructions:**");
      serverSections.push(info.instructions.trim());
    }

    // Resources (static content available from the server)
    if (info.resources.length > 0) {
      serverSections.push("");
      serverSections.push("**Available Resources:**");
      for (const r of info.resources) {
        const desc = r.description ? ` — ${r.description}` : "";
        if (r.textContent?.trim()) {
          // Include the full text content inline so the LLM can reference it
          serverSections.push(`#### ${r.name}${desc}`);
          serverSections.push(r.textContent.trim());
        } else {
          serverSections.push(`- \`${r.uri}\`: ${r.name}${desc}`);
        }
      }
    }

    // Prompts (resolved prompt content)
    if (info.prompts.length > 0) {
      serverSections.push("");
      serverSections.push("**Server Guidance (from prompts):**");
      for (const p of info.prompts) {
        if (p.content.trim()) {
          const label = p.description ?? p.name;
          serverSections.push(`[${label}]`);
          serverSections.push(p.content.trim());
        }
      }
    }

    sections.push(serverSections.join("\n"));
  }

  if (sections.length === 0) return undefined;

  return ["## External MCP Server Context", "", ...sections].join("\n");
}
