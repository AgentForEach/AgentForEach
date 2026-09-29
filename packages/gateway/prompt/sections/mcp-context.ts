/**
 * Prompt Section — MCP Server Context
 *
 * Builds a dedicated section for MCP server instructions, resources,
 * and prompt guidance. Placed adjacent to the Tooling section (Layer 4)
 * so the LLM treats MCP context as operational guidance for using
 * the corresponding MCP tools.
 */

// ============================================================================
// Section Builder
// ============================================================================

/**
 * Build the MCP server context section.
 *
 * Emits the pre-formatted context string produced by getMcpServerContext()
 * in the MCP handler layer. Returns an empty array when there is no
 * MCP context, so the prompt builder can safely spread the result.
 *
 * @param params.isMinimal  Whether this is a minimal prompt (cron/subagent)
 * @param params.mcpServerContext  Pre-formatted MCP context markdown
 */
export function buildMcpServerContextSection(params: {
  isMinimal: boolean;
  mcpServerContext?: string;
}): string[] {
  // Always include MCP context — even in minimal/cron prompts the LLM
  // needs to know how to work with MCP tools if they are registered.
  const content = params.mcpServerContext?.trim();
  if (!content) return [];

  return [content, ""];
}
