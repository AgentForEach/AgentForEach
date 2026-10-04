/**
 * AgentForEach Sessions Module — Public API
 *
 * Barrel export for the session management subsystem.
 *
 * Two containers:
 *   "sessions"            — session metadata (partition key: /userId)
 *   "session-messages-v2" — individual messages (partition key: /pk =
 *                           `{userId}:{sessionId}:{instanceId}`)
 *
 * Configuration is loaded from agentforeach.json ("session" section)
 * using the same modular config pattern as auth/, llms/, cron/, memory/.
 *
 * ```ts
 * import { SessionStore, loadSessionConfig } from "./sessions/index.js";
 * import { getSharedStorage } from "./database/index.js";
 *
 * const sessionStore = new SessionStore(getSharedStorage());
 * await sessionStore.initialize();
 *
 * const session = await sessionStore.getOrCreate("user_123");
 * const messages = await sessionStore.getMessages(userId, session.sessionId);
 * ```
 */

// — Types —
export type {
  Session,
  SessionMessage,
  SessionSummary,
  SessionJsonConfig,
  MessageDocument,
} from "./types.js";

// — Config —
export {
  loadSessionConfig,
  resetSessionConfigCache,
  resolveContainerId,
  resolveMessagesContainerId,
  resolveTtlSeconds,
  resolveMaxHistory,
  resolveDefaultAgentId,
  resolveCompactionThreshold,
  resolveCompactionRetainCount,
  DEFAULT_CONTAINER_ID,
  DEFAULT_MESSAGES_CONTAINER_ID,
  DEFAULT_TTL_SECONDS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_AGENT_ID,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_COMPACTION_RETAIN_COUNT,
} from "./config.js";
export type { SessionConfig } from "./config.js";

// — Stores —
export { SessionStore, SessionReplacedError, messagePartitionKey } from "./store.js";
export { MessageStore } from "./messages-store.js";

// — Compaction —
export {
  shouldCompact,
  compactSession,
  runCompaction,
  buildCompactionPrompt,
} from "./compaction.js";
