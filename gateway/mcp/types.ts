/**
 * AgentForEach MCP Layer — Types
 *
 * Type definitions for Model Context Protocol (MCP) server integration.
 * Allows AgentForEach to connect to external MCP servers and expose their tools
 * alongside native AgentForEach tools in the LLM tool loop.
 *
 * Supports two transport modes:
 *   - `stdio`  — spawn a local process (e.g. `npx @modelcontextprotocol/server-filesystem`)
 *   - `sse`    — connect to an HTTP+SSE remote server
 *
 * Design:
 *   - Config in agentforeach.json "mcp.servers" section
 *   - Tools auto-discovered via MCP `tools/list` on connection
 *   - Tool calls routed through the MCP client at runtime
 *   - Optional tool allowlist per server for security
 *   - Namespace-prefixed tool names to avoid collisions (server_toolName)
 */

// ============================================================================
// MCP JSON Config (agentforeach.json shape)
// ============================================================================

/**
 * Per-server configuration as written in agentforeach.json.
 */
export interface McpServerJsonConfig {
  /** Whether this server is active. Defaults to true. */
  enabled?: boolean;

  /**
   * Transport type.
   *   - "stdio"       — spawn a local child process
   *   - "sse"         — connect to an HTTP+SSE endpoint
   *   - "streamable-http" — connect via Streamable HTTP (MCP 2025-03-26+)
   */
  transport: "stdio" | "sse" | "streamable-http";

  // -- stdio transport --
  /** Command to spawn (e.g. "npx", "node", "python"). */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
  /** Environment variables for the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;

  // -- sse / streamable-http transport --
  /** URL for SSE or Streamable HTTP endpoint. */
  url?: string;
  /** Extra HTTP headers (e.g. auth tokens). Supports $ENV_VAR references. */
  headers?: Record<string, string>;

  // -- tool filtering --
  /**
   * Optional allowlist of tool names from this server.
   * If set, only these tools are exposed to the LLM.
   * Omit to expose all tools discovered from the server.
   */
  tools?: string[];

  // -- tool naming --
  /**
   * Prefix tool names with `{serverName}_` before exposing them to the LLM.
   *
   * Defaults to true. Set to false on single-server deployments whose prompt
   * and server-side instructions refer to tools by their bare names — a
   * prompt that says `draft_contract` while the model sees `example_draft_contract`
   * is guidance about tools that do not exist. When more than one enabled
   * server opts out, namespacing is forced back on for all of them (bare
   * names cannot arbitrate cross-server collisions).
   */
  namespace?: boolean;

  // -- auth forwarding --
  /**
   * Forward the calling user's identity to the MCP server on each tool call.
   *
   * When enabled, the userId is injected into the MCP request's `_meta` field
   * as `x-agentforeach-user-id`. The MCP server can read this from the incoming
   * CallToolRequest's `params._meta["x-agentforeach-user-id"]`.
   *
   * Key any per-user state on that field, never on the MCP transport or
   * session: on a long-lived host (Azure) one connection serves every user.
   *
   * Defaults to false.
   */
  forwardAuth?: boolean;

  // -- timeouts --
  /** Connection timeout in milliseconds. Default: 30000. */
  connectTimeoutMs?: number;
  /** Per-tool-call timeout in milliseconds. Default: 60000. */
  callTimeoutMs?: number;
}

/**
 * Top-level MCP configuration ("mcp" section of agentforeach.json).
 */
export interface McpJsonConfig {
  /** Master enable/disable for all MCP servers. Defaults to false. */
  enabled?: boolean;

  /**
   * Per-server configurations.
   * Key = server name (used as namespace prefix for tool names).
   */
  servers?: Record<string, McpServerJsonConfig>;
}

// ============================================================================
// Resolved MCP Config (post-env-resolution)
// ============================================================================

/**
 * Resolved per-server config after env var substitution.
 */
export interface McpServerConfig {
  /** Server name (the key from the config map). */
  name: string;
  /** Whether this server is active. */
  enabled: boolean;
  /** Transport type. */
  transport: "stdio" | "sse" | "streamable-http";

  // -- stdio --
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

  // -- sse / streamable-http --
  url?: string;
  headers?: Record<string, string>;

  // -- tool filtering --
  tools?: string[];

  // -- tool naming --
  /** Whether tool names are `{serverName}_`-prefixed for the LLM. */
  namespace: boolean;

  // -- auth forwarding --
  /** Whether to forward userId to this server on each tool call. */
  forwardAuth: boolean;

  // -- timeouts --
  connectTimeoutMs: number;
  callTimeoutMs: number;
}

/**
 * Resolved top-level MCP config.
 */
export interface McpConfig {
  enabled: boolean;
  servers: McpServerConfig[];
}

// ============================================================================
// MCP Tool (discovered from server)
// ============================================================================

/**
 * A tool discovered from an MCP server, ready for the AgentForEach tool system.
 *
 * The `name` is namespace-prefixed: `{serverName}_{originalToolName}`
 * to avoid collisions between servers and with native AgentForEach tools.
 */
export interface McpToolInfo {
  /** Namespaced tool name: {serverName}_{toolName}. */
  name: string;
  /** Original tool name on the MCP server. */
  originalName: string;
  /** MCP server this tool belongs to. */
  serverName: string;
  /** Human-readable description. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

/**
 * Result from calling an MCP tool.
 */
export interface McpToolCallResult {
  /** Whether the call succeeded. */
  isError: boolean;
  /** The result content (stringified). */
  content: string;
}

// ============================================================================
// MCP Server Info (discovered after connection)
// ============================================================================

/**
 * A resource discovered from an MCP server.
 */
export interface McpResourceInfo {
  /** Resource URI (e.g. "example://docs/welcome"). */
  uri: string;
  /** Human-readable name. */
  name: string;
  /** Description of the resource. */
  description?: string;
  /** MIME type of the resource content. */
  mimeType?: string;
  /** MCP server this resource belongs to. */
  serverName: string;
  /** Text content of the resource (read during discovery for text/* resources). */
  textContent?: string;
}

/**
 * Content of a read resource from an MCP server.
 */
export interface McpResourceContent {
  /** Resource URI. */
  uri: string;
  /** Text content (for text resources). */
  text?: string;
  /** Base64-encoded blob (for binary resources). */
  blob?: string;
  /** MIME type. */
  mimeType?: string;
}

/**
 * A prompt discovered from an MCP server.
 */
export interface McpPromptInfo {
  /** Prompt name / identifier. */
  name: string;
  /** Human-readable title. */
  title?: string;
  /** Description of the prompt. */
  description?: string;
  /** Arguments the prompt accepts. */
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  /** MCP server this prompt belongs to. */
  serverName: string;
}

/**
 * A resolved prompt with its messages from an MCP server.
 */
export interface McpResolvedPrompt {
  /** Prompt name. */
  name: string;
  /** Prompt description. */
  description?: string;
  /** MCP server this prompt belongs to. */
  serverName: string;
  /** Prompt messages (text content joined). */
  content: string;
}

/**
 * Aggregated metadata from a connected MCP server.
 *
 * Includes instructions (behavioral guidance), capabilities,
 * resources (static content), and prompts (conversation priming).
 */
export interface McpServerInfo {
  /** Server name (namespace key). */
  name: string;
  /** Server implementation name (from the server's self-report). */
  serverName?: string;
  /** Server version string. */
  serverVersion?: string;
  /** Server-provided instructions/behavioral guidance for the LLM. */
  instructions?: string;
  /** Capabilities the server declared (resources, prompts, tools, etc.). */
  capabilities?: Record<string, unknown>;
  /** Resources available on the server. */
  resources: McpResourceInfo[];
  /** Prompts available on the server (resolved with their content). */
  prompts: McpResolvedPrompt[];
}
