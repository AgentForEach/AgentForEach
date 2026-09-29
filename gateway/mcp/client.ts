/**
 * AgentForEach MCP Layer — Client
 *
 * Manages connections to MCP servers, discovers their tools, and executes
 * tool calls. Each MCP server gets its own client instance, and the
 * McpManager orchestrates all of them.
 *
 * Uses the official @modelcontextprotocol/sdk for protocol handling.
 *
 * Lifecycle:
 *   1. McpManager.initialize() — connects to all configured servers
 *   2. getToolDefinitions() — returns discovered tools in AgentForEach format
 *   3. callTool() — routes a call to the right server and returns result
 *   4. shutdown() — cleanly disconnects all servers
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpServerConfig,
  McpToolInfo,
  McpToolCallResult,
  McpServerInfo,
  McpResourceInfo,
  McpResolvedPrompt,
} from "./types.js";

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type McpToolResponseLike = {
  [key: string]: unknown;
  content?: unknown;
  structuredContent?: unknown;
};

/**
 * "fetch failed" is undici hiding the real error in `cause` — ENOTFOUND,
 * ECONNREFUSED, ETIMEDOUT, a TLS failure — which is exactly the part that
 * distinguishes "server down" from "DNS broken" from "handshake rejected".
 * Walk the cause chain so the log line carries the diagnosis, not the shrug.
 */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let cause: unknown = err.cause;
  for (let depth = 0; depth < 3 && cause; depth += 1) {
    const c = cause as { code?: string; message?: string; cause?: unknown };
    parts.push(`cause: ${c.code ?? ""} ${c.message ?? String(cause)}`.trim());
    cause = c.cause;
  }
  return parts.join(" — ");
}

export function serializeMcpToolResultContent(result: McpToolResponseLike): string {
  const textContent = (Array.isArray(result.content) ? result.content : [])
    .filter(
      (item): item is { type: string; text: string } =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string" &&
        item.text.length > 0,
    )
    .map((item) => item.text)
    .join("\n");

  if (textContent) return textContent;

  const fallback = result.structuredContent !== undefined
    ? result.structuredContent
    : result.content;

  if (typeof fallback === "string") return fallback;
  if (fallback === undefined) return "";
  return JSON.stringify(fallback);
}

// ============================================================================
// Single Server Connection
// ============================================================================

/**
 * A connection to a single MCP server.
 */
class McpServerConnection {
  readonly name: string;
  private readonly config: McpServerConfig;
  private client: Client | undefined;
  private tools: McpToolInfo[] = [];
  private connected = false;
  private serverInfo: McpServerInfo = {
    name: "",
    resources: [],
    prompts: [],
  };

  constructor(config: McpServerConfig) {
    this.name = config.name;
    this.config = config;
  }

  /**
   * Connect to the MCP server and discover its tools.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    this.client = new Client(
      { name: `agentforeach-mcp-${this.name}`, version: "1.0.0" },
      { capabilities: {} },
    );

    const transport = this.createTransport();

    try {
      await withTimeout(
        (async () => {
          await this.client!.connect(transport);
          this.connected = true;
          await this.discoverTools();
          await this.discoverServerInfo();
        })(),
        this.config.connectTimeoutMs,
        `MCP server "${this.name}" connection`,
      );
      const parts = [`${this.tools.length} tool(s)`];
      if (this.serverInfo.instructions) parts.push("instructions");
      if (this.serverInfo.resources.length > 0) parts.push(`${this.serverInfo.resources.length} resource(s)`);
      if (this.serverInfo.prompts.length > 0) parts.push(`${this.serverInfo.prompts.length} prompt(s)`);
      console.log(
        `[mcp] Connected to "${this.name}" — discovered ${parts.join(", ")}`,
      );
    } catch (err) {
      console.error(
        `[mcp] Failed to connect to "${this.name}":`,
        describeFetchError(err),
      );
      this.connected = false;
      throw err;
    }
  }

  /**
   * Discover tools from the MCP server.
   */
  private async discoverTools(): Promise<void> {
    if (!this.client) return;

    const result = await this.client.listTools();

    // namespace:false exposes bare tool names — valid only when this is the
    // sole enabled server (McpManager forces the prefix back on otherwise).
    const prefix = this.config.namespace ? `${this.name}_` : "";
    const allTools: McpToolInfo[] = (result.tools ?? []).map((tool) => ({
      name: `${prefix}${tool.name}`,
      originalName: tool.name,
      serverName: this.name,
      description: tool.description ?? `Tool from MCP server "${this.name}"`,
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));

    // Apply optional allowlist filter
    if (this.config.tools?.length) {
      const allowed = new Set(this.config.tools);
      this.tools = allTools.filter((t) => allowed.has(t.originalName));
    } else {
      this.tools = allTools;
    }
  }

  /**
   * Discover server info: instructions, capabilities, resources, and prompts.
   *
   * Called after a successful connection. Reads whatever the server exposes:
   *   - Instructions (behavioral guidance from the server's initialization)
   *   - Capabilities (what protocol features the server supports)
   *   - Resources (static content the LLM can read)
   *   - Prompts (pre-built conversation starters / behavioral priming)
   */
  private async discoverServerInfo(): Promise<void> {
    if (!this.client) return;

    const info: McpServerInfo = {
      name: this.name,
      resources: [],
      prompts: [],
    };

    // -- Server version & instructions --
    const version = this.client.getServerVersion();
    if (version) {
      info.serverName = version.name;
      info.serverVersion = version.version;
    }

    info.instructions = this.client.getInstructions();
    info.capabilities = this.client.getServerCapabilities() as Record<string, unknown> | undefined;

    // -- Resources --
    const caps = this.client.getServerCapabilities();
    if (caps?.resources) {
      try {
        const resourceList = await this.client.listResources();
        const resources: McpResourceInfo[] = [];

        for (const r of resourceList.resources ?? []) {
          const resource: McpResourceInfo = {
            uri: r.uri,
            name: r.name,
            description: r.description,
            mimeType: r.mimeType,
            serverName: this.name,
          };

          // Read content for text resources so the LLM can see them
          const isText = !r.mimeType || r.mimeType.startsWith("text/");
          if (isText) {
            try {
              const content = await this.client.readResource({ uri: r.uri });
              const text = (content.contents ?? [])
                .filter((c): c is { uri: string; text: string } => "text" in c && typeof c.text === "string")
                .map((c) => c.text)
                .join("\n");
              if (text.trim()) {
                resource.textContent = text;
              }
            } catch (err) {
              console.warn(
                `[mcp] Failed to read resource "${r.uri}" from "${this.name}":`,
                err instanceof Error ? err.message : err,
              );
            }
          }

          resources.push(resource);
        }

        info.resources = resources;
      } catch (err) {
        console.warn(
          `[mcp] Failed to list resources from "${this.name}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // -- Prompts --
    if (caps?.prompts) {
      try {
        const promptList = await this.client.listPrompts();
        const resolvedPrompts: McpResolvedPrompt[] = [];

        for (const p of promptList.prompts ?? []) {
          // Only auto-resolve prompts that require no arguments
          const hasRequired = p.arguments?.some((a) => a.required);
          if (hasRequired) continue;

          try {
            const resolved = await this.client.getPrompt({ name: p.name });
            const textContent = (resolved.messages ?? [])
              .map((m) => {
                const c = m.content as
                  | string
                  | { type: string; text?: string }
                  | { type: string; text?: string }[];
                if (typeof c === "string") return c;
                if (Array.isArray(c)) {
                  return c
                    .filter((item) => item.type === "text" && item.text)
                    .map((item) => item.text!)
                    .join("\n");
                }
                if (c && typeof c === "object" && c.type === "text" && c.text) {
                  return c.text;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n");

            resolvedPrompts.push({
              name: `${this.name}_${p.name}`,
              description: resolved.description ?? p.description,
              serverName: this.name,
              content: textContent,
            });
          } catch (err) {
            console.warn(
              `[mcp] Failed to resolve prompt "${p.name}" from "${this.name}":`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        info.prompts = resolvedPrompts;
      } catch (err) {
        console.warn(
          `[mcp] Failed to list prompts from "${this.name}":`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    this.serverInfo = info;
  }

  /**
   * Get all discovered tools from this server.
   */
  getTools(): McpToolInfo[] {
    return this.tools;
  }

  /**
   * Get server info (instructions, capabilities, resources, prompts).
   */
  getServerInfo(): McpServerInfo {
    return this.serverInfo;
  }

  /**
   * Call a tool on this MCP server.
   *
   * @param toolName - The tool name (server-local, not namespaced)
   * @param args     - Tool arguments
   * @param userId   - Optional calling user ID (forwarded via _meta if forwardAuth is enabled)
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    userId?: string,
    context?: { channelName?: string; channelChatId?: string },
  ): Promise<McpToolCallResult> {
    if (!this.client || !this.connected) {
      return {
        isError: true,
        content: `MCP server "${this.name}" is not connected`,
      };
    }

    try {
      // Build _meta with auth context if forwardAuth is enabled. The channel
      // rides along so channel-shaped tools (a WhatsApp Flow hand-off) can
      // refuse on surfaces that cannot honour them.
      const _meta: Record<string, unknown> | undefined =
        this.config.forwardAuth && userId
          ? {
              "x-agentforeach-user-id": userId,
              ...(context?.channelName
                ? { "x-agentforeach-channel": context.channelName }
                : {}),
              ...(context?.channelChatId
                ? { "x-agentforeach-channel-chat-id": context.channelChatId }
                : {}),
            }
          : undefined;

      const result = await this.client.callTool(
        { name: toolName, arguments: args, ...(_meta ? { _meta } : {}) },
        undefined,
        {
          timeout: this.config.callTimeoutMs,
        },
      );

      return {
        isError: !!result.isError,
        content: serializeMcpToolResultContent(result),
      };
    } catch (err) {
      return {
        isError: true,
        content: `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      try {
        await this.client.close();
      } catch {
        // Best-effort cleanup
      }
    }
    this.connected = false;
    this.client = undefined;
    this.tools = [];
    this.serverInfo = { name: this.name, resources: [], prompts: [] };
  }

  /**
   * Check if this server is connected and ready.
   */
  isReady(): boolean {
    return this.connected;
  }

  /**
   * Create the appropriate transport based on config.
   */
  private createTransport() {
    switch (this.config.transport) {
      case "stdio":
        return new StdioClientTransport({
          command: this.config.command!,
          args: this.config.args,
          env: {
            ...process.env,
            ...this.config.env,
          } as Record<string, string>,
          cwd: this.config.cwd,
        });

      case "sse":
        return new SSEClientTransport(
          new URL(this.config.url!),
          {
            requestInit: this.config.headers
              ? { headers: this.config.headers }
              : undefined,
          },
        );

      case "streamable-http":
        return new StreamableHTTPClientTransport(
          new URL(this.config.url!),
          {
            requestInit: this.config.headers
              ? { headers: this.config.headers }
              : undefined,
          },
        );

      default:
        throw new Error(`Unsupported MCP transport: ${this.config.transport}`);
    }
  }
}

// ============================================================================
// MCP Manager (orchestrates all server connections)
// ============================================================================

/**
 * Manages connections to all configured MCP servers.
 *
 * Provides a unified interface for:
 *   - Initialization (connect to all servers)
 *   - Tool discovery (aggregated from all servers)
 *   - Tool execution (routed to the correct server)
 *   - Shutdown (disconnect all)
 */
/** Backoff for a server that has not connected yet. */
const RECONNECT_MIN_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 5 * 60_000;

interface ReconnectState {
  /** Epoch ms before which no further attempt is made. */
  nextAttemptAt: number;
  /** Delay applied after the next failure. */
  delayMs: number;
  /** In-flight attempt, so concurrent turns do not stampede. */
  attempt?: Promise<void>;
}

export class McpManager {
  private readonly configs: McpServerConfig[];
  private readonly connections = new Map<string, McpServerConnection>();
  private readonly reconnects = new Map<string, ReconnectState>();
  private initialized = false;

  constructor(configs: McpServerConfig[]) {
    // Bare (un-namespaced) tool names cannot arbitrate collisions between
    // servers, so the opt-out only holds when at most one enabled server
    // uses it alongside no other enabled servers.
    const enabled = configs.filter((c) => c.enabled);
    const bare = enabled.filter((c) => !c.namespace);
    if (bare.length > 0 && enabled.length > 1) {
      console.warn(
        `[mcp] namespace:false requires a single enabled server; ` +
          `forcing namespacing on: ${bare.map((c) => c.name).join(", ")}`,
      );
      this.configs = configs.map((c) =>
        c.namespace ? c : { ...c, namespace: true },
      );
    } else {
      this.configs = configs;
    }
  }

  /**
   * Connect to all configured MCP servers.
   *
   * Connections are attempted in parallel. Failed connections are logged
   * but don't prevent other servers from connecting (graceful degradation),
   * and are queued for retry by [ensureConnected] rather than abandoned.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await Promise.allSettled(
      this.configs.map(async (config) => {
        const conn = new McpServerConnection(config);
        try {
          await conn.connect();
          this.connections.set(config.name, conn);
        } catch {
          // Logged inside connect(). Schedule a retry instead of dropping the
          // server for the life of the process — see ensureConnected.
          this.scheduleReconnect(config.name);
        }
      }),
    );

    const connected = this.connections.size;
    const total = this.configs.length;
    if (connected > 0) {
      console.log(`[mcp] Initialized ${connected}/${total} server(s)`);
    } else if (total > 0) {
      console.warn(
        `[mcp] All ${total} server(s) failed to connect — will retry on the next turn`,
      );
    }

    this.initialized = true;
  }

  private scheduleReconnect(name: string, failed = true): void {
    const existing = this.reconnects.get(name);
    const delayMs = existing
      ? Math.min(existing.delayMs * 2, RECONNECT_MAX_DELAY_MS)
      : RECONNECT_MIN_DELAY_MS;
    this.reconnects.set(name, {
      nextAttemptAt: failed ? Date.now() + delayMs : 0,
      delayMs,
    });
  }

  /**
   * Reconnect any configured server that is not connected yet.
   *
   * Why this exists: a server that was unreachable at process start used to
   * stay gone for the life of the process. `initialize()` swallows connection
   * failures by design (one bad server must not take the agent down), so
   * `AgentClient.initialize()` resolves successfully and the
   * `getAgentClient()` singleton caches a client that is healthy in every
   * respect except that an entire tool surface is missing from it. On Azure
   * Functions a cold start during an MCP deploy is enough to produce that, and
   * for an MCP-only deployment it is the worst possible state: the agent keeps
   * a prompt that tells it to work through its MCP tools, but has none of
   * those tools at all, so every request ends in an apology.
   *
   * Called before the tool list is built, because a lazy reconnect on
   * `callTool` would never run — a tool that is not in the list is a tool the
   * model never calls.
   *
   * Backoff keeps a genuinely down server from adding its connect timeout to
   * every turn: 5s after the first failure, doubling to 5 minutes.
   */
  async ensureConnected(): Promise<void> {
    const now = Date.now();

    const due = this.configs.filter((config) => {
      if (this.connections.has(config.name)) return false;
      const state = this.reconnects.get(config.name);
      return !state || now >= state.nextAttemptAt;
    });
    if (due.length === 0) return;

    await Promise.allSettled(
      due.map((config) => {
        const inFlight = this.reconnects.get(config.name)?.attempt;
        if (inFlight) return inFlight;

        const attempt = (async () => {
          const conn = new McpServerConnection(config);
          try {
            await conn.connect();
            this.connections.set(config.name, conn);
            this.reconnects.delete(config.name);
            console.log(`[mcp] Reconnected to "${config.name}"`);
          } catch {
            // connect() logs the reason.
            this.scheduleReconnect(config.name);
          }
        })();

        const state = this.reconnects.get(config.name) ?? {
          nextAttemptAt: 0,
          delayMs: RECONNECT_MIN_DELAY_MS,
        };
        this.reconnects.set(config.name, { ...state, attempt });
        return attempt;
      }),
    );
  }

  /** Configured servers that are not currently connected. */
  getDisconnectedServers(): string[] {
    return this.configs
      .filter((config) => !this.connections.has(config.name))
      .map((config) => config.name);
  }

  /**
   * Get all tool definitions from all connected MCP servers.
   */
  getAllTools(): McpToolInfo[] {
    const tools: McpToolInfo[] = [];
    for (const conn of this.connections.values()) {
      tools.push(...conn.getTools());
    }
    return tools;
  }

  /**
   * Check if a tool name belongs to an MCP server.
   *
   * @param toolName - The namespaced tool name (e.g. "github_create_issue")
   */
  isMcpTool(toolName: string): boolean {
    for (const conn of this.connections.values()) {
      if (conn.getTools().some((t) => t.name === toolName)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Call an MCP tool by its namespaced name.
   *
   * Routes the call to the correct server after stripping the namespace prefix.
   *
   * @param toolName - Namespaced tool name (e.g. "github_create_issue")
   * @param args     - Tool arguments
   * @param userId   - Optional calling user ID (forwarded to server if forwardAuth is enabled)
   * @returns Tool execution result
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    userId?: string,
    context?: { channelName?: string; channelChatId?: string },
  ): Promise<McpToolCallResult> {
    // Find which server owns this tool
    for (const conn of this.connections.values()) {
      const tool = conn.getTools().find((t) => t.name === toolName);
      if (tool) {
        return conn.callTool(tool.originalName, args, userId, context);
      }
    }

    return {
      isError: true,
      content: `Unknown MCP tool: ${toolName}`,
    };
  }

  /**
   * Disconnect all MCP servers.
   */
  async shutdown(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.connections.values()).map((conn) => conn.disconnect()),
    );
    this.connections.clear();
    this.initialized = false;
  }

  /**
   * Get names of all connected servers.
   */
  getConnectedServers(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Get server info from all connected MCP servers.
   *
   * Returns an array of McpServerInfo objects containing instructions,
   * capabilities, resources, and prompts from each server.
   */
  getServerInfos(): McpServerInfo[] {
    const infos: McpServerInfo[] = [];
    for (const conn of this.connections.values()) {
      infos.push(conn.getServerInfo());
    }
    return infos;
  }

  /**
   * Check if the manager is initialized and has at least one connection.
   */
  isReady(): boolean {
    return this.initialized && this.connections.size > 0;
  }
}
