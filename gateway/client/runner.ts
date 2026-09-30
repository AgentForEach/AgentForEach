/**
 * AgentForEach Client Layer — Agent Runner
 *
 * The core message processing pipeline. Given a SendRequest, orchestrates
 * the full flow from system prompt assembly to LLM response delivery.
 *
 * Built for serverless: nothing is kept in memory between turns, one run
 * per session at a time (run lease), and a deadline on every run.
 *
 * Pipeline:
 *   1.  Load/create session
 *   1b. Load conversation history from messages container
 *   1c. Resolve links in user message (link-understanding)
 *   2.  Auto-recall relevant memories
 *   3.  Build system prompt (prompt layer)
 *   4.  Build tool definitions (memory + cron)
 *   5.  Build provider request (with conversation history + tools)
 *   6.  Call LLM with failover (retry + provider fallback on error)
 *   7.  Auto-capture memories from exchange
 *   8.  Persist session with new messages
 *   8b. Trigger compaction if threshold exceeded
 *   8c. Record usage (fire-and-forget)
 *   9.  Push response to WebSocket clients (if configured)
 *   10. Return SendResponse
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  Provider,
  ProviderId,
  ProviderRequest,
  ProviderResponse,
  FunctionCallOutput,
  ToolResultImage,
  StreamEvent,
  UsageStats,
  FunctionCallOutputItem,
  ToolDefinition as ProviderToolDefinition,
  FailoverConfig,
  ContentBlock,
  ConversationMessage,
} from "../llms/index.js";
import {
  resolveDefaultReasoningEffort,
  withFailover,
  withFailoverStream,
} from "../llms/index.js";
import { retryStreamStart } from "../llms/stream-retry.js";
import { RunLeaseLostError, SessionReplacedError } from "../sessions/store.js";
import { chainResponsesEnabled } from "../llms/config.js";
import type { MemoryLayer } from "../memory/index.js";
import {
  type CronStore,
  CronToolHandler,
  getCronToolDefinitions,
  isCronTool,
} from "../cron/index.js";
import {
  type PromptDocumentStore,
  buildSystemPrompt,
  type PromptContext,
  type AssembledPrompt,
  getPromptToolDefinitions,
  PromptToolHandler,
  isPromptTool,
  loadPromptTextConfig,
} from "../prompt/index.js";
import { sendEventToUser, EVENTS } from "../websocket/index.js";
import {
  SessionStore,
  shouldCompact,
  runCompaction,
} from "../sessions/index.js";
import type { UsageStore } from "../usage/index.js";
import { injectTimestamp } from "../utils/timestamp.js";
import type { SessionMessage } from "../sessions/index.js";
import {
  resolveLinks,
  type LinkUnderstandingConfig,
} from "../link-understanding/index.js";
import {
  IMAGE_MIME_TYPES,
  resolveAttachments,
  validateAttachments,
  type AttachmentConfig,
  type ExtractedDocument,
  type NativeDocument,
} from "../attachments/index.js";
import {
  type EpisodeStore,
  type EpisodeConfig,
  EpisodeToolHandler,
  getEpisodeToolDefinitions,
  isEpisodeTool,
} from "../episodes/index.js";
import {
  type DigestStore,
  type DigestConfig,
  type DigestDocument,
  DigestToolHandler,
  getDigestToolDefinitions,
  isDigestTool,
} from "../digests/index.js";
import type { EmbeddingsClient } from "../memory/embeddings.js";
import {
  applyToolPolicy,
  filterToolNames,
  hitlGateAction,
  HITL_APPROVAL_UNAVAILABLE,
  rejectUnofferedToolCall,
} from "./tool-policy.js";
import {
  type WebConfig,
  WebToolHandler,
  getWebToolDefinitions,
  isWebTool,
} from "../web/index.js";
import {
  type SkillsConfig,
  type ResolvedSkills,
  SkillToolHandler,
  getSkillToolDefinitions,
  isBrowserEnabled,
  resolveUserSkills,
} from "../skills/index.js";
import type { UserSkillStore, SkillBlobStore, SandboxBackend } from "../skills/index.js";
import type { ExportBlobStore } from "../skills/sandbox/export-store.js";
import type { HookEmitter } from "../hooks/index.js";
import {
  type KnowledgeLayer,
  getKnowledgeToolDefinitions,
  isKnowledgeTool,
} from "../knowledge/index.js";
import {
  type McpManager,
  getMcpToolDefinitions,
  isMcpTool,
  handleMcpToolCall,
  getMcpServerContext,
} from "../mcp/index.js";
import {
  type HitlStore,
  type InputRequest,
  type SerializableSendRequest,
  type HitlRunState,
  getHitlPolicy,
  shouldGate,
  resolveIntent,
  resolveSchema,
  resolveOptions,
  isHitlEnabled,
  loadHitlConfig,
  HITL_ORCHESTRATION_NAME,
  HITL_INPUT_EVENT,
  isRequestUserInputTool,
  getRequestUserInputToolDefinitions,
  getChannelRequestUserInputToolDefinitions,
  REQUEST_USER_INPUT_TOOL_NAME,
} from "../hitl/index.js";
import type {
  SendRequest,
  SendResponse,
  StreamCallback,
  ClientStreamEvent,
  NativeChoices,
} from "./types.js";
import { isModelAllowed } from "../llms/model-policy.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// Runner Config (internal — set by AgentClient)
// ============================================================================

export interface RunnerDeps {
  provider: Provider;
  resolveProvider?: (providerId?: ProviderId) => Provider;
  resolveDefaultModel?: (providerId?: ProviderId) => string;
  resolveMaxToolCalls?: (providerId?: ProviderId) => number | undefined;
  memory: MemoryLayer;
  cronStore: CronStore;
  promptStore: PromptDocumentStore;
  sessionStore: SessionStore;
  defaultModel: string;
  realtimeEnabled: boolean;
  streamToClient: boolean;
  autoRecall: boolean;
  autoCapture: boolean;
  /** Usage tracking store for recording per-run token counts and costs. */
  usageStore: UsageStore;
  /** Maximum tool call rounds before forcing completion. Default: 15. */
  maxToolRounds?: number;
  /** Soft tool-round budget — warn the model once when `soft` rounds are reached. */
  toolBudget?: { soft: number };
  /** Failover configuration for automatic retry + provider fallback. */
  failoverConfig?: FailoverConfig;
  /** Link understanding configuration for URL content extraction. */
  linkConfig?: LinkUnderstandingConfig;
  /** Attachment configuration for image limits and document extraction. */
  attachmentConfig?: AttachmentConfig;
  /** Episode store for cross-session episodic memory. */
  episodeStore?: EpisodeStore;
  /** Episode configuration. */
  episodeConfig?: EpisodeConfig;
  /** Shared embeddings client (for episode vector generation). */
  embeddings?: EmbeddingsClient;
  /** Hook emitter for lifecycle events. */
  hooks: HookEmitter;
  /** Web tools configuration (search + fetch). */
  webConfig?: WebConfig;
  /** Skills configuration. */
  skillsConfig?: SkillsConfig;
  /** User skill store (Cosmos DB persistence). */
  skillStore?: UserSkillStore;
  /** Skill blob store (Azure Blob Storage for SKILL.md files). */
  skillBlobStore?: SkillBlobStore;
  /** Sandbox backend (ACA Sandboxes or Dynamic Sessions) for sandboxed shell execution. */
  sandboxClient?: SandboxBackend;
  /** Export blob store for sandbox_file_export (user file downloads). */
  exportStore?: ExportBlobStore;
  /** Digest store for session recency awareness. */
  digestStore?: DigestStore;
  /** Digest configuration. */
  digestConfig?: DigestConfig;
  /** Knowledge layer for hybrid search on uploaded reference documents. */
  knowledgeLayer?: KnowledgeLayer;
  /** MCP manager for external tool servers. */
  mcpManager?: McpManager;
  /** HITL store for persisting run state during human input waits. */
  hitlStore?: HitlStore;
  /** How often a duplicate delivery checks whether the session came free (tests). */
  runLeaseWaitPollMs?: number;
}

// ============================================================================
// HITL Suspend Signal
// ============================================================================

/**
 * Thrown when the runner encounters a HITL-gated tool call.
 * The runner saves its state, starts the Durable orchestrator,
 * and throws this signal. The outer catch in runAgentTurn()
 * returns an "awaiting_input" response instead of treating it
 * as an error.
 */
export class HitlSuspendSignal extends Error {
  readonly requestId: string;
  readonly sessionId: string;
  readonly text: string;
  /**
   * Tokens already spent by this run before it suspended. Carried on the
   * signal because `usage` is scoped inside the try block that throws —
   * without it the outer catch would report a suspend as zero-cost and the
   * coin reservation would never settle.
   */
  readonly usage?: UsageStats;

  constructor(
    requestId: string,
    sessionId: string,
    text: string,
    usage?: UsageStats,
  ) {
    super("HITL_SUSPEND");
    this.name = "HitlSuspendSignal";
    this.requestId = requestId;
    this.sessionId = sessionId;
    this.text = text;
    this.usage = usage;
  }
}

const MAX_HISTORY_INPUT_CHARS = Number.parseInt(
  process.env.LLM_MAX_HISTORY_INPUT_CHARS ?? "",
  10,
);
const EFFECTIVE_MAX_HISTORY_INPUT_CHARS =
  Number.isFinite(MAX_HISTORY_INPUT_CHARS) && MAX_HISTORY_INPUT_CHARS > 0
    ? MAX_HISTORY_INPUT_CHARS
    : 16000;

/**
 * How long the provider stream may go without producing ANY event before the
 * run is failed as stalled. Generous on purpose: reasoning models can sit
 * silent for a long while between tokens, and reasoning/tool deltas reset
 * the clock — this only fires when the stream is genuinely dead.
 */
const PROVIDER_STREAM_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.LLM_STREAM_IDLE_TIMEOUT_MS ?? "",
  10,
) > 0
  ? Number.parseInt(process.env.LLM_STREAM_IDLE_TIMEOUT_MS ?? "", 10)
  : 180_000;

/**
 * Cadence of the `heartbeat` chat event during a run. Must stay under the
 * clients' socket-staleness windows (45s stale check, 25s ping) so a healthy
 * connection is never mistaken for a dead one during quiet phases.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Guard an async event stream with an inactivity timeout. Rejects (and closes
 * the underlying stream) if no event arrives within `idleMs`, so a silently
 * stalled provider connection becomes a normal, handleable error instead of
 * a run that hangs until the platform kills the function.
 */
async function* withStreamIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  /** Aborts the provider request, so the connection behind `source` closes. */
  onIdle?: (err: Error) => void,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err = new Error(
                `Provider stream produced no events for ${Math.round(idleMs / 1000)}s — aborting stalled stream`,
              );
              onIdle?.(err);
              reject(err);
            }, idleMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Not awaited: a generator's return() queues behind its pending next(),
    // so after a stall it would wait as long as the stall itself. onIdle has
    // already aborted the request, which ends that next().
    Promise.resolve(it.return?.()).catch(() => {
      // The underlying stream is already closed or broken — nothing to do.
    });
  }
}

type ToolCallResult = { callId: string; output: string; images?: ToolResultImage[] };

/**
 * If a tool call suspended the run for approval: its signal, and the results
 * of the calls from the same response that completed alongside it (entries
 * still running are `undefined` and left out).
 */
export function findSuspension(
  settled: Array<PromiseSettledResult<ToolCallResult> | undefined>,
  calls: Array<{ name: string }>,
): { signal: HitlSuspendSignal; siblingResults: Array<{ callId: string; name: string; output: string }> } | undefined {
  const suspended = settled.find(
    (r): r is PromiseRejectedResult => r?.status === "rejected" && r.reason instanceof HitlSuspendSignal,
  );
  if (!suspended) return undefined;
  return {
    signal: suspended.reason as HitlSuspendSignal,
    siblingResults: settled.flatMap((r, i) =>
      r?.status === "fulfilled" ? [{ callId: r.value.callId, name: calls[i]!.name, output: r.value.output }] : [],
    ),
  };
}

/** How long a run that paused for approval waits for the other calls of that response. */
export const SIBLING_TOOL_GRACE_MS = 10_000;

/**
 * Settle a response's tool calls. Normally that waits for all of them. Once
 * one suspends for approval, the rest get `graceMs` more: the run holds the
 * session lease while it waits, and the user's answer can't resume the
 * session until it's released. Calls still running then are `undefined`.
 */
export async function settleToolCalls(
  calls: Array<Promise<ToolCallResult>>,
  graceMs = SIBLING_TOOL_GRACE_MS,
): Promise<Array<PromiseSettledResult<ToolCallResult> | undefined>> {
  const results: Array<PromiseSettledResult<ToolCallResult> | undefined> = new Array(calls.length);
  let onSuspend!: () => void;
  const suspended = new Promise<void>((resolve) => (onSuspend = resolve));
  const all = Promise.all(
    calls.map((call, i) =>
      call.then(
        (value) => {
          results[i] = { status: "fulfilled", value };
        },
        (reason: unknown) => {
          results[i] = { status: "rejected", reason };
          if (reason instanceof HitlSuspendSignal) onSuspend();
        },
      ),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  const grace = suspended.then(
    () => new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs))),
  );
  await Promise.race([all, grace]);
  clearTimeout(timer);
  return results;
}

/**
 * Run one tool call; an exception becomes that call's output, so the model
 * can recover (retry, try another tool, explain) instead of the whole run
 * failing. A HITL suspend is not an error and still propagates.
 */
async function settleToolCall(
  call: { callId: string; name: string },
  runId: string,
  execute: () => Promise<{ callId: string; output: string }>,
): Promise<{ callId: string; output: string }> {
  try {
    return await execute();
  } catch (err) {
    if (err instanceof HitlSuspendSignal) throw err;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    console.error(`[runner] tool_call_threw run=${runId} name=${call.name} callId=${call.callId}: ${message}`);
    return {
      callId: call.callId,
      output: JSON.stringify({ error: `Tool ${call.name} failed: ${message}` }),
    };
  }
}

/** Default run budget: under the 10-minute functionTimeout in host.json. */
const DEFAULT_RUN_DEADLINE_MS = (() => {
  const v = Number.parseInt(process.env.AGENTFOREACH_RUN_DEADLINE_MS ?? "", 10);
  return v > 0 ? v : 540_000;
})();

/** Short content hash for log lines (prompt-cache diagnosis). */
function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Session run lease: short, renewed while the run is alive. */
const RUN_LEASE_TTL_MS = 60_000;
const RUN_LEASE_RENEW_MS = 20_000;
/** How often a duplicate delivery checks whether the session came free. */
const RUN_LEASE_WAIT_POLL_MS = 3_000;

/** Another turn is still running in this session. */
class SessionBusyError extends Error {
  override name = "SessionBusyError";
  readonly code = "SESSION_BUSY";
  /** @param duplicate - the holder is another delivery of this same run. */
  constructor(readonly duplicate = false) {
    super("I'm still working on your previous message in this chat. Send this again once I've replied.");
  }
}

class RunDeadlineError extends Error {
  override name = "RunDeadlineError";
  constructor(ms: number) {
    super(`Request timed out: the run exceeded its ${Math.round(ms / 1000)}s budget`);
  }
}

// ============================================================================
// Agent Runner
// ============================================================================

/**
 * Execute the full message pipeline.
 *
 * One function runs the whole turn: session and lease, prompt, the model
 * and tool loop (with provider failover), persistence and streaming.
 */
export async function runAgentTurn(
  request: SendRequest,
  deps: RunnerDeps,
  onStream?: StreamCallback,
): Promise<SendResponse> {
  const startTime = Date.now();
  // Fails the run (instead of the platform killing the function mid-write)
  // when it runs out of time; aborts the in-flight provider request too.
  const deadlineAt = request.deadlineAt ?? startTime + DEFAULT_RUN_DEADLINE_MS;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new RunDeadlineError(deadlineAt - startTime)),
    Math.max(0, deadlineAt - Date.now()),
  );
  // Never the reason a process stays up (e.g. a run that throws before its
  // try block and so never reaches the clearTimeout in finally).
  deadlineTimer.unref();
  // The current round's controller, aborted when its stream stalls.
  let roundAbort: AbortController | undefined;
  // Tokens spent so far, visible to the failure path so a failed run is
  // still billed for the rounds it completed.
  let usageSoFar: UsageStats | undefined;
  // Metered actions besides tokens (browser actions), billed by credits.unitCoins
  // on every exit that settles, like usageSoFar.
  const units: Record<string, number> = {};
  let leasedSessionId: string | undefined;
  // The session instance this run leased; /new replaces it.
  let leasedInstanceId: string | undefined;
  let leaseRenewal: NodeJS.Timeout | undefined;
  let leaseLost = false;
  // This delivery found its own run holding the session and waited for it.
  let waitedForDuplicate = false;
  // Whether this run's user message reached the session (so a failure path
  // knows whether it still has to save it).
  let userMessagePersisted = false;
  // Unique to this execution (runId repeats across retries of one request).
  const leaseId = randomUUID();
  let modelSoFar: string | undefined;
  let providerSoFar: ProviderId | undefined;
  const runId = request.runId ?? randomUUID();
  const agentId = request.agentId ?? "default";
  // One usage record per run (its id is userId:runId), however the run
  // ends: completed, stopped, or failed after some rounds.
  const recordUsage = (
    sessionId: string,
    usageStats: UsageStats | undefined,
    providerId: ProviderId | undefined,
    recordModel: string | undefined,
  ): Promise<unknown> | undefined =>
    usageStats && providerId && recordModel
      ? deps.usageStore
          .record({
            userId: request.userId,
            sessionId,
            agentId,
            runId,
            providerId,
            model: recordModel,
            usage: usageStats,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
            channelName: request.channelName,
          })
          .catch(() => {}) // Non-fatal
      : undefined;
  const activeProvider =
    request.providerId && request.providerId !== deps.provider.id
      ? (deps.resolveProvider?.(request.providerId) ??
        (() => {
          throw new Error(`Provider "${request.providerId}" is not configured`);
        })())
      : deps.provider;
  // Handlers reject disallowed models; ignore one here too for other callers.
  const requestedModel =
    request.model && isModelAllowed(activeProvider.id, request.model) ? request.model : undefined;
  const model =
    requestedModel ??
    deps.resolveDefaultModel?.(activeProvider.id) ??
    deps.defaultModel;
  const resolvedReasoningEffort =
    request.reasoningEffort ??
    resolveDefaultReasoningEffort({
      providerId: activeProvider.id,
      model,
    });

  // Emit run_started event
  onStream?.({ type: "run_started", runId });
  if (deps.realtimeEnabled && deps.streamToClient) {
    sendEventToUser(request.userId, EVENTS.CHAT, {
      state: "thinking" as const,
      runId,
      sessionId: request.sessionId,
    }).catch(() => {});
  }
  deps.hooks.emit("run_started", {
    runId,
    userId: request.userId,
    agentId,
    message: request.message,
    sessionId: request.sessionId,
    channelName: request.channelName,
    metadata: request.metadata,
  });

  // Liveness beacon for the whole run. Long tool calls and slow reasoning
  // produce stretches of socket silence that clients cannot tell apart from
  // a half-open connection, so they recycle the socket and lose whatever is
  // pushed during the reconnect gap (Web PubSub does not replay). 20s keeps
  // every client freshness window (45s stale check, 25s ping) fed. Cleared
  // in the finally below on every exit path.
  const heartbeat =
    deps.realtimeEnabled && deps.streamToClient
      ? setInterval(() => {
          sendEventToUser(request.userId, EVENTS.CHAT, {
            state: "heartbeat" as const,
            runId,
            sessionId: request.sessionId,
          }).catch(() => {});
        }, HEARTBEAT_INTERVAL_MS)
      : undefined;

  const phaseTimings: string[] = [];
  let phaseStart = startTime;
  const markPhase = (name: string) => {
    const now = Date.now();
    phaseTimings.push(`${name}=${now - phaseStart}ms`);
    phaseStart = now;
  };

  try {
    // ----------------------------------------------------------------
    // Step 1: Load or create the session
    // ----------------------------------------------------------------
    const session = await deps.sessionStore.getOrCreate(
      request.userId,
      agentId,
      request.sessionId,
    );
    // One turn per session at a time; held until the finally below.
    const acquire = () =>
      deps.sessionStore.acquireRunLease(
        request.userId,
        session.sessionId,
        leaseId,
        Date.now() + RUN_LEASE_TTL_MS,
        Date.now(),
        runId,
      );
    if (!(await acquire())) {
      const holder = await deps.sessionStore.peekActiveRun(request.userId, session.sessionId).catch(() => undefined);
      if (holder?.runId !== runId) throw new SessionBusyError();
      // Another delivery of this very run holds the session: a retry, or the
      // original on an instance that was killed (whose lease hasn't lapsed
      // yet). Wait until it finishes (then the reply is replayed below) or
      // its lease lapses (then this delivery answers); give up quietly if
      // it's still going after a lease's lifetime.
      const until = Date.now() + RUN_LEASE_TTL_MS + 15_000;
      let acquired = false;
      waitedForDuplicate = true;
      while (!acquired && Date.now() < until) {
        await new Promise((r) => setTimeout(r, deps.runLeaseWaitPollMs ?? RUN_LEASE_WAIT_POLL_MS));
        acquired = await acquire();
      }
      if (!acquired) throw new SessionBusyError(true);
    }
    leasedSessionId = session.sessionId;
    leasedInstanceId = session.instanceId;
    let leaseRenewedAt = Date.now();
    const loseLease = () => {
      leaseLost = true;
      roundAbort?.abort(new RunLeaseLostError("Run lease lost"));
    };
    leaseRenewal = setInterval(() => {
      deps.sessionStore
        .renewRunLease(request.userId, session.sessionId, leaseId, Date.now() + RUN_LEASE_TTL_MS)
        .then((held) => {
          if (held) leaseRenewedAt = Date.now();
          else loseLease(); // expired and taken: another execution owns the session
        })
        .catch(() => {
          // Can't reach the store: once the lease may have lapsed, stop.
          if (Date.now() - leaseRenewedAt > RUN_LEASE_TTL_MS - RUN_LEASE_RENEW_MS) loseLease();
        });
    }, RUN_LEASE_RENEW_MS);
    leaseRenewal.unref();
    markPhase("session");

    // Emit session lifecycle hook
    if (session.messageSeq === 0) {
      deps.hooks.emit("session_created", { session, userId: request.userId });
    } else {
      deps.hooks.emit("session_loaded", { session, userId: request.userId });
    }

    // HITL continuation mode: the runner is resuming after a tool execution
    // triggered by the HITL orchestrator. The tool result is already saved
    // in the session. The transient message in request.message is only for
    // the LLM — it won't be persisted. Link resolution, memory recall/capture,
    // and knowledge recall are skipped (no real user message to process).
    const isContinuation = request.metadata?._hitlContinuation === "true";

    let directHitlRunState: HitlRunState | null = null;
    if (request.hitlInputResponse?.requestId && deps.hitlStore) {
      try {
        const runState = await deps.hitlStore.get(
          request.hitlInputResponse.requestId,
          request.userId,
        );
        if (
          runState?.status === "pending" &&
          runState.sessionId === session.sessionId &&
          runState.pendingToolCall.name === REQUEST_USER_INPUT_TOOL_NAME &&
          runState.conversationState.previousResponseId
        ) {
          directHitlRunState = runState;
        } else if (runState) {
          console.warn(
            `[runner] hitl_input_response_ignored requestId=${request.hitlInputResponse.requestId} ` +
              `status=${runState.status} sessionMatch=${runState.sessionId === session.sessionId} ` +
              `tool=${runState.pendingToolCall.name}`,
          );
        }
      } catch (err) {
        console.warn(
          `[runner] hitl_input_response_lookup_failed requestId=${request.hitlInputResponse.requestId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let forceLocalHistoryForStaleHitl = false;
    const hitlStore = deps.hitlStore;
    if (
      !isContinuation &&
      !directHitlRunState &&
      session.conversationState?.previousResponseId &&
      hitlStore
    ) {
      try {
        const pendingHitl = await hitlStore.listPending(request.userId);
        const pendingInputRequests = pendingHitl.filter(
          (state) =>
            state.sessionId === session.sessionId &&
            state.pendingToolCall.name === REQUEST_USER_INPUT_TOOL_NAME,
        );

        if (pendingInputRequests.length > 0) {
          forceLocalHistoryForStaleHitl = true;
          console.warn(
            `[runner] stale_hitl_chain_break session=${redactId(session.sessionId)} ` +
              `pending=${pendingInputRequests.map((state) => state.requestId).join(",")}`,
          );

          await deps.sessionStore.appendMessages(
            request.userId,
            session.sessionId,
            [],
            null,
          );

          await Promise.allSettled(
            pendingInputRequests.map((state) =>
              hitlStore.updateStatus(
                state.requestId,
                request.userId,
                "cancelled",
              ),
            ),
          );
        }
      } catch (err) {
        console.warn(
          `[runner] stale_hitl_chain_break_failed session=${redactId(session.sessionId)}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const isDirectHitlToolResponse = !!directHitlRunState;
    const skipUserMessagePrework = isContinuation || isDirectHitlToolResponse;

    // ----------------------------------------------------------------
    // Step 1b: Load conversation history from messages container
    // ----------------------------------------------------------------
    const { history: conversationHistory, compactionSummary } =
      await deps.sessionStore.getProviderHistory(session);
    const boundedConversationHistory = boundConversationHistoryByChars(
      conversationHistory,
      EFFECTIVE_MAX_HISTORY_INPUT_CHARS,
    );
    markPhase("history");

    // ----------------------------------------------------------------
    // Resolve dynamic user timezone
    // ----------------------------------------------------------------
    // If the caller didn't provide a timezone, fall back to the stored
    // USER document (prompt configuration in Cosmos). This keeps timestamp
    // injection and the prompt's runtime/time sections consistent.
    let effectiveUserTimezone = request.userTimezone?.trim() || undefined;
    if (!effectiveUserTimezone) {
      try {
        const userDoc = await deps.promptStore.getData(
          request.userId,
          agentId,
          "USER",
        );
        effectiveUserTimezone = userDoc?.timezone?.trim() || undefined;
      } catch {
        // Non-fatal — proceed without timezone
      }
    }
    markPhase("timezone");

    // ----------------------------------------------------------------
    // Step 1c: Resolve links in user message
    // ----------------------------------------------------------------
    let linkContext = "";
    let linksResolved = 0;

    if (deps.linkConfig?.enabled && !skipUserMessagePrework) {
      try {
        const linkResult = await resolveLinks(request.message, deps.linkConfig);
        if (linkResult.resolved.length > 0) {
          linkContext = linkResult.contextBlock;
          linksResolved = linkResult.resolved.length;
          onStream?.({
            type: "links_resolved",
            count: linksResolved,
            urls: linkResult.detectedUrls,
          });
          deps.hooks.emit("links_resolved", {
            urls: linkResult.detectedUrls,
            count: linksResolved,
          });
        }
      } catch {
        // Link resolution failure is non-fatal — proceed without link context
      }
    }
    markPhase("links");

    // ----------------------------------------------------------------
    // Step 1d: Resolve attachments
    // ----------------------------------------------------------------
    // Images stay as base64 for the provider-native vision path. Documents
    // are flattened to text here and injected into the system prompt, which
    // is what makes them work identically on every provider.
    let documentContext = "";
    // Default to images only. Without an attachment config we can't extract
    // documents, and passing one to the vision path would send the provider
    // a PDF dressed up as an image.
    let imageAttachments = request.attachments?.filter((a) =>
      IMAGE_MIME_TYPES.has(a.mimeType?.toLowerCase() ?? ""),
    );
    let extractedDocuments: ExtractedDocument[] = [];
    let nativeDocuments: NativeDocument[] = [];

    if (request.attachments?.length && deps.attachmentConfig) {
      try {
        const validation = validateAttachments(
          request.attachments,
          deps.attachmentConfig,
        );
        if (validation.error) {
          // Transports validate first, so reaching here means an internal
          // caller sent something malformed. Drop the attachments rather
          // than failing the turn.
          imageAttachments = undefined;
          console.warn(
            `[runner] attachment validation failed: ${validation.error.message}`,
          );
        } else {
          const resolved = await resolveAttachments(
            validation.attachments ?? [],
            deps.attachmentConfig,
            {
              supportsNativeDocuments:
                activeProvider.capabilities?.nativeDocuments ?? false,
            },
          );
          imageAttachments = resolved.images.length
            ? resolved.images.map((image) => ({
                mimeType: image.mimeType,
                base64: image.base64,
              }))
            : undefined;
          documentContext = resolved.contextBlock;
          extractedDocuments = resolved.documents;
          nativeDocuments = resolved.nativeDocuments;

          for (const native of resolved.nativeDocuments) {
            console.log(
              `[runner] ${native.fileName} sent natively (${native.reason}` +
                `${native.signals ? `, layout score ${native.signals.score.toFixed(2)}` : ""})`,
            );
          }

          const touched = [
            ...resolved.documents.map((d) => d.fileName),
            ...resolved.nativeDocuments.map((d) => d.fileName),
          ];
          if (touched.length > 0) {
            onStream?.({
              type: "documents_extracted",
              count: touched.length,
              fileNames: touched,
            });
            // onStream alone doesn't reach the client — WebSocket frames are
            // pushed explicitly, the same way `thinking` is above.
            if (deps.realtimeEnabled && deps.streamToClient) {
              sendEventToUser(request.userId, EVENTS.CHAT, {
                state: "documents_extracted" as const,
                runId,
                sessionId: request.sessionId,
                fileNames: touched,
                count: touched.length,
              }).catch(() => {});
            }
            deps.hooks.emit("documents_extracted", {
              count: touched.length,
              fileNames: touched,
            });
          }
          for (const warning of resolved.warnings) {
            console.warn(`[runner] attachment warning: ${warning}`);
          }
        }
      } catch (error) {
        // Extraction failure is non-fatal — proceed without document context
        console.warn(
          `[runner] attachment resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    markPhase("attachments");

    // ----------------------------------------------------------------
    // Step 2: Auto-recall relevant memories
    // ----------------------------------------------------------------
    let memoriesContext = "";
    let memoriesRecalled = 0;

    if (deps.autoRecall && !skipUserMessagePrework) {
      try {
        const recalled = await deps.memory.recall(
          request.message,
          request.userId,
        );
        if (recalled) {
          memoriesContext = recalled;
          // Count numbered memory lines from the injected <relevant-memories> block.
          memoriesRecalled = (recalled.match(/^\d+\.\s\[/gm) || []).length;
          onStream?.({
            type: "memories_recalled",
            count: memoriesRecalled,
            context: recalled,
          });
          deps.hooks.emit("memories_recalled", {
            count: memoriesRecalled,
            context: recalled,
          });
        }
      } catch {
        // Memory recall failure is non-fatal — proceed without memories
      }
    }
    markPhase("memory");

    // ----------------------------------------------------------------
    // Step 2b: Load active episode themes for associative priming
    // ----------------------------------------------------------------
    let activeEpisodeThemes: string[] | undefined;
    if (deps.episodeStore && deps.episodeConfig?.enabled) {
      try {
        const activeEpisodes = await deps.episodeStore.getActive(
          request.userId,
          deps.episodeConfig.maxActiveEpisodes,
        );
        if (activeEpisodes.length > 0) {
          activeEpisodeThemes = activeEpisodes.map((ep) => ep.theme);
        }
      } catch {
        // Non-fatal — proceed without priming
      }
    }
    markPhase("episodes");

    // ----------------------------------------------------------------
    // Step 2c: Load recent session digests for recency awareness
    // ----------------------------------------------------------------
    let recentDigests: DigestDocument[] | undefined;
    if (deps.digestStore && deps.digestConfig?.enabled) {
      try {
        recentDigests = await deps.digestStore.getRecent(
          request.userId,
          deps.digestConfig.recallLimit,
        );
      } catch {
        // Non-fatal — proceed without digests
      }
    }
    markPhase("digests");

    // ----------------------------------------------------------------
    // Step 2d: Auto-recall relevant knowledge from AI Search
    // ----------------------------------------------------------------
    let knowledgeContext = "";
    if (deps.knowledgeLayer && !skipUserMessagePrework) {
      try {
        const recalled = await deps.knowledgeLayer.recall(request.message);
        if (recalled) {
          knowledgeContext = recalled;
        }
      } catch {
        // Non-fatal — proceed without knowledge context
      }
    }
    markPhase("knowledge");

    // ----------------------------------------------------------------
    // Step 3: Build the system prompt
    // ----------------------------------------------------------------
    // Collect tool names for the system prompt tooling section
    const memoryTools = deps.memory.getToolDefinitions();
    const cronTools = getCronToolDefinitions();
    const promptTools = getPromptToolDefinitions();
    const episodeTools = deps.episodeStore && deps.episodeConfig
      ? getEpisodeToolDefinitions()
      : [];
    const webTools = deps.webConfig?.enabled
      ? getWebToolDefinitions()
      : [];
    const digestTools = deps.digestStore && deps.digestConfig?.enabled
      ? getDigestToolDefinitions()
      : [];
    const knowledgeTools = deps.knowledgeLayer
      ? getKnowledgeToolDefinitions()
      : [];

    // MCP tools (from external MCP servers).
    //
    // Retry any server that has not connected yet BEFORE listing, because a
    // tool missing from this list is a tool the model never calls — a lazy
    // reconnect inside callTool would never be reached. Cheap when everything
    // is up, and backed off when something is genuinely down.
    if (deps.mcpManager) {
      await deps.mcpManager.ensureConnected();
    }
    const mcpTools = deps.mcpManager?.isReady()
      ? getMcpToolDefinitions(deps.mcpManager)
      : [];

    // HITL tools: request_user_input when HITL is enabled (it doesn't need
    // the Durable Functions store) AND the requesting surface can actually
    // render widgets. A message-thread channel (WhatsApp, Telegram) sets
    // hitlWidgets=false: it gets the CHANNEL variant of request_user_input
    // instead — same tool name, but a single bounded choice the channel
    // renders natively (reply buttons / list) with no suspend: the tap
    // arrives as the next inbound message.
    const surfaceRendersWidgets = request.hitlWidgets !== false;
    const hitlTools = !isHitlEnabled()
      ? []
      : surfaceRendersWidgets
        ? getRequestUserInputToolDefinitions()
        : getChannelRequestUserInputToolDefinitions();

    // Resolve per-user skills (all four tools registered from start)
    let resolvedSkills: ResolvedSkills | undefined;
    const skillTools = deps.skillsConfig?.enabled && deps.skillStore && deps.skillBlobStore
      ? getSkillToolDefinitions({
          sandboxEnabled: deps.sandboxClient?.isReady() ?? false,
          browserEnabled: isBrowserEnabled(deps.skillsConfig.sandbox, deps.sandboxClient, request.userId),
        }) : [];
    if (deps.skillsConfig?.enabled && deps.skillStore && deps.skillBlobStore) {
      try {
        // Load per-agent skill filter from TOOLS prompt doc (Layer 3)
        let agentEnabledSkills: string[] | undefined;
        try {
          const toolsData = await deps.promptStore.getData(
            request.userId,
            agentId,
            "TOOLS",
          );
          if (toolsData?.enabledSkills?.length) {
            agentEnabledSkills = toolsData.enabledSkills as string[];
          }
        } catch { /* non-fatal */ }

        resolvedSkills = await resolveUserSkills(
          deps.skillBlobStore,
          deps.skillStore,
          request.userId,
          agentEnabledSkills,
        );
      } catch {
        // Non-fatal — proceed without skills
      }
    }
    markPhase("skills");

    // All skill tools (skill_list, skill_setup, skill_read, http_fetch + sandbox_*) registered from start.
    const sessionType = request.sessionType ?? "interactive";
    const promptTextCfg = loadPromptTextConfig();
    const hiddenTools = new Set(promptTextCfg.hiddenTools ?? []);
    // Channel-scoped tools (prompt.toolChannels): hidden wherever this
    // request's channel is not on the tool's list. No channel = internal
    // caller = everything, matching gateway rule scoping.
    for (const [tool, channels] of Object.entries(
      promptTextCfg.toolChannels ?? {},
    )) {
      if (request.channelName && !channels.includes(request.channelName)) {
        hiddenTools.add(tool);
      }
    }
    const allToolNames = filterToolNames(
      [
        ...memoryTools, ...cronTools, ...promptTools, ...episodeTools, ...webTools,
        ...skillTools, ...digestTools, ...knowledgeTools, ...mcpTools,
        ...hitlTools,
      ].map((t) => t.name),
      sessionType,
      hiddenTools,
    );

    // Build dynamic tool summaries for MCP tools (for the system prompt tool listing)
    const extraToolSummaries: Record<string, string> | undefined =
      mcpTools.length > 0
        ? Object.fromEntries(
            mcpTools.map((t) => [t.name, t.description]),
          )
        : undefined;

    // Build MCP server context (instructions, resources, prompts from connected servers)
    const mcpServerContext = deps.mcpManager?.isReady()
      ? getMcpServerContext(deps.mcpManager)
      : undefined;

    const promptContext: PromptContext = {
      userId: request.userId,
      agentId,
      sessionType,
      promptMode: request.promptMode ?? "full",
      channelName: request.channelName,
      isGroupChat: request.isGroupChat,
      groupName: request.groupName,
      authorizedSenders: request.authorizedSenders,
      currentDateTime: new Date().toISOString(),
      userTimezone: effectiveUserTimezone,
      modelId: model,
      providerId: activeProvider.id,
      recalledMemories: memoriesContext || undefined,
      inboundMetaSystemPrompt: joinPromptSections(
        request.extraSystemPrompt,
        linkContext,
        documentContext,
      ),
      toolNames: allToolNames,
      // Last run's tool calls, for gateway phase derivation (config-aware
      // logic lives in the builder; the runner only reports what happened).
      gatewaySeenTools: session.metadata?.gatewayToolsLastRun
        ?.split(",")
        .filter(Boolean),
      extraToolSummaries,
      compactionSummary,
      activeEpisodeThemes,
      skillStatuses: resolvedSkills?.statuses,
      recentDigests,
      knowledgeContext: knowledgeContext || undefined,
      mcpServerContext,
    };

    // Hook: allow modifying hooks to inject extra context before prompt build
    if (deps.hooks.hasHandlers("before_prompt_build")) {
      const hookMods = await deps.hooks.emitWaterfall("before_prompt_build", {
        context: promptContext,
      });
      if (hookMods?.extraContext) {
        promptContext.inboundMetaSystemPrompt = joinPromptSections(
          promptContext.inboundMetaSystemPrompt,
          hookMods.extraContext,
        );
      }
    }

    const assembled: AssembledPrompt = await buildSystemPrompt(
      deps.promptStore,
      promptContext,
    );
    markPhase("prompt");

    // Idempotency replay: if the same request key already completed in this
    // session, return the cached assistant turn.
    // A retry with the same idempotency key, or a second delivery of this
    // run that waited for the first, replays what was already answered.
    const replayedAssistant = request.idempotencyKey
      ? await deps.sessionStore.findByIdempotencyKey(session, request.idempotencyKey)
      : waitedForDuplicate
        ? await deps.sessionStore.findByRunId(session, runId)
        : null;
    if (replayedAssistant) {
      const replayResponse: SendResponse = {
        runId,
        text: replayedAssistant.content,
        sessionId: session.sessionId,
        identity: assembled.identity,
        providerId: replayedAssistant.providerId ?? activeProvider.id,
        model: replayedAssistant.model ?? model,
        usage: replayedAssistant.usage,
        memoriesRecalled,
        memoryCaptured: false,
        durationMs: Date.now() - startTime,
        status: "completed",
      };
      // The replayed turn burns no tokens, but this run still holds a
      // reservation from client.send() — emit the terminal hook so it is
      // released instead of pinning the user's balance.
      await deps.hooks.emit("run_completed", {
        runId,
        userId: request.userId,
        response: { ...replayResponse, usage: undefined },
      });
      // A client that resends after missing the reply (e.g. across a socket
      // reconnect) is waiting on the socket, not on this call.
      if (deps.realtimeEnabled && deps.streamToClient) {
        await sendEventToUser(request.userId, EVENTS.CHAT, {
          state: "final" as const,
          runId,
          sessionId: session.sessionId,
          text: replayResponse.text,
          providerId: replayResponse.providerId,
          model: replayResponse.model,
          durationMs: replayResponse.durationMs,
          replayed: true,
        }).catch(() => {});
      }
      onStream?.({ type: "done", response: replayResponse });
      return replayResponse;
    }

    // ----------------------------------------------------------------
    // Step 4: Build tool definitions
    //         (tool names already collected above for the system prompt)
    // ----------------------------------------------------------------
    const cronHandler = new CronToolHandler(
      deps.cronStore,
      request.onCronMutation,
    );
    const promptHandler = new PromptToolHandler(deps.promptStore);
    const episodeHandler = deps.episodeStore && deps.episodeConfig
      ? new EpisodeToolHandler(deps.episodeStore, deps.episodeConfig, deps.embeddings, deps.memory)
      : undefined;
    const webHandler = deps.webConfig?.enabled
      ? new WebToolHandler(deps.webConfig)
      : undefined;
    const digestHandler = deps.digestStore && deps.digestConfig
      ? new DigestToolHandler(deps.digestStore, deps.memory, deps.digestConfig)
      : undefined;
    const skillHandler = deps.skillsConfig?.enabled && deps.skillStore && deps.skillBlobStore
      ? new SkillToolHandler(
          deps.skillStore,
          deps.skillBlobStore,
          resolvedSkills?.statuses ?? [],
          resolvedSkills?.userCredentials ?? {},
          deps.sandboxClient,
          request.userId,
          session?.sessionId,
          deps.exportStore,
          resolvedSkills?.credentialBindings ?? {},
          { scheduled: isScheduledRun(request, sessionType), units },
        )
      : undefined;

    // Convert tool definitions to provider format, filtered by session policy.
    const functionTools: ProviderToolDefinition[] = applyToolPolicy(
      [
        ...memoryTools,
        ...cronTools,
        ...promptTools,
        ...episodeTools,
        ...webTools,
        ...skillTools,
        ...digestTools,
        ...knowledgeTools,
        ...mcpTools,
        ...hitlTools,
      ].map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      })),
      sessionType,
      hiddenTools,
    );
    const offeredToolNames: ReadonlySet<string> = new Set(
      functionTools.flatMap((t) => ("name" in t ? [t.name] : [])),
    );

    // ----------------------------------------------------------------
    // Step 5: Build the provider request
    // ----------------------------------------------------------------
    const stampedMessage =
      sessionType === "interactive" && !skipUserMessagePrework
        ? injectTimestamp(request.message, { timezone: effectiveUserTimezone })
        : request.message;

    // Build the user message content. Extracted documents are absent here —
    // they went into documentContext as text. Only images and PDFs we chose
    // to send natively reach the provider as blocks.
    const userContent: string | ContentBlock[] =
      imageAttachments?.length || nativeDocuments.length
        ? buildMultimodalContent(
            stampedMessage,
            imageAttachments ?? [],
            nativeDocuments,
          )
        : stampedMessage;

    // Build the provider input array.
    //
    // When previousResponseId exists (OpenAI Responses API multi-turn), the
    // provider already has the full conversation in its chain. Sending local
    // history in `input` would DUPLICATE every prior turn (OpenAI appends
    // input items to the previous response chain). Only send the new message.
    //
    // When no previousResponseId (first message, Anthropic, or chain broken),
    // include the full local conversation history as context.
    //
    // Compaction case:
    // - Older turns are represented by `compactionSummary` in the system prompt.
    // - Direct transcript entries here are only the post-compaction tail.
    const directHitlToolOutput: FunctionCallOutput[] | undefined = directHitlRunState
      ? [
          {
            type: "function_call_output" as const,
            callId: directHitlRunState.pendingToolCall.callId,
            output: request.hitlInputResponse?.cancelled
              ? JSON.stringify({
                  ok: false,
                  cancelled: true,
                  message: "User cancelled this input request.",
                })
              : JSON.stringify({
                  ok: true,
                  userInput: request.hitlInputResponse?.data ?? {},
                }),
          },
          // Other calls from the same response, already run before the pause.
          ...(directHitlRunState.completedToolResults ?? []).map((r) => ({
            type: "function_call_output" as const,
            callId: r.callId,
            output: r.output,
          })),
        ]
      : undefined;
    // A stale form answer starts from local history; a live one resumes the
    // exact response that asked for it. Other turns continue the session's
    // chain when chaining is on; with it off only the code-interpreter
    // container (containerId) carries over.
    const conversationStateForRequest = forceLocalHistoryForStaleHitl
      ? undefined
      : directHitlRunState
        ? directHitlRunState.conversationState
        : chainResponsesEnabled()
          ? session.conversationState
          : session.conversationState?.containerId
            ? { containerId: session.conversationState.containerId }
            : undefined;
    const hasPreviousResponseChain = !!conversationStateForRequest?.previousResponseId;
    const resolvedMaxToolCalls = deps.resolveMaxToolCalls?.(activeProvider.id);
    const providerInput: ConversationMessage[] | FunctionCallOutput[] = directHitlToolOutput
      ? directHitlToolOutput
      : isContinuation
        ? // Continuation: history first (includes tool result), then continuation
          // prompt last so the LLM sees the tool result before being asked to continue.
          [...boundedConversationHistory, { role: "user" as const, content: userContent }]
        : hasPreviousResponseChain
          ? [{ role: "user" as const, content: userContent }]
          : [
              ...boundedConversationHistory,
              { role: "user" as const, content: userContent },
            ];

    console.log(
      `[runner] provider_input_mode run=${runId} session=${redactId(session.sessionId)} ` +
        `directHitl=${!!directHitlToolOutput} continuation=${isContinuation} ` +
        `previousResponseChain=${hasPreviousResponseChain} ` +
        `input=${directHitlToolOutput ? "function_call_output" : hasPreviousResponseChain ? "new_message_only" : "local_history_plus_message"}`,
    );

    const providerRequest: ProviderRequest = {
      model,
      input: providerInput,
      // If failover moves a chained turn to another provider, it gets the
      // local history instead (see ProviderRequest.failoverInput).
      ...(hasPreviousResponseChain && !directHitlToolOutput
        ? {
            failoverInput: [
              ...boundedConversationHistory,
              { role: "user" as const, content: userContent },
            ],
          }
        : {}),
      instructions: assembled.instructions,
      tools: functionTools,
      toolChoice: "auto",
      ...(resolvedMaxToolCalls !== undefined
        ? { maxToolCalls: resolvedMaxToolCalls }
        : {}),
      conversation: conversationStateForRequest
        ? {
            previousResponseId: conversationStateForRequest.previousResponseId,
            containerId: conversationStateForRequest.containerId,
          }
        : undefined,
      temperature: request.temperature,
      reasoning: resolvedReasoningEffort
        ? { effort: resolvedReasoningEffort, summary: "auto" as const }
        : undefined,
      stream: !!onStream,
      abortSignal: request.abortSignal,
      metadata: {
        ...request.metadata,
        userId: request.userId,
        runId,
        sessionId: session.sessionId,
      },
    };
    markPhase("provider_request");

    // ----------------------------------------------------------------
    // Step 6: Call the LLM provider (with tool execution loop)
    //
    // If failover is enabled, both streaming and non-streaming paths
    // are wrapped with automatic retry + provider fallback. On
    // retryable errors (429, 500, 502, 503, network failures), the
    // next provider in the chain is tried with its default model.
    // ----------------------------------------------------------------
    const maxRounds = deps.maxToolRounds ?? 15;
    let responseText = "";
    let responseModel = model;
    let effectiveProviderId: ProviderId = activeProvider.id;
    let usage: UsageStats | undefined;
    let previousResponseId: string | undefined;
    let containerId: string | undefined;
    let currentRequest = providerRequest;
    // Without chaining, each new turn sends local history; tool rounds
    // within this turn still chain (they need the pending calls).
    let shouldPersistConversationState = chainResponsesEnabled();
    // The last provider response has tool calls we never answered (round
    // limit): continuing that chain would 400 with "No tool output found",
    // so the session's chain is cleared and the next turn sends local history.
    let chainHasUnansweredCalls = false;
    let terminalInputRequestId: string | undefined;
    let terminalAwaitingInput = false;

    // Track whether request_user_input was already called this turn.
    // Used to (a) prevent the LLM from calling it again if it hallucinates
    // a second call and (b) skip memory capture after the form is sent.
    let hitlInputSentThisTurn = false;
    // Bounded choice captured on hitlWidgets=false surfaces — rides out on
    // the SendResponse for the channel to render natively. Never set on the
    // widget path (that one suspends instead).
    let pendingNativeChoices: NativeChoices | undefined;

    // Buffered input_request payload — held until the FINAL assistant text
    // has streamed, then flushed alongside state:"final" below. This
    // guarantees the client renders the form AFTER the model's closing
    // message instead of mid-stream (which caused the form to appear
    // before the trailing text).
    type InputRequestStreamEvent = Extract<ClientStreamEvent, { type: "input_request" }>;
    type PendingInputRequestPayload = {
      ws: Record<string, unknown>;
      stream: InputRequestStreamEvent;
      /** The tool call that is waiting for the user. */
      callId: string;
    };
    let pendingInputRequestPayload: PendingInputRequestPayload | null = null;
    const getPendingInputRequestPayload = (): PendingInputRequestPayload | null =>
      pendingInputRequestPayload;

    let round = 0;
    let softBudgetWarned = false;

    // Failover helpers — safe to call even when failover is disabled
    const failoverCfg = deps.failoverConfig;
    const resolveProviderSafe = (id: ProviderId): Provider =>
      deps.resolveProvider?.(id) ?? activeProvider;
    const resolveModelSafe = (id: ProviderId): string =>
      deps.resolveDefaultModel?.(id) ?? deps.defaultModel;

    // Tool names executed this run — persisted to session metadata at the
    // end so the NEXT turn's prompt can be phase-scoped to where the
    // conversation actually is (see buildGatewayReferenceSection).
    const executedToolNames = new Set<string>();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      round++;
      const roundStartTime = Date.now();
      console.log(
        `[runner] llm_round_start run=${runId} user=${redactId(request.userId)} session=${redactId(session.sessionId)} round=${round} model=${currentRequest.model} ` +
          // Prompt-cache diagnosis: providers cache the longest exact prefix,
          // so these should repeat across turns (tools, then instructions).
          `fp_tools=${fingerprint(JSON.stringify(currentRequest.tools ?? []))} ` +
          `fp_instr4k=${fingerprint((currentRequest.instructions ?? "").slice(0, 4000))} ` +
          `fp_instr=${fingerprint(currentRequest.instructions ?? "")} instr_len=${(currentRequest.instructions ?? "").length} ` +
          `chained=${!!currentRequest.conversation?.previousResponseId}`,
      );

      // Check abort signal at the start of each tool round
      if (request.abortSignal?.aborted) {
        console.log(`[runner] Abort signal detected before round ${round} — exiting tool loop`);
        break;
      }

      if (deps.hooks.hasHandlers("before_llm_call")) {
        const llmMods = await deps.hooks.emitWaterfall("before_llm_call", {
          runId,
          userId: request.userId,
          sessionId: session.sessionId,
          round,
          request: currentRequest,
        });
        if (llmMods?.request) {
          currentRequest = { ...currentRequest, ...llmMods.request };
        }
      }

      deps.hooks.emit("llm_call_started", {
        runId,
        userId: request.userId,
        sessionId: session.sessionId,
        round,
        request: currentRequest,
      });

      if (deadline.signal.aborted) throw deadline.signal.reason;
      if (leaseLost) throw new RunLeaseLostError("Run lease lost");
      roundAbort = new AbortController();
      const roundSignal = AbortSignal.any([
        roundAbort.signal,
        deadline.signal,
        ...(request.abortSignal ? [request.abortSignal] : []),
      ]);
      currentRequest = { ...currentRequest, abortSignal: roundSignal };

      let response: ProviderResponse | undefined;

      if (onStream) {
        // -- Streaming path (with failover) --
        let accumulated = "";

        // A stream that drops before its first event is retried once (see
        // llms/stream-retry.ts); after that, a failure reaches the user.
        const requestForRound = currentRequest;
        const rawStreamSource = retryStreamStart(
          () =>
            failoverCfg?.enabled
              ? withFailoverStream(
                  effectiveProviderId,
                  failoverCfg,
                  resolveProviderSafe,
                  resolveModelSafe,
                  requestForRound,
                  (from, to, reason) => {
                    effectiveProviderId = to;
                    onStream({ type: "provider_fallback", fromProvider: from, toProvider: to, reason });
                    deps.hooks.emit("provider_fallback", {
                      runId,
                      userId: request.userId,
                      sessionId: session.sessionId,
                      round,
                      fromProvider: from,
                      toProvider: to,
                      reason,
                    });
                    // Push provider fallback to WebSocket clients
                    if (deps.realtimeEnabled && deps.streamToClient) {
                      sendEventToUser(request.userId, EVENTS.CHAT, {
                        state: "provider_fallback" as const,
                        runId,
                        sessionId: session.sessionId,
                        fromProvider: from,
                        toProvider: to,
                        reason,
                      }).catch(() => {}); // non-fatal
                    }
                  },
                )
              : activeProvider.streamResponse(requestForRound),
          {
            signal: roundSignal,
            onRetry: (err) =>
              console.warn(
                `[runner] stream_retry run=${runId} round=${round}: ${err instanceof Error ? err.message : String(err)}`,
              ),
          },
        );

        // A provider stream that silently stalls mid-generation would
        // otherwise hang this run until the platform kills the function —
        // the user just sees their reply stop. Fail fast instead; the error
        // flows through the normal error path (client gets an error event
        // and can retry) rather than an indefinite spinner.
        const currentRoundAbort = roundAbort;
        const streamSource = withStreamIdleTimeout(
          rawStreamSource,
          PROVIDER_STREAM_IDLE_TIMEOUT_MS,
          (err) => currentRoundAbort.abort(err),
        );

        let realtimePushChain: Promise<void> = Promise.resolve();
        const enqueuePush = (payload: Record<string, unknown>) => {
          realtimePushChain = realtimePushChain
            .then(() => sendEventToUser(request.userId, EVENTS.CHAT, payload))
            .catch((err) => {
              // Non-fatal for the run — the client re-reads the persisted
              // message — but it IS a hole in what the user sees stream, so
              // log it rather than dropping it silently.
              console.warn(
                `[runner] realtime_push_failed run=${runId} state=${String(payload.state)}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        };

        // Coalesce high-frequency delta events into one push per flush
        // window. Without this, every token becomes its own Web PubSub REST
        // call — hundreds per reply — which invites service throttling, and
        // a throttled push chain looks like a frozen stream from the phone.
        // Text deltas carry only the new text plus its `offset` in the reply
        // (not the whole reply so far, which made a reply's pushes O(n²)
        // bytes); a client that sees a gap waits for `final`, which always
        // carries the full text.
        const DELTA_FLUSH_MS = 400;
        let pendingDelta: Record<string, unknown> | null = null;
        let deltaFlushTimer: NodeJS.Timeout | null = null;
        const flushPendingDelta = () => {
          if (deltaFlushTimer) {
            clearTimeout(deltaFlushTimer);
            deltaFlushTimer = null;
          }
          if (pendingDelta) {
            enqueuePush(pendingDelta);
            pendingDelta = null;
          }
        };
        const pushRealtimeEvent = (payload: Record<string, unknown>) => {
          const state = payload.state;
          const coalescable =
            state === "delta" ||
            state === "reasoning_delta" ||
            state === "tool_delta";
          if (!coalescable) {
            // Lifecycle events (tool_start/tool_done/…) must keep their
            // order relative to deltas, so flush before sending.
            flushPendingDelta();
            enqueuePush(payload);
            return;
          }
          if (
            pendingDelta &&
            pendingDelta.state === state &&
            pendingDelta.callId === payload.callId
          ) {
            pendingDelta = {
              ...payload,
              delta: `${String(pendingDelta.delta ?? "")}${String(payload.delta ?? "")}`,
              // The merged text starts where the first merged delta did.
              ...(pendingDelta.offset !== undefined ? { offset: pendingDelta.offset } : {}),
            };
          } else {
            flushPendingDelta();
            pendingDelta = payload;
          }
          deltaFlushTimer ??= setTimeout(flushPendingDelta, DELTA_FLUSH_MS);
        };

        for await (const event of streamSource) {
          // Check abort signal before processing each event
          if (request.abortSignal?.aborted) {
            console.log(`[runner] Abort signal detected during stream — breaking out`);
            break;
          }

          // Map provider stream events to client events
          const clientEvent = mapStreamEvent(event, accumulated);
          if (clientEvent) {
            if (event.type === "text_delta") {
              accumulated += event.delta;
            }
            onStream(clientEvent);
          }

          // Push stream events to WebSocket clients without blocking provider streaming
          if (deps.realtimeEnabled && deps.streamToClient) {
            switch (event.type) {
              case "text_delta":
                pushRealtimeEvent({
                  state: "delta" as const,
                  runId,
                  sessionId: session.sessionId,
                  delta: event.delta,
                  // `accumulated` already includes this delta.
                  offset: accumulated.length - event.delta.length,
                });
                break;

              case "reasoning_delta":
                pushRealtimeEvent({
                  state: "reasoning_delta" as const,
                  runId,
                  sessionId: session.sessionId,
                  delta: event.delta,
                });
                break;

              case "tool_call_start":
                pushRealtimeEvent({
                  state: "tool_start" as const,
                  runId,
                  sessionId: session.sessionId,
                  callId: event.callId,
                  // Use "mcp" toolType when the tool belongs to an MCP server
                  toolType: isMcpTool(event.name ?? "", deps.mcpManager)
                    ? "mcp"
                    : (event.toolType ?? "function"),
                  name: event.name,
                });
                break;

              case "tool_call_delta":
                pushRealtimeEvent({
                  state: "tool_delta" as const,
                  runId,
                  sessionId: session.sessionId,
                  callId: event.callId,
                  delta: event.delta,
                });
                break;

              case "tool_call_done":
                pushRealtimeEvent({
                  state: "tool_done" as const,
                  runId,
                  sessionId: session.sessionId,
                  callId: event.callId,
                });
                break;

              // done / error handled after the loop
            }
          }

          // Capture final response
          if (event.type === "done") {
            response = event.response;
          }

          if (event.type === "error") {
            // Don't leave a coalesced delta pending behind the error — its
            // flush timer would fire after the error handling has already
            // pushed its own frames, arriving out of order at the client.
            flushPendingDelta();
            throw event.error;
          }
        }

        // Some providers end the stream quietly when aborted; a stall or the
        // deadline is still a failure, only the user's stop is not.
        if (roundSignal.aborted && !request.abortSignal?.aborted) {
          throw roundSignal.reason;
        }

        // Drain queued delta pushes before this round ends.
        //
        // `pushRealtimeEvent` chains sends so deltas keep their order relative
        // to each other, but the `final` frame is emitted on its own awaited
        // path further down — so without this a still-pending delta could land
        // AFTER the client has already finalised the message, where it reads
        // as a new round and gets appended to the finished text.
        flushPendingDelta();
        await realtimePushChain;

        // Safety: if we never got a done event (shouldn't happen)
        if (!response) {
          response = {
            providerId: effectiveProviderId,
            responseId: "",
            model,
            text: accumulated,
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: accumulated }],
              },
            ],
            status: "completed",
          };
        }
      } else {
        // -- Non-streaming path (with failover) --
        if (failoverCfg?.enabled) {
          const failoverResult = await withFailover(
            effectiveProviderId,
            failoverCfg,
            resolveProviderSafe,
            resolveModelSafe,
            currentRequest,
          );
          response = failoverResult.result;
          if (failoverResult.failedProviders.length > 0) {
            for (const [index, failed] of failoverResult.failedProviders.entries()) {
              const toProvider =
                index === failoverResult.failedProviders.length - 1
                  ? failoverResult.providerId
                  : failoverResult.failedProviders[index + 1]!.providerId;
              deps.hooks.emit("provider_fallback", {
                runId,
                userId: request.userId,
                sessionId: session.sessionId,
                round,
                fromProvider: failed.providerId,
                toProvider,
                reason: failed.reason,
              });
            }
            effectiveProviderId = failoverResult.providerId;
          }
        } else {
          response = await activeProvider.createResponse(currentRequest);
        }
      }

      // Extract response data
      responseText = response.text;
      responseModel = response.model;
      // A round the user stopped before the provider reported usage adds
      // nothing: an estimate would bill the whole prompt for a reply they
      // cut off before it began. Completed rounds are still billed.
      const roundUsage =
        response.usage || !request.abortSignal?.aborted
          ? resolveRoundUsage(response.usage, currentRequest, response)
          : undefined;
      if (!response.usage && roundUsage) {
        console.warn(
          `[runner] usage_estimated run=${runId} round=${round} model=${responseModel} ` +
            `input=${roundUsage.inputTokens} output=${roundUsage.outputTokens} total=${roundUsage.totalTokens}`,
        );
      }
      usage = mergeUsage(usage, roundUsage);
      usageSoFar = usage;
      modelSoFar = responseModel || model;
      providerSoFar = effectiveProviderId;
      previousResponseId = response.conversationState?.previousResponseId;
      containerId = response.conversationState?.containerId;

      console.log(
        `[runner] llm_round_done run=${runId} round=${round} duration=${Date.now() - roundStartTime}ms model=${responseModel} textChars=${responseText.length} toolCalls=${response.output.filter((item) => item.type === "function_call").length}`,
      );

      deps.hooks.emit("llm_response", {
        runId,
        userId: request.userId,
        sessionId: session.sessionId,
        round,
        response,
        providerId: effectiveProviderId,
        model: responseModel,
      });

      // After a failover, align the request model with the actual provider's
      // model so subsequent tool-call rounds don't send an incompatible model
      // name (e.g., "gpt-5.2" to Anthropic).
      if (responseModel && responseModel !== currentRequest.model) {
        currentRequest = { ...currentRequest, model: responseModel };
      }

      // ----------------------------------------------------------------
      // Check for function calls that need execution
      // ----------------------------------------------------------------
      const functionCalls = response.output.filter(
        (item): item is FunctionCallOutputItem => item.type === "function_call",
      );

      if (functionCalls.length === 0) {
        break;
      }

      // Abort before executing tool calls
      if (request.abortSignal?.aborted) {
        console.log(`[runner] Abort signal detected before tool execution — exiting`);
        break;
      }

      if (round >= maxRounds) {
        // Max rounds exhausted with pending tool calls — warn the user
        const warning =
          "\n\n[Note: I ran out of tool-execution rounds before finishing. Some actions may be incomplete.]";
        responseText = (responseText ?? "") + warning;
        chainHasUnansweredCalls = true;
        break;
      }

      // Execute all function calls in parallel
      const settledToolCalls = await settleToolCalls(
        functionCalls.map((call) => settleToolCall(call, runId, async () => {
          const toolStartTime = Date.now();
          const args = safeParseArgs(call.arguments);
          let result: string;
          // Images a tool returned for the model (browser screenshots); only skill tools return them.
          let images: ToolResultImage[] | undefined;

          // Policy is enforced here, not just on the list the model saw.
          const notOffered = rejectUnofferedToolCall(call.name, offeredToolNames);
          if (notOffered) {
            console.warn(
              `[runner] rejected tool call not offered this turn run=${runId} name=${call.name}`,
            );
            return { callId: call.callId, output: notOffered };
          }

          // Hook: allow blocking tool calls
          if (deps.hooks.hasHandlers("before_tool_call")) {
            const toolMods = await deps.hooks.emitWaterfall("before_tool_call", {
              runId,
              userId: request.userId,
              sessionId: session.sessionId,
              round,
              name: call.name,
              callId: call.callId,
              args,
            });
            if (toolMods?.block) {
              result = toolMods.blockReason ?? "Tool call blocked by hook.";
              return { callId: call.callId, output: result };
            }
          }

          // Resolve tool type — "mcp" for MCP tools, "function" otherwise
          const resolvedToolType = isMcpTool(call.name, deps.mcpManager)
            ? "mcp"
            : "function";

          deps.hooks.emit("tool_call_started", {
            runId,
            userId: request.userId,
            sessionId: session.sessionId,
            round,
            name: call.name,
            callId: call.callId,
            args,
          });

          // Emit tool_start (execution phase) — only when NOT streaming.
          // The streaming path already emitted tool_call_start during the
          // model's tool_call streaming; re-emitting here would create a
          // duplicate event for the same logical call on the client.
          if (!onStream) {
            // Non-streaming providers don't emit stream events, so the
            // execution phase is the only place clients learn the tool started.
            if (deps.realtimeEnabled && deps.streamToClient) {
              sendEventToUser(request.userId, EVENTS.CHAT, {
                state: "tool_start" as const,
                runId,
                sessionId: session.sessionId,
                callId: call.callId,
                toolType: resolvedToolType,
                name: call.name,
              }).catch(() => {}); // non-fatal
            }
          }

          if (isCronTool(call.name)) {
            result = await cronHandler.handle(call.name, args, request.userId, {
              channelName: request.channelName,
              channelChatId: request.channelChatId,
            });
          } else if (isPromptTool(call.name)) {
            result = await promptHandler.handle(
              call.name,
              args,
              request.userId,
              request.agentId ?? "default",
            );
          } else if (isEpisodeTool(call.name) && episodeHandler) {
            result = await episodeHandler.handle(
              call.name,
              args,
              request.userId,
              session.sessionId,
              effectiveUserTimezone,
            );
          } else if (isWebTool(call.name) && webHandler) {
            result = await webHandler.handle(call.name, args, request.userId, session.sessionId);
          } else if (skillHandler && skillHandler.isSkillTool(call.name)) {
            ({ output: result, images } = await skillHandler.handleWithImages(call.name, args, request.userId));
          } else if (isDigestTool(call.name) && digestHandler) {
            result = await digestHandler.handle(call.name, args, request.userId);
          } else if (isKnowledgeTool(call.name) && deps.knowledgeLayer) {
            result = await deps.knowledgeLayer.handleToolCall(call.name, args);
          } else if (isRequestUserInputTool(call.name) && request.hitlWidgets === false) {
            // ── request_user_input, channel variant ──
            // No widgets to push and no suspend/resume: capture the options
            // onto the response for the channel to render natively (WhatsApp
            // reply buttons / list). The model ends its turn with the
            // question line; the user's tap arrives as the next inbound
            // message carrying the tapped label.
            if (hitlInputSentThisTurn) {
              result = JSON.stringify({
                error: true,
                message: "Only one request_user_input call is allowed per turn. Ask this choice in your next turn, after the user answers the one already presented.",
              });
            } else {
              const rawOptions = Array.isArray(args.options)
                ? (args.options as Array<{ label?: unknown; value?: unknown; description?: unknown }>)
                : [];
              const options = rawOptions
                .filter((o) => typeof o.label === "string" && o.label.trim() && typeof o.value === "string")
                .map((o) => ({
                  id: o.value as string,
                  title: (o.label as string).trim(),
                  ...(typeof o.description === "string" && o.description.trim()
                    ? { description: o.description.trim() }
                    : {}),
                }));
              if (options.length < 2 || options.length > 10) {
                result = JSON.stringify({
                  error: true,
                  message: "request_user_input needs 2-10 options on this surface. For anything open-ended, ask in plain text instead.",
                });
              } else {
                pendingNativeChoices = {
                  options,
                  ...(typeof args.title === "string" && args.title.trim()
                    ? { listButton: args.title.trim() }
                    : {}),
                };
                hitlInputSentThisTurn = true;
                result = JSON.stringify({
                  presented: true,
                  message:
                    "The options will be attached to your final message as native tappable choices. End your turn NOW with ONE short line asking the question — do not list the options in it, the user sees them as buttons. The user's selection arrives as their next message.",
                });
              }
            }
          } else if (isRequestUserInputTool(call.name)) {
            // ── request_user_input: LLM explicitly requests user input ──
            // Push the form to the client and pause this turn. The user's
            // picker submission resumes this exact provider response later as
            // a real function_call_output using the saved callId.
            //
            // Guard: only allow one request_user_input per turn.
            if (hitlInputSentThisTurn) {
              result = JSON.stringify({
                error: true,
                message: "Only one request_user_input call is allowed per turn. Wait for the user's response before requesting more input.",
              });
            } else {
            const hitlRequestId = randomUUID();
            const formType = (args.type as string) ?? "text_input";

            const inputPayload = {
              state: "input_request" as const,
              requestId: hitlRequestId,
              runId,
              sessionId: session.sessionId,
              toolName: REQUEST_USER_INPUT_TOOL_NAME,
              toolCallId: call.callId,
              intent: (args.subtitle as string) ?? "",
              proposedArgs: (args.proposedData as Record<string, unknown>) ?? {},
              formType,
              formName: (args.title as string) ?? undefined,
              options: Array.isArray(args.options) ? (args.options as Array<{ label: string; value: string; description?: string }>) : undefined,
              schema: (args.schema as Record<string, unknown>) ?? undefined,
              uiHints: (args.uiHints as Record<string, unknown>) ?? undefined,
              timeoutSeconds: loadHitlConfig().defaultTimeoutSeconds,
            };

            // Buffer the form push — flushed AFTER the final assistant
            // text has streamed, so the client renders text first, form
            // last. (Previously emitted immediately, which raced with the
            // model's closing message and made the form appear mid-stream.)
            pendingInputRequestPayload = {
              callId: call.callId,
              ws: inputPayload as unknown as Record<string, unknown>,
              stream: {
                type: "input_request",
                requestId: hitlRequestId,
                toolName: REQUEST_USER_INPUT_TOOL_NAME,
                intent: inputPayload.intent,
                proposedArgs: inputPayload.proposedArgs as Record<string, unknown>,
                formType: inputPayload.formType as InputRequest["formType"],
                formName: inputPayload.formName,
                options: inputPayload.options,
                schema: inputPayload.schema,
                uiHints: inputPayload.uiHints as Record<string, unknown> | undefined,
                timeoutSeconds: inputPayload.timeoutSeconds,
              },
            };

            if (deps.hitlStore) {
              const runState: HitlRunState = {
                requestId: hitlRequestId,
                orchestrationId: `direct-${hitlRequestId}`,
                originalRequest: serializeSendRequest(request),
                runId,
                sessionId: session.sessionId,
                toolRound: round,
                pendingToolCall: {
                  callId: call.callId,
                  name: REQUEST_USER_INPUT_TOOL_NAME,
                  arguments: args,
                },
                completedToolResults: [],
                independentToolCalls: [],
                conversationState: {
                  previousResponseId,
                  containerId,
                },
                providerId: effectiveProviderId,
                model: responseModel || model,
                usage: usage as Record<string, unknown> | undefined,
                createdAt: Date.now(),
                status: "pending",
                timeoutSeconds: inputPayload.timeoutSeconds,
              };
              await deps.hitlStore.create(runState);
            }

            hitlInputSentThisTurn = true;
            result = JSON.stringify({
              sent: true,
              formType,
              message: "Form sent. End your turn now with a short, friendly message. Do NOT repeat field names, form structure, or internal details — the user already sees the form. Do NOT call request_user_input again this turn.",
            });
            } // end of else (guard)
          } else if (isMcpTool(call.name, deps.mcpManager) && deps.mcpManager) {
            // ── HITL Gate: check if this tool needs human input ──
            const hitlPolicy = getHitlPolicy(call.name);
            const mcpTool = deps.mcpManager.getAllTools().find((t) => t.name === call.name);
            const toolSchema = mcpTool?.inputSchema;

            const gateAction = hitlGateAction(
              Boolean(hitlPolicy && shouldGate(hitlPolicy, args, toolSchema)),
              Boolean(deps.hitlStore && request._invocationContext),
            );

            if (gateAction === "suspend" && hitlPolicy && deps.hitlStore) {
              // Save run state, start Durable orchestrator, and suspend.
              // The Azure Function exits; the orchestrator waits (zero cost)
              // for the user to respond, then resumes in a new invocation.
              const hitlRequestId = randomUUID();
              const hitlTimeoutSeconds = hitlPolicy.timeoutSeconds ?? loadHitlConfig().defaultTimeoutSeconds;
              const inputRequest: InputRequest = {
                requestId: hitlRequestId,
                runId,
                sessionId: session.sessionId,
                userId: request.userId,
                toolName: call.name,
                toolCallId: call.callId,
                intent: resolveIntent(hitlPolicy, args),
                proposedArgs: args,
                formType: hitlPolicy.formType ?? hitlPolicy.resolvedForm?.formType ?? "form",
                formName: hitlPolicy.formName,
                options: resolveOptions(hitlPolicy, args),
                schema: resolveSchema(hitlPolicy, toolSchema),
                uiHints: hitlPolicy.uiHints,
                timeoutSeconds: hitlTimeoutSeconds,
              };

              // Persist state so it survives across function invocations
              const runState: HitlRunState = {
                requestId: hitlRequestId,
                orchestrationId: `hitl-${hitlRequestId}`,
                originalRequest: serializeSendRequest(request),
                runId,
                sessionId: session.sessionId,
                toolRound: round,
                pendingToolCall: {
                  callId: call.callId,
                  name: call.name,
                  arguments: args,
                },
                completedToolResults: [],
                independentToolCalls: [],
                conversationState: {
                  previousResponseId,
                  containerId,
                },
                providerId: effectiveProviderId,
                model: responseModel || model,
                usage: usage as Record<string, unknown> | undefined,
                createdAt: Date.now(),
                status: "pending",
                timeoutSeconds: hitlTimeoutSeconds,
              };

              await deps.hitlStore.create(runState);

              // Start the Durable Functions orchestrator (fire-and-forget)
              const dfModule = await import("durable-functions");
              const durableClient = dfModule.getClient(request._invocationContext!);
              await durableClient.startNew(HITL_ORCHESTRATION_NAME, {
                instanceId: runState.orchestrationId,
                input: {
                  inputRequest,
                  requestId: hitlRequestId,
                  userId: request.userId,
                  timeoutSeconds: hitlTimeoutSeconds,
                },
              });

              // Notify the stream listener
              onStream?.({
                type: "input_request",
                requestId: hitlRequestId,
                toolName: call.name,
                intent: inputRequest.intent,
                proposedArgs: args,
                formType: inputRequest.formType,
                formName: inputRequest.formName,
                options: inputRequest.options,
                schema: inputRequest.schema,
                uiHints: hitlPolicy.uiHints,
                timeoutSeconds: inputRequest.timeoutSeconds,
              });

              // Persist the user's message to the session BEFORE suspending,
              // using the shared SessionStore (same module that handles all
              // session persistence in Step 8 of this pipeline).
              //
              // We intentionally do NOT pass conversationState here. The
              // session retains its existing conversationState (from the
              // last fully-completed run). The current run's LLM response—
              // which generated the HITL tool call—has pending unresolved
              // tool calls; saving its previousResponseId would leave a
              // broken Responses API chain. The resume path in the
              // orchestrator clears conversationState before continuing,
              // forcing the runner to send full conversation history.
              try {
                const storedContent = buildStoredUserContent(
                  request.message,
                  imageAttachments?.length ?? 0,
                  extractedDocuments,
                  nativeDocuments,
                  deps.attachmentConfig?.maxTotalDocumentChars ?? 60_000,
                );
                await deps.sessionStore.appendMessages(
                  request.userId,
                  session.sessionId,
                  [
                    {
                      role: "user",
                      content: storedContent,
                      timestamp: new Date().toISOString(),
                      idempotencyKey: request.idempotencyKey,
                      channelName: request.channelName,
                    },
                  ],
                );
                userMessagePersisted = true;
              } catch {
                // Non-fatal — if this fails the session just won't have
                // the user message, but everything else still works
              }

              // Throw suspend signal — caught by the outer try/catch
              // to return an "awaiting_input" response instead of "failed"
              throw new HitlSuspendSignal(
                hitlRequestId,
                session.sessionId,
                responseText ?? "I need some information from you before I can continue. Please fill in the form.",
                usage,
              );
            }

            if (gateAction === "deny") {
              console.warn(
                `[runner] hitl gate cannot suspend here, refusing run=${runId} name=${call.name} channel=${request.channelName ?? "none"}`,
              );
              result = HITL_APPROVAL_UNAVAILABLE;
            } else {
              // No HITL gate — execute immediately
              result = await handleMcpToolCall(call.name, args, deps.mcpManager, request.userId, {
                channelName: request.channelName,
                channelChatId: request.channelChatId,
              });
            }
          } else {
            // Memory tools (or unknown — memory handler returns an error for unknowns)
            result = await deps.memory.handleToolCall(
              call.name,
              args,
              request.userId,
            );
          }

          // Emit tool_done (execution phase)
          onStream?.({
            type: "tool_done",
            callId: call.callId,
          });

          // Push execution-phase tool_done to WebSocket clients
          if (deps.realtimeEnabled && deps.streamToClient) {
            sendEventToUser(request.userId, EVENTS.CHAT, {
              state: "tool_done" as const,
              runId,
              sessionId: session.sessionId,
              callId: call.callId,
            }).catch(() => {}); // non-fatal
          }

          deps.hooks.emit("after_tool_call", {
            runId,
            userId: request.userId,
            sessionId: session.sessionId,
            round,
            name: call.name,
            callId: call.callId,
            args,
            result,
          });

          console.log(
            `[runner] tool_call_done run=${runId} round=${round} name=${call.name} callId=${call.callId} duration=${Date.now() - toolStartTime}ms`,
          );
          executedToolNames.add(call.name);

          return { callId: call.callId, output: result, ...(images?.length ? { images } : {}) };
        })),
      );

      // A gated call suspends the run for approval. Keep the results of the
      // other calls from the same response (those done within the grace
      // period) with the paused request, so the resume writes them into the
      // history instead of the model calling them again.
      const suspension = findSuspension(settledToolCalls, functionCalls);
      if (suspension) {
        const { signal, siblingResults } = suspension;
        if (siblingResults.length > 0 && deps.hitlStore) {
          await deps.hitlStore
            .setCompletedToolResults(signal.requestId, request.userId, siblingResults)
            .catch((e) => console.warn(`[runner] hitl sibling results not saved run=${runId}: ${e instanceof Error ? e.message : String(e)}`));
        }
        throw signal;
      }
      const failedToolCall = settledToolCalls.find((r): r is PromiseRejectedResult => r?.status === "rejected");
      if (failedToolCall) throw failedToolCall.reason;
      // With no suspension every call has settled.
      const toolResults = settledToolCalls.map((r) => (r as PromiseFulfilledResult<ToolCallResult>).value);

      const terminalInputRequestPayload = getPendingInputRequestPayload();
      if (terminalInputRequestPayload) {
        terminalAwaitingInput = true;
        terminalInputRequestId = terminalInputRequestPayload.stream.requestId;
        shouldPersistConversationState = false;
        // The resume continues from the response that asked for input, which
        // may also hold other calls; the provider needs every output.
        const siblingResults = toolResults.filter(
          (r) => r.callId !== terminalInputRequestPayload.callId,
        );
        if (siblingResults.length > 0 && deps.hitlStore) {
          await deps.hitlStore
            .setCompletedToolResults(terminalInputRequestId, request.userId, siblingResults)
            .catch((err) =>
              console.warn(
                `[runner] hitl_sibling_results_not_saved run=${runId}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }
        if (!responseText.trim()) {
          responseText = "I need one detail before I can continue.";
        }
        console.log(
          `[runner] input_request_terminal run=${runId} round=${round} requestId=${terminalInputRequestId} duration=${Date.now() - startTime}ms`,
        );
        break;
      }

      // Build the next request with tool results fed back.
      // FunctionCallOutput[] is a valid ProviderRequest.input variant.
      const functionCallOutputs: FunctionCallOutput[] = toolResults.map(
        (r) => ({
          type: "function_call_output" as const,
          callId: r.callId,
          output: r.output,
          ...(r.images ? { images: r.images } : {}),
        }),
      );

      // Soft tool budget: one model-visible note when the configured soft
      // threshold is reached, so the model converges instead of being cut
      // off at maxRounds with the mid-flow "[Note: I ran out...]" warning.
      if (
        applySoftBudgetWarning(functionCallOutputs, {
          round,
          maxRounds,
          softBudget: deps.toolBudget?.soft,
          alreadyWarned: softBudgetWarned,
        })
      ) {
        softBudgetWarned = true;
        console.log(
          `[runner] soft_tool_budget_warned run=${runId} round=${round} maxRounds=${maxRounds}`,
        );
      }

      // Latency optimisation: if every tool call this round was
      // `request_user_input`, the next round is just an acknowledgement of
      // the user's form submission — it doesn't need deep reasoning. Drop
      // reasoning effort to "low" for that round to cut first-token
      // latency on reasoning models (gpt-5*). Note: gpt-5.4-mini does NOT
      // accept "minimal" — only none|low|medium|high|xhigh — so "low" is
      // the safest minimum across the gpt-5 family.
      const allHitlAcks =
        functionCalls.length > 0 &&
        functionCalls.every((c) => isRequestUserInputTool(c.name));
      const nextReasoning = allHitlAcks
        ? ({ effort: "low" as const, summary: "auto" as const })
        : resolvedReasoningEffort
          ? { effort: resolvedReasoningEffort, summary: "auto" as const }
          : undefined;

      currentRequest = {
        ...currentRequest,
        input: functionCallOutputs,
        // Tool rounds continue this turn's response on the provider that made it.
        failoverInput: undefined,
        tools: functionTools,
        reasoning: nextReasoning,
        conversation: {
          ...currentRequest.conversation,
          previousResponseId:
            response.conversationState?.previousResponseId ??
            previousResponseId,
          containerId: response.conversationState?.containerId ?? containerId,
          // For Anthropic: carry forward the assistant message (with tool_use blocks)
          messages: response.conversationState?.messages,
        },
      };
    }
    markPhase("llm_tool_loop");

    // ----------------------------------------------------------------
    // Abort short-circuit
    // ----------------------------------------------------------------
    // If the user clicked stop, do not persist the partial response,
    // auto-capture memories, or emit a final event. The client already
    // receives an explicit "aborted" realtime event and may have kept any
    // partial text locally.
    if (request.abortSignal?.aborted) {
      const abortedResponse: SendResponse = {
        runId,
        text: responseText,
        sessionId: session.sessionId,
        identity: assembled.identity,
        providerId: effectiveProviderId,
        model: responseModel,
        usage,
        memoriesRecalled,
        memoryCaptured: false,
        durationMs: Date.now() - startTime,
        status: "aborted",
      };
      // The rounds finished before the stop spent real tokens.
      await recordUsage(session.sessionId, usage, effectiveProviderId, responseModel);
      // Still a terminal exit — listeners (notably credit settlement) must
      // run or the run's reservation stays open.
      await deps.hooks.emit("run_completed", {
        runId,
        userId: request.userId,
        response: abortedResponse,
        units,
      });
      return abortedResponse;
    }

    // ----------------------------------------------------------------
    // Step 7: Auto-capture memories from the exchange
    // ----------------------------------------------------------------
    let memoryCaptured = false;

    if (deps.autoCapture && responseText && !isContinuation && !terminalAwaitingInput) {
      try {
        const captured = await deps.memory.capture(
          request.message,
          request.userId,
          session.sessionId,
        );
        if (captured) {
          memoryCaptured = true;
          onStream?.({ type: "memory_captured", text: request.message });
          deps.hooks.emit("memory_captured", {
            userId: request.userId,
            text: request.message,
            captured: true,
          });
        }
      } catch {
        // Memory capture failure is non-fatal
      }
    }

    // ----------------------------------------------------------------
    // Step 8: Persist session with new messages
    // ----------------------------------------------------------------
    const now = new Date().toISOString();

    // Store text-only content for user messages — base64 image data is
    // transient, but extracted document text is kept so follow-up questions
    // about an attached document still have something to work from.
    const storedUserContent = buildStoredUserContent(
      request.message,
      imageAttachments?.length ?? 0,
      extractedDocuments,
      nativeDocuments,
      deps.attachmentConfig?.maxTotalDocumentChars ?? 60_000,
    );

    // In continuation mode (HITL resume), the user's original message was
    // already saved during the suspend path and the tool result was saved by
    // the orchestrator. Only persist the assistant's LLM response — no
    // synthetic user message pollutes the session.
    const newMessages: SessionMessage[] = isContinuation
      ? [
          {
            role: "assistant",
            content: responseText,
            timestamp: new Date().toISOString(),
            providerId: effectiveProviderId,
            model: responseModel,
            usage,
            runId,
            channelName: request.channelName,
          },
        ]
      : [
          {
            role: "user",
            content: storedUserContent,
            timestamp: now,
            idempotencyKey: request.idempotencyKey,
            channelName: request.channelName,
          },
          {
            role: "assistant",
            content: responseText,
            timestamp: new Date().toISOString(),
            providerId: effectiveProviderId,
            model: responseModel,
            usage,
            runId,
            channelName: request.channelName,
          },
        ];

    // Build session metadata update for channel state.
    // For push/web channel, use userId as the "chat ID" since Web PubSub
    // routes by userId. This ensures lastChannelResolver and
    // resolveTargetFromSessionMetadata can find push sessions.
    const effectiveChatId =
      request.channelChatId ??
      (request.channelName === "push" ? request.userId : undefined);
    // Tool names from this run ride along so the next turn's gateway can be
    // phase-scoped to where the conversation actually is. Written every run
    // that called tools; an empty run leaves the previous value standing.
    const gatewayToolsMetadata: Record<string, string> | undefined =
      executedToolNames.size > 0
        ? { gatewayToolsLastRun: [...executedToolNames].join(",") }
        : undefined;
    const channelMetadata: Record<string, string> | undefined =
      request.channelName || gatewayToolsMetadata
        ? {
            ...(request.channelName
              ? {
                  lastChannelName: request.channelName,
                  ...(effectiveChatId ? { lastChatId: effectiveChatId } : {}),
                }
              : {}),
            ...(gatewayToolsMetadata ?? {}),
          }
        : undefined;

    const updatedSession = await deps.sessionStore.appendMessages(
      request.userId,
      session.sessionId,
      newMessages,
      terminalAwaitingInput || chainHasUnansweredCalls
        ? null
        : shouldPersistConversationState && (previousResponseId || containerId)
          ? { previousResponseId, containerId }
          : shouldPersistConversationState && hasPreviousResponseChain
            ? // The chain wasn't extended (failover answered with a provider
              // that doesn't chain): clear it, or the next turn would chain
              // from before this one and the model would never see it. The
              // code-interpreter container is kept.
              { previousResponseId: undefined, containerId: conversationStateForRequest?.containerId }
            : undefined,
      channelMetadata,
      session.instanceId,
      leaseId,
      session.lastCompactedSeq ?? 0,
    );
    userMessagePersisted = true;
    markPhase("persist");
    deps.hooks.emit("message_persisted", {
      sessionId: session.sessionId,
      messageCount: newMessages.length,
    });

    if (directHitlRunState && deps.hitlStore) {
      await deps.hitlStore.updateStatus(
        directHitlRunState.requestId,
        request.userId,
        request.hitlInputResponse?.cancelled ? "cancelled" : "responded",
      );
    }

    // ----------------------------------------------------------------
    // Step 8b: Trigger compaction if threshold exceeded (fire-and-forget)
    // ----------------------------------------------------------------
    const sessionConfig = deps.sessionStore.getConfig();
    if (shouldCompact(updatedSession, sessionConfig)) {
      deps.hooks.emit("before_compaction", { session: updatedSession });
      const compactionFromSeq = updatedSession.lastCompactedSeq ?? 0;
      const compactionRetainBoundary = updatedSession.messageSeq - sessionConfig.compactionRetainCount;
      runCompaction({
        session: updatedSession,
          provider: deps.provider,
        model: sessionConfig.compactionModel,
        sessionStore: deps.sessionStore,
        messageStore: deps.sessionStore.getMessageStore(),
        config: sessionConfig,
        memoryLayer: deps.memory,
      }).then(() => {
        deps.hooks.emit("after_compaction", {
          session: updatedSession,
          summary: "(auto-compacted)",
          compactedCount: Math.max(0, compactionRetainBoundary - compactionFromSeq),
        });
      }).catch(() => {}); // Non-fatal — don't block the response

      // Note: Episode generation removed — episodes are now managed by the
      // LLM via tools (episode_create, episode_update), not by background processes.
    }

    // ----------------------------------------------------------------
    // Step 8c: Record usage (fire-and-forget)
    // ----------------------------------------------------------------
    const usageRecordPromise = recordUsage(session.sessionId, usage, effectiveProviderId, responseModel);

    // ----------------------------------------------------------------
    // Step 9: Push final response to WebSocket clients
    // ----------------------------------------------------------------
    if (deps.realtimeEnabled) {
      try {
        console.log(
          `[runner] final_emit_start run=${runId} status=${terminalAwaitingInput ? "awaiting_input" : "completed"} duration=${Date.now() - startTime}ms`,
        );
        await sendEventToUser(request.userId, EVENTS.CHAT, {
          state: "final" as const,
          runId,
          sessionId: session.sessionId,
          text: responseText,
          providerId: effectiveProviderId,
          model: responseModel,
          usage,
          durationMs: Date.now() - startTime,
        });
        console.log(
          `[runner] final_emit_done run=${runId} duration=${Date.now() - startTime}ms`,
        );
      } catch {
        // WebSocket push failure is non-fatal
      }
    }
    markPhase("final_emit");

    console.log(
      `[runner] timings run=${runId} user=${redactId(request.userId)} session=${redactId(session.sessionId)} ` +
        `total=${Date.now() - startTime}ms ${phaseTimings.join(" ")}`,
    );

    // ----------------------------------------------------------------
    // Step 10: Build and return SendResponse
    // ----------------------------------------------------------------
    const sendResponse: SendResponse = {
      runId,
      text: responseText,
      sessionId: session.sessionId,
      identity: assembled.identity,
      providerId: effectiveProviderId,
      model: responseModel,
      usage,
      memoriesRecalled,
      memoryCaptured,
      durationMs: Date.now() - startTime,
      status: terminalAwaitingInput ? "awaiting_input" : "completed",
      ...(terminalInputRequestId ? { hitlRequestId: terminalInputRequestId } : {}),
      ...(pendingNativeChoices ? { nativeChoices: pendingNativeChoices } : {}),
    };

    if (usageRecordPromise) {
      await usageRecordPromise;
    }
    await deps.hooks.emit("run_completed", {
      runId,
      userId: request.userId,
      response: sendResponse,
      units,
    });

    // Flush any buffered request_user_input AFTER the final text emit and
    // AFTER run_completed has settled. Two reasons for this position:
    //   1. The client defers form rendering until stream end, so emitting
    //      the form payload here shows the user text first, form last.
    //   2. Answering an input_request starts a *new* run, which takes a new
    //      coin reservation. Settling this run first (run_completed above)
    //      guarantees the balance is released before the client can reply —
    //      otherwise the answer races the settle and gets a false
    //      "out of credits".
    const inputRequestPayloadToFlush = getPendingInputRequestPayload();
    if (inputRequestPayloadToFlush) {
      const buffered = inputRequestPayloadToFlush;
      pendingInputRequestPayload = null;
      if (deps.realtimeEnabled) {
        try {
          console.log(
            `[runner] input_request_emit_start run=${runId} requestId=${buffered.stream.requestId} duration=${Date.now() - startTime}ms`,
          );
          await sendEventToUser(
            request.userId,
            EVENTS.CHAT,
            buffered.ws,
          );
          console.log(
            `[runner] input_request_emit_done run=${runId} requestId=${buffered.stream.requestId} duration=${Date.now() - startTime}ms`,
          );
        } catch {
          // Non-fatal — onStream below also carries the event
        }
      }
      onStream?.(buffered.stream);
    }

    onStream?.({ type: "done", response: sendResponse });

    return sendResponse;
  } catch (err) {
    // ── HITL Suspend: not an error — the runner is pausing for human input ──
    if (err instanceof HitlSuspendSignal) {
      const suspendResponse: SendResponse = {
        runId,
        text: err.text,
        sessionId: err.sessionId,
        identity: { name: "Assistant" },
        providerId: activeProvider.id,
        model,
        usage: err.usage,
        memoriesRecalled: 0,
        memoryCaptured: false,
        durationMs: Date.now() - startTime,
        status: "awaiting_input",
        hitlRequestId: err.requestId,
      };

      // Settle first: once the client sees a terminal state it is free to
      // start the next run, which needs a fresh coin reservation. Releasing
      // this run's reservation before that point keeps the next run from
      // racing the settle and failing with a false "out of coins".
      await deps.hooks.emit("run_completed", {
        runId,
        userId: request.userId,
        response: suspendResponse,
        units,
      });

      // Push a "waiting for input" state to the client so it knows
      // the run is not failed — it's paused.
      if (deps.realtimeEnabled) {
        try {
          await sendEventToUser(request.userId, EVENTS.CHAT, {
            state: "final" as const,
            runId,
            sessionId: err.sessionId,
            text: err.text,
            providerId: activeProvider.id,
            model,
            durationMs: Date.now() - startTime,
          });
        } catch {
          // Non-fatal
        }
      }

      onStream?.({ type: "done", response: suspendResponse });
      return suspendResponse;
    }

    // A provider aborted by the deadline or a stall throws a generic
    // AbortError; report why it was aborted instead.
    if (!request.abortSignal?.aborted) {
      if (deadline.signal.aborted) err = deadline.signal.reason;
      else if (roundAbort?.signal.aborted) err = roundAbort.signal.reason;
    }

    const errorMessage = err instanceof Error ? err.message : String(err);
    const statusCode = (err as any)?.status ?? (err as any)?.statusCode ?? "n/a";
    if (err instanceof SessionBusyError) {
      // Expected under double-sends and retries; not a failure of the system.
      console.log(`[runner] session_busy run=${runId} user=${redactId(request.userId)}`);
    } else {
      console.error(
        `[runner] runAgentTurn FAILED — runId=${runId}, user=${redactId(request.userId)}, ` +
          `provider=${activeProvider.id}, model=${model}, status=${statusCode}, ` +
          `duration=${Date.now() - startTime}ms, error=${errorMessage}`,
      );
      if (err instanceof Error && err.stack) {
        console.error(`[runner] stack:`, err.stack);
      }
    }

    const errorResponse: SendResponse = {
      runId,
      text: "",
      sessionId: request.sessionId ?? "",
      identity: { name: "Assistant" },
      providerId: activeProvider.id,
      model: modelSoFar ?? model,
      usage: usageSoFar,
      memoriesRecalled: 0,
      memoryCaptured: false,
      durationMs: Date.now() - startTime,
      status: "failed",
      error: errorMessage,
    };
    if (err instanceof SessionBusyError) {
      // A refusal the user should read, not a failure.
      errorResponse.error = err.code;
      errorResponse.text = err.message;
    }

    const failure =
      err instanceof SessionBusyError
        ? { code: "session_busy", message: err.message, retryable: true }
        : err instanceof RunLeaseLostError
          ? { code: "interrupted", message: "This reply was interrupted. Please send your message again.", retryable: true }
          : classifyRunFailure(err);

    // Keep the user's message in the history even though the reply failed
    // (with a background turn, the client may have nothing else to show),
    // plus a note so the next turn knows. The provider chain is cleared: it
    // doesn't contain these, local history does. Not for busy refusals (this
    // run never owned the session) or internal continuation prompts.
    if (
      leasedSessionId &&
      !userMessagePersisted &&
      !(err instanceof SessionBusyError) &&
      !(err instanceof RunLeaseLostError) && // another execution owns the session now
      !(err instanceof SessionReplacedError) && // /new started a fresh conversation
      request.metadata?._hitlContinuation !== "true" &&
      !request.abortSignal?.aborted
    ) {
      const now = new Date().toISOString();
      await deps.sessionStore
        .appendMessages(
          request.userId,
          leasedSessionId,
          [
            { role: "user", content: request.message, timestamp: now, channelName: request.channelName },
            { role: "assistant", content: `(This reply failed before it finished: ${failure.code}.)`, timestamp: now },
          ],
          null,
          undefined,
          // Same guards as a normal save: never into a replaced session, or
          // one another execution now holds.
          leasedInstanceId,
          leaseId,
        )
        .catch((persistErr) =>
          console.warn(
            `[runner] failed turn not saved run=${runId}: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          ),
        );
    }
    // Refusals and interruptions are expected under double-sends and scale-in;
    // only real failures are logged as errors (the errors alert counts them).
    const expected = err instanceof SessionBusyError || err instanceof RunLeaseLostError;
    (expected ? console.log : console.error)(
      `[runner] run_failed_classified run=${runId} code=${failure.code} retryable=${failure.retryable}`,
    );

    // A scheduled run that found the session busy retries later; the user
    // didn't send anything, so there's nothing to tell them.
    const silent = err instanceof SessionBusyError && (request.scheduled || err.duplicate);
    if (deps.realtimeEnabled && !silent) {
      try {
        await sendEventToUser(request.userId, EVENTS.CHAT, {
          state: "error" as const,
          runId,
          sessionId: request.sessionId,
          error: failure.message,
          code: failure.code,
          retryable: failure.retryable,
        });
      } catch {
        // WebSocket push failure is non-fatal
      }
    }

    // Not when another execution owns the run now: it records the run
    // (one record per runId), and this one would take its place.
    if (!(err instanceof RunLeaseLostError) && !(err instanceof SessionBusyError)) {
      await recordUsage(leasedSessionId ?? request.sessionId ?? "", usageSoFar, providerSoFar, modelSoFar);
    }
    await deps.hooks.emit("run_failed", {
      runId,
      userId: request.userId,
      sessionId: request.sessionId,
      error: err instanceof Error ? err : new Error(errorMessage),
      usage: usageSoFar,
      model: modelSoFar ?? model,
      units,
    });
    onStream?.({
      type: "error",
      error: err instanceof Error ? err : new Error(errorMessage),
    });

    return errorResponse;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    clearTimeout(deadlineTimer);
    if (leaseRenewal) clearInterval(leaseRenewal);
    if (leasedSessionId) {
      await deps.sessionStore
        .releaseRunLease(request.userId, leasedSessionId, leaseId)
        .catch((err) =>
          console.warn(
            `[runner] run lease not released run=${runId} (expires on its own): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }
}

/**
 * Turn a thrown run failure into something the user can act on.
 *
 * The error frame used to carry a fixed "Request failed. Please retry." for
 * every cause, so a rate limit, an unreachable provider and an over-long
 * conversation were indistinguishable in the app — the only real detail lived
 * in the server log, where the user cannot see it.
 *
 * The message stays user-safe (no provider names, model ids, status codes or
 * stack traces — those remain in the log) while saying enough to choose
 * between waiting, retrying, and starting a new chat. `retryable` is the part
 * the UI acts on: offering "try again" for a failure that will fail the same
 * way every time is worse than saying so plainly.
 */
/**
 * Whether nobody is waiting on this run: a cron session, or a job or
 * heartbeat delivered into the user's session. A resumed HITL run is also
 * sent with `scheduled` (for delivery), but the user has just answered it.
 */
export function isScheduledRun(
  request: { scheduled?: boolean; metadata?: Record<string, string> },
  sessionType: string,
): boolean {
  return sessionType === "cron" || (request.scheduled === true && request.metadata?._hitlContinuation !== "true");
}

/**
 * Soft tool-round budget: when `round` has reached `softBudget`, append a
 * one-time convergence note to the LAST tool output of the round.
 *
 * Appended to a tool output rather than sent as its own message because a
 * bare message cannot ride alongside function_call_output items on every
 * provider. Returns whether the note was applied; the caller records that
 * so the note fires once per run. A budget the runtime enforces cannot
 * contradict the workflow instructions the way a prose round-target can —
 * which is why this exists instead of a sentence in the prompt.
 */
export function applySoftBudgetWarning(
  outputs: Array<{ output: string }>,
  opts: {
    round: number;
    maxRounds: number;
    softBudget: number | undefined;
    alreadyWarned: boolean;
  },
): boolean {
  const { round, maxRounds, softBudget, alreadyWarned } = opts;
  if (softBudget === undefined || alreadyWarned) return false;
  if (round < softBudget || outputs.length === 0) return false;
  const roundsLeft = Math.max(maxRounds - round, 1);
  const last = outputs[outputs.length - 1];
  last.output = `${last.output}\n\n[system: ${round} tool rounds used; ${roundsLeft} remain before a hard stop. Converge — finish with the fewest remaining calls and reply to the user.]`;
  return true;
}

export function classifyRunFailure(err: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  const status = Number(
    (err as { status?: unknown })?.status ??
      (err as { statusCode?: unknown })?.statusCode ??
      0,
  );
  const raw = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => raw.includes(n));

  if (status === 429 || has("rate limit", "rate_limit", "too many requests")) {
    return {
      code: "rate_limited",
      message:
        "The AI service is busy right now. Give it a few seconds and send it again.",
      retryable: true,
    };
  }
  if (status === 401 || status === 403 || has("unauthorized", "api key", "invalid_api_key")) {
    return {
      code: "auth",
      message:
        "The assistant could not sign in to the AI service. This one is ours to fix — please report it.",
      retryable: false,
    };
  }
  if (status === 404 || has("model_not_found", "does not exist", "unknown model")) {
    return {
      code: "model_unavailable",
      message:
        "The AI model this assistant uses is unavailable. This one is ours to fix — please report it.",
      retryable: false,
    };
  }
  if (status === 408 || has("timeout", "timed out", "etimedout", "aborted due to timeout")) {
    return {
      code: "timeout",
      message:
        "That took too long and timed out. Try again — a shorter message often gets through.",
      retryable: true,
    };
  }
  if (has("context length", "context_length", "maximum context", "too many tokens")) {
    return {
      code: "context_length",
      message:
        "This conversation has grown too long to continue. Start a new chat and I'll pick it up from there.",
      retryable: false,
    };
  }
  if (has("content filter", "content_policy", "safety")) {
    return {
      code: "content_filtered",
      message: "The AI service declined that request. Try rewording it.",
      retryable: false,
    };
  }
  if (status >= 500 || has("overloaded", "unavailable", "econnreset", "socket hang up", "fetch failed")) {
    return {
      code: "provider_unavailable",
      message: "The AI service is temporarily unavailable. Try again in a moment.",
      retryable: true,
    };
  }
  return {
    code: "internal",
    message: "Something went wrong while preparing your reply. Try again.",
    retryable: true,
  };
}

// ============================================================================
// Stream Event Mapper
// ============================================================================

/**
 * Map a provider StreamEvent to a ClientStreamEvent.
 *
 * Kept simple: no block chunking, typing indicators or thinking-tag parsing.
 */
function mapStreamEvent(
  event: StreamEvent,
  accumulated: string,
): ClientStreamEvent | null {
  switch (event.type) {
    case "text_delta":
      return {
        type: "text_delta",
        delta: event.delta,
        accumulated: accumulated + event.delta,
      };
    case "reasoning_delta":
      return {
        type: "reasoning_delta",
        delta: event.delta,
      };
    case "tool_call_start":
      return {
        type: "tool_start",
        callId: event.callId,
        toolType: event.toolType,
        name: event.name,
      };
    case "tool_call_done":
      return {
        type: "tool_done",
        callId: event.callId,
      };
    case "tool_call_delta":
      return {
        type: "tool_delta" as const,
        callId: event.callId,
        delta: event.delta,
      };
    case "done":
      // Handled separately in the runner after the loop
      return null;
    case "error":
      // Handled separately in the runner after the loop
      return null;
    default:
      return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a multimodal ContentBlock[] with text and image attachments.
 *
 * Used when the user sends a photo alongside text (or just a photo).
 * The text block comes first, followed by image blocks.
 */
function buildMultimodalContent(
  text: string,
  attachments: Array<{ mimeType: string; base64: string }>,
  nativeDocuments: NativeDocument[] = [],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Text block (even if empty — some providers need at least one text block)
  if (text) {
    blocks.push({ type: "text", text });
  }

  // Image blocks
  for (const attachment of attachments) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        mediaType: attachment.mimeType,
        data: attachment.base64,
      },
    });
  }

  // Document blocks — PDFs the provider renders itself, so layout survives
  for (const document of nativeDocuments) {
    blocks.push({
      type: "document",
      source: {
        type: "base64",
        mediaType: document.mimeType,
        data: document.base64,
      },
      fileName: document.fileName,
    });
  }

  // Ensure at least one block exists
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "[Image]" });
  }

  return blocks;
}

/**
 * Build the user message as it gets persisted to session history.
 *
 * Images are recorded as a placeholder — their base64 is transient and the
 * model only needs to see a photo on the turn it was sent.
 *
 * Documents are the opposite: their extracted text is persisted in full
 * (within budget), because follow-up questions are the normal case. Storing
 * only "[1 document attached]" would let turn one answer correctly and every
 * turn after that answer blind.
 */
function buildStoredUserContent(
  message: string,
  imageCount: number,
  documents: ExtractedDocument[],
  nativeDocuments: NativeDocument[],
  maxChars: number,
): string {
  const parts: string[] = [];
  const separator = message ? " " : "";

  if (imageCount > 0) {
    parts.push(
      `${message}${separator}[${imageCount} image${imageCount > 1 ? "s" : ""} attached]`,
    );
  } else {
    parts.push(message);
  }

  // Text we already have keeps follow-up turns answerable. A PDF sent
  // natively for layout reasons still carries its extracted text here, even
  // though the model saw the rendered pages this turn.
  const entries = [
    ...documents.map((d) => ({ fileName: d.fileName, text: d.text })),
    ...nativeDocuments.map((d) => ({
      fileName: d.fileName,
      text: d.extractedText,
    })),
  ];

  let remaining = maxChars;
  for (const entry of entries) {
    if (!entry.text) {
      // No text layer — record that it was here so history isn't misleading.
      parts.push(`[Attached document: ${entry.fileName} (image-only PDF)]`);
      continue;
    }
    if (remaining <= 0) break;
    const text =
      entry.text.length > remaining ? entry.text.slice(0, remaining) : entry.text;
    remaining -= text.length;
    parts.push(`[Attached document: ${entry.fileName}]\n${text}`);
  }

  return parts.join("\n\n");
}

/**
 * Safely parse JSON arguments from a function call.
 * Returns empty object on failure (the handler will report validation errors).
 */
function safeParseArgs(argsString: string): Record<string, unknown> {
  try {
    return JSON.parse(argsString) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Join optional prompt sections with double newlines.
 * Filters out empty/undefined values.
 */
function joinPromptSections(...sections: (string | undefined)[]): string | undefined {
  const nonEmpty = sections.filter((s): s is string => !!s?.trim());
  return nonEmpty.length > 0 ? nonEmpty.join("\n\n") : undefined;
}

/**
 * Merge two UsageStats objects, summing all token counts.
 * Used to accumulate usage across multiple tool-call rounds.
 */
function mergeUsage(
  existing: UsageStats | undefined,
  incoming: UsageStats | undefined,
): UsageStats | undefined {
  const normalizedIncoming = normalizeUsage(incoming);
  if (!normalizedIncoming) return existing;
  const normalizedExisting = normalizeUsage(existing);
  if (!normalizedExisting) return normalizedIncoming;
  return {
    inputTokens: normalizedExisting.inputTokens + normalizedIncoming.inputTokens,
    outputTokens: normalizedExisting.outputTokens + normalizedIncoming.outputTokens,
    totalTokens: normalizedExisting.totalTokens + normalizedIncoming.totalTokens,
    cachedInputTokens:
      (normalizedExisting.cachedInputTokens ?? 0) +
        (normalizedIncoming.cachedInputTokens ?? 0) ||
      undefined,
    reasoningTokens:
      (normalizedExisting.reasoningTokens ?? 0) +
        (normalizedIncoming.reasoningTokens ?? 0) ||
      undefined,
  };
}

function resolveRoundUsage(
  providerUsage: UsageStats | undefined,
  request: ProviderRequest,
  response: ProviderResponse,
): UsageStats | undefined {
  const normalized = normalizeUsage(providerUsage);
  if (normalized) return normalized;

  const inputChars =
    textSize(request.instructions) +
    textSize(request.input) +
    textSize(request.tools) +
    textSize(request.toolChoice) +
    textSize(request.reasoning);
  const outputChars = Math.max(textSize(response.text), textSize(response.output));

  const inputTokens = estimateTokensFromChars(inputChars);
  const outputTokens = estimateTokensFromChars(outputChars);

  if (inputTokens <= 0 && outputTokens <= 0) return undefined;

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function normalizeUsage(usage: UsageStats | undefined): UsageStats | undefined {
  if (!usage) return undefined;

  const inputTokens = finiteTokenCount(usage.inputTokens);
  const outputTokens = finiteTokenCount(usage.outputTokens);
  const providedTotal = finiteTokenCount(usage.totalTokens);
  const totalTokens = providedTotal > 0 ? providedTotal : inputTokens + outputTokens;

  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: optionalTokenCount(usage.cachedInputTokens),
    reasoningTokens: optionalTokenCount(usage.reasoningTokens),
  };
}

function finiteTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function optionalTokenCount(value: unknown): number | undefined {
  const count = finiteTokenCount(value);
  return count > 0 ? count : undefined;
}

function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 3);
}

function textSize(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/**
 * Bound conversation history by character budget.
 *
 * This is an approximate token guardrail for large sessions, especially when
 * compaction summaries are unavailable or delayed.
 */
function boundConversationHistoryByChars(
  history: ConversationMessage[],
  maxChars: number,
): ConversationMessage[] {
  if (!history.length || maxChars <= 0) return [];

  let usedChars = 0;
  const kept: ConversationMessage[] = [];

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    const contentChars =
      typeof msg.content === "string"
        ? msg.content.length
        : msg.content.reduce((sum, block) => {
            if (block.type === "text") {
              return sum + block.text.length;
            }
            if (block.type === "image") {
              const src = block.source;
              if (src.type === "base64") return sum + src.data.length;
              if (src.type === "url") return sum + src.data.length;
              return sum;
            }
            return sum;
          }, 0);

    // Include small per-message overhead for role/wrapping.
    const messageCost = contentChars + 16;
    if (usedChars + messageCost > maxChars) {
      break;
    }

    kept.push(msg);
    usedChars += messageCost;
  }

  // The loop iterates newest→oldest; reverse to restore chronological order
  // (oldest→newest) so message-based providers (Anthropic, Chat Completions)
  // receive history in the correct sequence.
  return kept.reverse();
}

/**
 * Strip non-serializable fields from SendRequest for Cosmos DB / Durable persistence.
 * Drops: abortSignal, onCronMutation, attachments (large base64 data).
 */
function serializeSendRequest(request: SendRequest): SerializableSendRequest {
  return {
    userId: request.userId,
    agentId: request.agentId,
    message: request.message,
    sessionId: request.sessionId,
    idempotencyKey: request.idempotencyKey,
    providerId: request.providerId,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    temperature: request.temperature,
    channelName: request.channelName,
    channelChatId: request.channelChatId,
    isGroupChat: request.isGroupChat,
    groupName: request.groupName,
    userTimezone: request.userTimezone,
    metadata: request.metadata,
  };
}
