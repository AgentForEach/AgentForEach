/**
 * Prompt Sections — Barrel Exports
 *
 * Modular section builders for the AgentForEach system prompt.
 * Each section is independently testable and composable.
 *
 * Section builders follow a consistent pattern:
 *   - Accept a params object with only the data they need
 *   - Return `string[]` (lines to be joined by the builder)
 *   - Return empty array when the section should be omitted
 *
 * Usage:
 * ```ts
 * import { buildSafetySection, buildTimeSection } from "./sections/index.js";
 *
 * const lines = [
 *   ...buildSafetySection(),
 *   ...buildTimeSection({ userTimezone: "America/New_York" }),
 * ];
 * ```
 */

// -- INDENTITY--

export { resolveIdentity } from "./identity.js";

// -- Tooling --
export {
  buildToolLines,
  buildToolingSection,
  buildToolCallStyleSection,
  CORE_TOOL_SUMMARIES,
  TOOL_ORDER,
} from "./tooling.js";

// -- Safety & Gateway --
export { buildSafetySection, buildGatewayReferenceSection } from "./safety.js";

// -- Memory --
export {
  buildMemoryRecallSection,
  buildRecalledMemoriesSection,
} from "./memory.js";

// -- Workspace --
export { buildWorkspaceSection } from "./workspace.js";

// -- Authorized Senders --
export { buildAuthorizedSendersSection } from "./senders.js";

// -- Date & Time --
export { buildTimeSection } from "./time.js";

// -- Messaging & Channel --
export {
  buildReplyTagsSection,
  buildMessagingSection,
  buildChannelContextSection,
  buildGroupChatSection,
  buildExtraContextSection,
} from "./messaging.js";

// -- Project Context --
export { buildProjectContextSection } from "./context.js";

// -- Response Signals (Silent Replies + Heartbeats) --
export {
  buildSilentRepliesSection,
  buildHeartbeatsSection,
} from "./signals.js";

// -- Episodes (cross-session episodic memory) --
export { buildActiveEpisodesSection, buildEpisodesSection } from "./episodes.js";

// -- Skills --
export { buildSkillsSection } from "./skills.js";

// -- Compaction Summary --
export { buildCompactionSection } from "./compaction.js";

// -- Recency (session digests) --
export { buildRecencySection } from "./recency.js";

// -- Runtime --
export { buildRuntimeSection, buildRuntimeLine } from "./runtime.js";

// -- Knowledge --
export { buildKnowledgeSection } from "./knowledge.js";

// -- MCP Server Context --
export { buildMcpServerContextSection } from "./mcp-context.js";
