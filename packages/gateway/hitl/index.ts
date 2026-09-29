/**
 * AgentForEach HITL Module — Re-exports
 */

// ── Types ──
export type {
  HitlFormType,
  HitlFormDefinition,
  HitlToolPolicyConfig,
  HitlUiHints,
  InputRequest,
  InputResponse,
  HitlRunState,
  SerializableSendRequest,
} from "./types.js";

export {
  HITL_INPUT_EVENT,
  HITL_ORCHESTRATION_NAME,
  HITL_RESUME_ACTIVITY,
  HITL_PUSH_REQUEST_ACTIVITY,
  HITL_TIMEOUT_ACTIVITY,
} from "./types.js";

// ── Config ──
export { loadHitlConfig, isHitlEnabled, resetHitlConfig } from "./config.js";

// ── Policy ──
export {
  getHitlPolicy,
  shouldGate,
  resolveIntent,
  resolveSchema,
  resolveOptions,
} from "./policy.js";

// ── Store ──
export { HitlStore } from "./store.js";
export { authorizeHitlResponse } from "./authorize.js";

// ── Tool (request_user_input) ──
export {
  REQUEST_USER_INPUT_TOOL_NAME,
  isRequestUserInputTool,
  getRequestUserInputToolDefinitions,
  getChannelRequestUserInputToolDefinitions,
} from "./tool.js";

// Side-effect: register Durable Functions orchestration + activities.
// Must be imported at app startup (via index.ts).
export {} from "./orchestrator.js";
