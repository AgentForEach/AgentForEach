/**
 * AgentForEach Cron System — Types
 *
 * All type definitions for the scheduled task system: jobs stored in
 * Cosmos DB, run by Durable Functions, with main-target jobs running in the
 * user's gateway session.
 */

// ============================================================================
// Schedule (discriminated union)
// ============================================================================


// ** Main Cron Configuration Interface **

export type CronConfig = {
  /** Register the /cron/* HTTP API. Default: true. */
  enabled?: boolean;
  execution: {
    defaultJobTimeoutMs: number;
    defaultModel: string;
    defaultProvider?: string;
    maxSummaryLength: number;
    deliveryLeadTimeMs: number;
    maxOneShotDeliveryRetries: number;
    immediateDelayFloorMs: number;
  };
  backoff: { scheduleMs: number[] };
  stagger: { defaultTopOfHourMs: number };
  scheduler: {
    instanceIdPrefix: string;
    defaultShards: number;
    maxShards: number;
    fallbackWakeIntervalMs: number;
    maxDueJobsPerTick: number;
    maxDurableTimerMs: number;
    forceRunTimeoutMs: number;
    healthCheckSchedule: string;
    jobsChangedEvent: string;
    runningClaimStaleMs: number;
    claimConcurrency: number;
    legacySweepIntervalMs: number;
    legacySweepMaxJobs: number;
  };
  heartbeat: {
    intervalMs: number;
    maxEventsPerClaim: number;
    groupBatchSize: number;
    maxAttempts: number;
    wakeNowImmediateFlushLimit: number;
    wakeNowBacklogThreshold: number;
    maxPendingEventsPerUser: number;
  };
  limits: {
    maxJobsPerUser: number;
    minEveryMs: number;
    minCronIntervalMs: number;
    maxNameLength: number;
    maxDescriptionLength: number;
    maxCronExprLength: number;
    /** Default expiry duration for recurring jobs (ms). */
    defaultExpiryMs: number;
    /** Maximum allowed expiry duration from now (ms). Hard cap. */
    maxExpiryMs: number;
    maxPayloadTextLength: number;
    maxPayloadMessageLength: number;
    maxWebhookUrlLength: number;
    maxWebhookTokenLength: number;
    maxDeliveryStringLength: number;
    maxIdStringLength: number;
    maxModelNameLength: number;
  };
  runHistory: {
    defaultTtlSeconds: number;
    maxRunsPerQuery: number;
    defaultQueryLimit: number;
    maxQueryLimit: number;
  };
  cosmos: {
    jobsContainer: string;
    dueIndexContainer: string;
    runsContainer: string;
    heartbeatEventsContainer: string;
    dueIndexTtlSeconds: number;
    heartbeatEventTtlSeconds: number;
  };
  webhook: { timeoutMs: number };
}



/**
 * When to run the job.
 *
 * - `at`:    One-shot at an absolute ISO-8601 timestamp.
 * - `every`: Recurring interval in milliseconds.
 * - `cron`:  Standard 5/6-field cron expression with optional IANA timezone.
 */
export type CronSchedule =
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };

export type CronSessionTarget = "main" | "isolated";

export type CronWakeMode = "next-heartbeat" | "now";

// ============================================================================
// Payload
// ============================================================================

/**
 * What the job executes.
 *
 * - main target: systemEvent text routed through the main agent session
 * - isolated target: direct model turn with agentTurn payload
 */
export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      model?: string;
      timeoutSeconds?: number;
    };

export type CronPayloadPatch =
  | { kind: "systemEvent"; text?: string }
  | {
      kind: "agentTurn";
      message?: string;
      model?: string;
      timeoutSeconds?: number;
    };

// ============================================================================
// Delivery
// ============================================================================
// Channel Identification (extensible — add channels as they're built)
// ============================================================================

/**
 * Known chat channel identifiers.
 *
 * New channels are added here as they're implemented. The `string & {}` arm allows
 * custom/third-party channel IDs without breaking existing types.
 *
 */
export type ChannelId =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "imessage"
  | "signal"
  | "email"
  | "push"         // generic push notification (APNs / FCM)
  | "sms"
  | (string & {});  // extensible — custom channel plugins

// ============================================================================
// Delivery
// ============================================================================

export type CronDeliveryMode = "none" | "webhook" | "announce" | "channel";

/**
 * Where to deliver the job result after execution.
 *
 * Three modes:
 *   - **none**: Result stored in run history only.
 *   - **webhook**: HTTP POST to a URL.
 *   - **channel**: Route to a chat channel / notification channel.
 *
 * The `channel` mode is designed to be extensible — new channels (Telegram,
 * WhatsApp, push notifications, email) are added by registering a
 * `DeliveryAdapter` for the channelId. The cron system itself never
 * directly references any channel's API.
 */
export type CronDelivery = {
  /** Delivery mode. Default: "none". */
  mode: CronDeliveryMode;

  // — Webhook fields (mode = "webhook") —
  /** Webhook URL (required when mode is "webhook"). */
  to?: string;
  /** Optional bearer token for webhook auth. */
  token?: string;

  // — Channel fields (mode = "channel") —
  /**
   * Target channel identifier.
   * e.g. "telegram", "whatsapp", "push", "email"
   *
   * Special value "last" means "deliver to whichever channel the user
   * last interacted on" — resolved at delivery time by the delivery
   * target resolver.
   */
  channelId?: ChannelId | "last";
  /**
   * Recipient address within the channel.
   * e.g. Telegram chat ID, WhatsApp phone number, email address,
   * Discord channel snowflake, etc.
   *
   * If omitted, the delivery adapter resolves it from the user's profile
   * or last-used session.
   */
  recipientId?: string;
  /**
   * Optional thread / topic ID within a conversation.
   * e.g. Discord thread, Telegram topic, Slack thread_ts.
   */
  threadId?: string;
  /**
   * Optional bot/account identifier for multi-account channel setups.
   */
  accountId?: string;
  /**
   * The chat this job was created from, recorded by the server when a
   * channel conversation created it. Proves the owner may deliver there
   * (e.g. a group chat). Never accepted from API input.
   */
  channelBinding?: { channelId: string; chatId: string };

  // — Common —
  /** If true, delivery failure doesn't fail the job. */
  bestEffort?: boolean;
};

export type CronDeliveryPatch = Partial<CronDelivery>;

/**
 * Resolved delivery target — produced by the delivery target resolver
 * at execution time. Separates "what the user requested" from
 * "where we're actually sending."
 *
 */
export type DeliveryTarget = {
  channelId: ChannelId;
  recipientId: string;
  threadId?: string;
  accountId?: string;
  /** How the target was resolved. */
  resolution: "explicit" | "from-profile" | "last-session" | "session-metadata";
};

// ============================================================================
// Job State (runtime tracking)
// ============================================================================

export type CronRunStatus = "ok" | "error" | "skipped" | "expired";

export type CronJobState = {
  /** Next scheduled execution time (epoch ms). */
  nextRunAtMs?: number;
  /** Marker to prevent duplicate execution of the same job concurrently. */
  runningAtMs?: number;
  /** Unique claim token for the in-flight execution attempt. */
  runningToken?: string;
  /** Timestamp when the claimed run actually started execution. */
  runningStartedAtMs?: number;
  /** When the job last ran (epoch ms). */
  lastRunAtMs?: number;
  /** Outcome of the last run. */
  lastStatus?: CronRunStatus;
  /** Error message from the last failed run. */
  lastError?: string;
  /** Duration of the last run (ms). */
  lastDurationMs?: number;
  /** Consecutive error count (for backoff). Resets on success. */
  consecutiveErrors?: number;
  /** Total number of successful runs completed. Used with maxRuns. */
  runCount?: number;
};

// ============================================================================
// Job (Cosmos DB Document)
// ============================================================================

/**
 * A cron job stored in Cosmos DB.
 *
 * Container: cron-jobs
 * Partition key: /userId
 */
export type CronJob = {
  /** Cosmos DB document id (UUID). */
  id: string;
  /** Owner user id — partition key. */
  userId: string;
  /** Monotonic job version for concurrency-safe secondary index updates. */
  version: number;
  /**
   * Scheduler shard id for this job.
   * Deterministically derived from userId to keep due queries partitioned.
   */
  shardId: number;
  /** Optional agent routing override. */
  agentId?: string;
  /** Optional session id for main-session routing. */
  sessionId?: string;
  /** Human-readable job name. */
  name: string;
  /** Optional description. */
  description?: string;
  /** Whether the job is active. */
  enabled: boolean;
  /** Auto-delete after successful one-shot run? Default true for "at" schedules. */
  deleteAfterRun?: boolean;
  /** Creation timestamp (epoch ms). */
  createdAtMs: number;
  /** Last update timestamp (epoch ms). */
  updatedAtMs: number;
  /** When and how often to run. */
  schedule: CronSchedule;
  /** Execution target. */
  sessionTarget: CronSessionTarget;
  /** Wake semantics for main-session jobs. */
  wakeMode: CronWakeMode;
  /** What to execute. */
  payload: CronPayload;
  /** Where to deliver results (optional). */
  delivery?: CronDelivery;
  /** Runtime state (backoff, next run, last result). */
  state: CronJobState;
  /**
   * Expiry timestamp (epoch ms) for recurring jobs.
   * Recurring jobs are auto-disabled after this time.
   * One-shot "at" jobs do not require expiry.
   */
  expiresAt?: number;
  /**
   * Maximum number of successful runs before auto-disabling.
   * Only applies to recurring jobs. Omit or 0 for unlimited.
   */
  maxRuns?: number;
};

// ============================================================================
// CRUD Types
// ============================================================================

export type CronJobCreate = Omit<
  CronJob,
  "id" | "createdAtMs" | "updatedAtMs" | "state" | "shardId" | "version"
> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<
  Omit<CronJob, "id" | "userId" | "shardId" | "createdAtMs" | "state" | "payload" | "delivery" | "version">
> & {
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  state?: Partial<CronJobState>;
};

// ============================================================================
// Run History (Cosmos DB Document)
// ============================================================================

export type CronUsageSummary = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

/**
 * A completed run record stored in Cosmos DB.
 *
 * Container: cron-runs
 * Partition key: /jobId
 * TTL: automatic (24h default, auto-deleted by Cosmos DB)
 */
export type CronRunDocument = {
  /** Cosmos DB document id (UUID). */
  id: string;
  /** Job id — partition key. */
  jobId: string;
  /** Owner user id. */
  userId: string;
  /** Run timestamp (epoch ms). */
  ts: number;
  /** Run outcome. */
  status: CronRunStatus;
  /** Error message (if status is "error"). */
  error?: string;
  /** Agent response summary (truncated to 500 chars). */
  summary?: string;
  /** Duration in milliseconds. */
  durationMs?: number;
  /** Model used. */
  model?: string;
  /** Token usage. */
  usage?: CronUsageSummary;
  /** Whether result was delivered to the user. */
  delivered?: boolean;
  /** Channel used for delivery (if any). */
  deliveryChannel?: string;
  /** Cosmos DB TTL (seconds). Auto-deletes after expiry. */
  ttl: number;
};

/**
 * A queued main-session heartbeat event (wakeMode="next-heartbeat").
 *
 * Container: cron-heartbeat-events
 * Partition key: /shardId
 */
export type CronHeartbeatEventDocument = {
  /** Cosmos DB document id (UUID). */
  id: string;
  /** Source cron job id. */
  jobId: string;
  /** Owner user id. */
  userId: string;
  /** Scheduler shard id (string partition key). */
  shardId: string;
  /** Optional agent routing override. */
  agentId?: string;
  /** Optional session routing override. */
  sessionId?: string;
  /** System event text queued for the next heartbeat turn. */
  text: string;
  /** Due timestamp (epoch ms) for heartbeat flush. */
  dueAtMs: number;
  /** Enqueue timestamp (epoch ms). */
  enqueuedAtMs: number;
  /** Last update timestamp (epoch ms). */
  updatedAtMs: number;
  /** Running claim token. */
  runningToken?: string;
  /** Running claim timestamp (epoch ms). */
  runningAtMs?: number;
  /** Retry attempts. */
  attempts?: number;
  /** Last processing error (for retry/dead-letter diagnostics). */
  lastError?: string;
  /** Dead-letter timestamp when max-attempt cutoff was reached. */
  deadLetteredAtMs?: number;
  /** Dead-letter reason summary. */
  deadLetterReason?: string;
  /** Cosmos DB TTL (seconds). Auto-deletes after expiry. */
  ttl?: number;
};

// ============================================================================
// Execution
// ============================================================================

/** Result from executing a single job. */
export type JobResult = {
  status: CronRunStatus;
  error?: string;
  summary?: string;
  durationMs: number;
  model?: string;
  usage?: CronUsageSummary;
  /** Whether result was successfully delivered to the user. */
  delivered?: boolean;
  /** Which channel was used for delivery (if any). */
  deliveryChannel?: string;
  /**
   * The job can never succeed as configured (e.g. its delivery recipient
   * isn't the owner's): disable it instead of retrying.
   */
  disableJob?: boolean;
  /**
   * The job didn't run (e.g. the scheduled-run limit) and should run again
   * this many ms from now. Not a failure: nothing counts toward retries.
   */
  retryAfterMs?: number;
};

/**
 * Configuration for the job executor.
 *
 * Model and API key are resolved at runtime from the AgentForEach provider layer
 * (via `getAgentClient()`), so this only configures the default timeout.
 */
export type ExecutorConfig = {
  defaultTimeoutMs: number;
};
