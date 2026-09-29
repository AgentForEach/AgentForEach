/**
 * AgentForEach Cron System — Barrel Exports
 *
 * This module:
 *   1. Re-exports all public types and functions
 *   2. Registers all Azure Functions (orchestrations, activities, HTTP triggers, timers)
 *      by importing the modules that call df.app.* and app.* at module scope
 *
 * The Azure Functions runtime loads this module via the "main" field in package.json.
 */

// — Types —
export type {
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
  CronPayloadPatch,
  CronDeliveryMode,
  CronDelivery,
  CronDeliveryPatch,
  ChannelId,
  DeliveryTarget,
  CronRunStatus,
  CronJobState,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronUsageSummary,
  CronRunDocument,
  CronHeartbeatEventDocument,
  JobResult,
  ExecutorConfig,
} from "./types.js";

// — Config —
export {
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_MODEL,
  MAX_SUMMARY_LENGTH,
  ERROR_BACKOFF_SCHEDULE_MS,
  getBackoffMs,
  DEFAULT_TOP_OF_HOUR_STAGGER_MS,
  DEFAULT_RUN_TTL_SECONDS,
  MAX_RUNS_PER_QUERY,
  SCHEDULER_INSTANCE_ID,
  FALLBACK_WAKE_INTERVAL_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  getHeartbeatIntervalMs,
  resolveNextHeartbeatAtMs,
  RUNNING_CLAIM_STALE_MS,
  HEALTH_CHECK_SCHEDULE,
  JOBS_CHANGED_EVENT,
  DEFAULT_SCHEDULER_SHARDS,
  MAX_SCHEDULER_SHARDS,
  getSchedulerShardCount,
  normalizeSchedulerShardId,
  getSchedulerShardForUser,
  getSchedulerInstanceId,
  listSchedulerInstanceIds,
  WEBHOOK_TIMEOUT_MS,
  CRON_JOBS_CONTAINER,
  CRON_DUE_INDEX_CONTAINER,
  CRON_HEARTBEAT_EVENTS_CONTAINER,
  CRON_RUNS_CONTAINER,
  MAX_DURABLE_TIMER_MS,
  FORCE_RUN_TIMEOUT_MS,
  resetCronConfig,
} from "./config.js";

// — Schedule —
export { computeNextRunAtMs, computeNextRunWithStagger } from "./schedule.js";

// — Store —
export { CronStore, getCronStore, setCronStore } from "./store.js";

// — Tools (LLM function tools) —
export {
  getCronToolDefinitions,
  CronToolHandler,
  isCronTool,
  CRON_CREATE_TOOL,
  CRON_LIST_TOOL,
  CRON_GET_TOOL,
  CRON_UPDATE_TOOL,
  CRON_DELETE_TOOL,
  CRON_RUNS_TOOL,
} from "./tools.js";

// — Executor —
export { executeJob, getExecutorConfig } from "./executor.js";

// — Delivery —
export type {
  DeliveryAdapter,
  DeliveryPayload,
  DeliveryResult,
  LastChannelResolver,
} from "./delivery.js";
export {
  registerDeliveryAdapter,
  getDeliveryAdapter,
  getRegisteredAdapters,
  hasDeliveryAdapters,
  setLastChannelResolver,
  getLastChannelResolver,
  deliverToChannel,
} from "./delivery.js";

// — Function registrations —
// NOTE: The actual Azure Functions registrations (df.app.*, app.*)
// are triggered via side-effect imports in the entry point
// (packages/src/index.ts), which imports:
//   - ./orchestrator.js  (activities, orchestrator, health check timer)
//   - ./api.js           (cron HTTP API endpoints)
// This barrel file re-exports types and functions for library consumers.
