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
  DirectInputForm,
  HitlRunState,
  SerializableSendRequest,
} from "./types.js";

export {
  HITL_INPUT_EVENT,
  HITL_ORCHESTRATION_NAME,
  HITL_RESUME_ACTIVITY,
  HITL_PUSH_REQUEST_ACTIVITY,
  HITL_TIMEOUT_ACTIVITY,
  type HitlWaitInput,
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

// The durable wait for a user's answer (registered in workflows.ts).
export { hitlWait } from "./orchestrator.js";
