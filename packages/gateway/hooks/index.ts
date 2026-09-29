/**
 * AgentForEach Hooks Module — Public API
 *
 * Typed lifecycle hooks for the AgentForEach message pipeline.
 *
 * ```ts
 * import { HookEmitter } from "./hooks/index.js";
 *
 * const hooks = new HookEmitter();
 *
 * // Observe-only hook
 * hooks.on("llm_response", (event) => {
 *   console.log(`LLM responded with ${event.model}`);
 * });
 *
 * // Modifying hook — inject context before prompt build
 * hooks.on("before_prompt_build", (event) => {
 *   return { extraContext: "Always mention the weather." };
 * });
 *
 * // Modifying hook — block a tool call
 * hooks.on("before_tool_call", (event) => {
 *   if (event.name === "dangerous_tool") {
 *     return { block: true, blockReason: "Not allowed" };
 *   }
 * });
 * ```
 */

// -- Emitter --
export { HookEmitter } from "./emitter.js";

// -- Types --
export type {
  HookEventMap,
  HookResultMap,
  VoidHookName,
  ModifyingHookName,
  VoidHookHandler,
  ModifyingHookHandler,
  HookHandler,
} from "./types.js";
