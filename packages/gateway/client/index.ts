/**
 * AgentForEach Client Layer — Public API
 *
 * The main entry point for the AgentForEach personal assistant.
 *
 * ```ts
 * import { createAgentClient } from "./client/index.js";
 *
 * // Auto-resolve all config from agentforeach.json:
 * const client = createAgentClient();
 *
 * await client.initialize();
 *
 * // Simple send
 * const response = await client.send({
 *   userId: "user_123",
 *   message: "Hello, AgentForEach!",
 * });
 *
 * // Streaming send
 * await client.send(
 *   { userId: "user_123", message: "Write me a poem" },
 *   (event) => {
 *     if (event.type === "text_delta") process.stdout.write(event.delta);
 *     if (event.type === "done") console.log("\n\nDone!", event.response.durationMs + "ms");
 *   },
 * );
 * ```
 */

// -- Factory --
export { createAgentClient } from "./client.js";

// -- Types --
export type {
  AgentClient,
  AgentClientConfig,
  SendRequest,
  SendResponse,
  StreamCallback,
  ClientStreamEvent,
} from "./types.js";

// -- Session types (re-exported from sessions module for convenience) --
export type {
  Session,
  SessionMessage,
  SessionSummary,
} from "../sessions/index.js";

// -- Session Store (re-exported from sessions module for convenience) --
export { SessionStore } from "../sessions/index.js";

// -- Runner (for advanced usage / testing) --
export { runAgentTurn, type RunnerDeps } from "./runner.js";

// -- Slash Commands --
export { tryHandleCommand, parseCommand } from "./commands.js";
export type { SlashCommandName, ParsedCommand } from "./commands.js";

// -- Tool Policy --
export { applyToolPolicy, filterToolNames } from "./tool-policy.js";

// -- Hooks (re-exported from hooks module for convenience) --
export { HookEmitter } from "../hooks/index.js";
export type {
  HookEventMap,
  HookResultMap,
  VoidHookName,
  ModifyingHookName,
  HookHandler,
} from "../hooks/index.js";
