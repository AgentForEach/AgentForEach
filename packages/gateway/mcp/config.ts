/**
 * AgentForEach MCP Layer — Config Loader
 *
 * Loads and resolves MCP server configuration from agentforeach.json "mcp" section.
 * Handles env var substitution for API keys, tokens, and URLs.
 */

import { loadConfigSection, resolveEnvValue } from "../utils/index.js";
import type { McpJsonConfig, McpServerJsonConfig, McpConfig, McpServerConfig } from "./types.js";

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

// ============================================================================
// Config Loader
// ============================================================================

let _mcpConfig: McpConfig | undefined;

/**
 * Load MCP configuration from agentforeach.json.
 *
 * Returns a resolved config with env vars substituted and defaults applied.
 * Caches the result after first load.
 */
export function loadMcpConfig(): McpConfig {
  if (_mcpConfig) return _mcpConfig;

  const raw = loadConfigSection<McpJsonConfig>("mcp") ?? {};

  if (!raw.enabled || !raw.servers || Object.keys(raw.servers).length === 0) {
    _mcpConfig = { enabled: false, servers: [] };
    return _mcpConfig;
  }

  const servers: McpServerConfig[] = [];

  for (const [name, serverJson] of Object.entries(raw.servers)) {
    const resolved = resolveServerConfig(name, serverJson);
    if (resolved.enabled) {
      servers.push(resolved);
    }
  }

  _mcpConfig = {
    enabled: servers.length > 0,
    servers,
  };

  return _mcpConfig;
}

/**
 * Resolve a single server config entry with env var substitution.
 */
function resolveServerConfig(
  name: string,
  json: McpServerJsonConfig,
): McpServerConfig {
  // Resolve env vars in headers
  const headers: Record<string, string> | undefined = json.headers
    ? Object.fromEntries(
        Object.entries(json.headers).map(([k, v]) => [k, resolveEnvValue(v) ?? v]),
      )
    : undefined;

  // Resolve env vars in env map
  const env: Record<string, string> | undefined = json.env
    ? Object.fromEntries(
        Object.entries(json.env).map(([k, v]) => [k, resolveEnvValue(v) ?? v]),
      )
    : undefined;

  // Resolve env vars in URL
  const url = json.url ? resolveEnvValue(json.url) : undefined;

  // Validate transport-specific requirements
  if (json.transport === "stdio" && !json.command) {
    console.warn(`[mcp] Server "${name}" has transport=stdio but no command. Disabling.`);
    return { name, enabled: false, transport: "stdio", namespace: true, forwardAuth: false, connectTimeoutMs: 0, callTimeoutMs: 0 };
  }

  if ((json.transport === "sse" || json.transport === "streamable-http") && !url) {
    console.warn(`[mcp] Server "${name}" has transport=${json.transport} but no url. Disabling.`);
    return { name, enabled: false, transport: json.transport, namespace: true, forwardAuth: false, connectTimeoutMs: 0, callTimeoutMs: 0 };
  }

  return {
    name,
    enabled: json.enabled !== false,
    transport: json.transport,
    command: json.command,
    args: json.args,
    env,
    cwd: json.cwd,
    url,
    headers,
    tools: json.tools,
    namespace: json.namespace !== false,
    forwardAuth: json.forwardAuth === true,
    connectTimeoutMs: json.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    callTimeoutMs: json.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  };
}

/**
 * Check if MCP is enabled (at least one server configured and active).
 */
export function isMcpEnabled(): boolean {
  return loadMcpConfig().enabled;
}

/**
 * Reset cached config (useful for testing).
 */
export function resetMcpConfig(): void {
  _mcpConfig = undefined;
}
