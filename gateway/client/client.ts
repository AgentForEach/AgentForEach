/**
 * AgentForEach Client Layer — Main Client
 *
 * The unified entry point that wires together all subsystems and exposes
 * a clean API for sending messages and receiving responses.
 *
 *   createAgentClient()   wires every store and provider from agentforeach.json
 *   AgentClient.send()    one turn: runner.ts runAgentTurn()
 *   sessions/             sessions and messages in Cosmos DB
 *   prompt/               system prompt assembly
 *   memory/               auto-recall and auto-capture
 *   websocket/            streaming to clients over Azure Web PubSub
 *
 * Usage:
 * ```ts
 * import { createAgentClient } from "./client/index.js";
 *
 * // Auto-resolve all config from agentforeach.json:
 * const client = createAgentClient();
 * await client.initialize();
 *
 * const response = await client.send({
 *   userId: "user_123",
 *   message: "What's the weather like?",
 * });
 * console.log(response.text);
 *
 * // Or with explicit overrides:
 * const client2 = createAgentClient({
 *   cosmos: { endpoint: "https://...", key: "..." },
 *   provider: { apiKey: "sk-..." },
 * });
 * ```
 */

import { randomUUID } from "node:crypto";
import { loadDatabaseConfig, createStorage, getSharedStorage } from "../database/index.js";
import type { StorageAdapter } from "@agentforeach/storage";
import {
  createMemoryLayer,
  loadMemoryConfig,
  type MemoryLayer,
} from "../memory/index.js";
import { CronStore } from "../cron/index.js";
import { PromptDocumentStore } from "../prompt/index.js";
import {
  getProvider,
  resolveDefaultProviderId,
  resolveProviderConfig,
  getEnabledProviderIds,
  loadFailoverConfig,
  loadLlmConfig,
  resolveFactoryId,
  type Provider,
  type ProviderId,
} from "../llms/index.js";
import { loadLinkConfig } from "../link-understanding/index.js";
import { loadAttachmentConfig } from "../attachments/index.js";
import { EpisodeStore, loadEpisodeConfig } from "../episodes/index.js";
import { DigestStore, loadDigestConfig } from "../digests/index.js";
import { loadWebConfig } from "../web/index.js";
import { loadSkillsConfig, UserSkillStore, createSandboxBackend, ExportBlobStore, SkillBlobStore } from "../skills/index.js";
import { resolveObjectStorage } from "../objects/index.js";
import { EmbeddingsClient, resolveEmbeddingApiKey, resolveEmbeddingModel, resolveEmbeddingBaseUrl } from "../memory/index.js";
import {
  createKnowledgeLayer,
  loadKnowledgeConfig,
  isKnowledgeEnabled,
  type KnowledgeLayer,
} from "../knowledge/index.js";
import { loadMcpConfig, McpManager } from "../mcp/index.js";
import { HitlStore } from "../hitl/index.js";
import { AbortStore } from "./abort-store.js";

// The llms barrel auto-registers openai + anthropic provider factories on import.
// The named import above already triggers that registration.

import {
  realtimeCapabilities,
  resolveHub,
} from "../websocket/index.js";
import { RateLimiter, rateLimitMessage } from "../ratelimit/index.js";
import { IdentityStore, loadIdentityConfig } from "../identity/index.js";
import { setIdentityStore } from "../channels/router.js";
import { SessionStore } from "../sessions/index.js";
import type { Session, SessionSummary, MessageDocument } from "../sessions/index.js";
import { UsageStore } from "../usage/index.js";
import type { UsageRecord, UsageSummary } from "../usage/index.js";
import { runAgentTurn, type RunnerDeps } from "./runner.js";
import { tryHandleCommand } from "./commands.js";
import { registerLangSmithTracing } from "./langsmith.js";
import { HookEmitter } from "../hooks/index.js";
import {
  loadCreditsConfig,
  HttpCreditProvider,
  registerCreditsHooks,
  releaseReservationOnThrow,
  reserveCredits,
  runMetered,
} from "../credits/index.js";
import type {
  AgentClient,
  AgentClientConfig,
  SendRequest,
  SendResponse,
  StreamCallback,
} from "./types.js";

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new AgentForEach client instance.
 *
 * The factory wires together all subsystems, auto-resolving configuration
 * from agentforeach.json via each module's config loader. Explicit values in
 * `config` override the auto-resolved values (useful for tests or standalone
 * usage).
 *
 * Subsystems wired:
 *   - Storage (shared adapter, Cosmos DB by default) — database/config
 *   - Memory layer (auto-recall, auto-capture) — memory/config
 *   - Prompt store (system prompt documents)  — prompt/
 *   - Session store (conversation history)    — sessions/config
 *   - Provider (LLM API)                      — llms/config
 *   - Realtime (WebSocket push)               — websocket/config
 *
 * Call `initialize()` on the returned client before first use.
 */
export function createAgentClient(config: AgentClientConfig = {}): AgentClient {
  // -- Shared database (auto-resolved from agentforeach.json "database" section) --
  // The process-wide instance, unless the caller overrides the connection.
  let storage: StorageAdapter;
  if (config.storage) {
    storage = config.storage;
  } else if (config.cosmos?.endpoint || config.cosmos?.key || config.cosmos?.databaseId) {
    const dbConfig = loadDatabaseConfig();
    if (config.cosmos.endpoint) dbConfig.endpoint = config.cosmos.endpoint;
    if (config.cosmos.key) dbConfig.key = config.cosmos.key;
    if (config.cosmos.databaseId) dbConfig.databaseId = config.cosmos.databaseId;
    storage = createStorage(dbConfig);
  } else {
    storage = getSharedStorage();
  }

  // -- Memory layer (auto-resolved from agentforeach.json "memory" section) --
  const memory: MemoryLayer = createMemoryLayer(storage);

  // -- Prompt store --
  const promptStore = new PromptDocumentStore(storage);

  // -- Session store (auto-resolved from agentforeach.json "session" section) --
  const sessionStore = new SessionStore(storage, {
    maxHistoryMessages: config.session?.maxHistoryMessages,
    ttlSeconds: config.session?.ttlSeconds,
  });

  // -- Cron store --
  const cronStore = new CronStore(storage);

  // -- Usage store (auto-resolved from agentforeach.json "usage" section) --
  const usageStore = new UsageStore(storage);

  // -- Episode store (auto-resolved from agentforeach.json "episodes" section) --
  const episodeConfig = loadEpisodeConfig();
  const episodeStore = episodeConfig.enabled ? new EpisodeStore(storage, episodeConfig.containerId) : undefined;

  // -- Digest store (auto-resolved from agentforeach.json "digests" section) --
  const digestConfig = loadDigestConfig();
  const digestStore = digestConfig.enabled
    ? new DigestStore(storage, digestConfig.containerId)
    : undefined;

  // -- Identity store (auto-resolved from agentforeach.json "identity" section) --
  const identityConfig = loadIdentityConfig();
  const identityStore = identityConfig.enabled ? new IdentityStore(storage, identityConfig) : undefined;

  // -- Skills store (auto-resolved from agentforeach.json "skills" section) --
  const skillsConfig = loadSkillsConfig();
  const skillStore = skillsConfig.enabled ? new UserSkillStore(storage, skillsConfig.containerId) : undefined;

  // -- Sandbox backend (ACA Sandboxes, falling back to Dynamic Sessions) --
  const sandboxClient = skillsConfig.sandbox
    ? createSandboxBackend(skillsConfig.sandbox)
    : undefined;

  // -- Skill definitions (SKILL.md blobs) and export store (sandbox_file_export
  //    → user downloads), both on the runtime storage account. Skill and
  //    sandbox tools are offered only when the skill store exists. --
  const exportStorage = skillsConfig.enabled
    ? resolveObjectStorage(skillsConfig.storageConnectionString)
    : undefined;
  let skillBlobStore: SkillBlobStore | undefined;
  if (exportStorage) {
    try {
      skillBlobStore = new SkillBlobStore(exportStorage, skillsConfig.storageContainerName);
    } catch (err) {
      console.warn(`[skills] skill store unavailable, skills and sandboxes are off: ${err instanceof Error ? err.message : err}`);
    }
  } else if (skillsConfig.enabled) {
    console.warn("[skills] no storage account configured, skills and sandboxes are off");
  }
  let exportStore: ExportBlobStore | undefined;
  if (exportStorage) {
    try {
      exportStore = new ExportBlobStore(exportStorage);
    } catch {
      // Non-fatal — sandbox_file_export won't be available
    }
  }

  // -- Knowledge layer (auto-resolved from agentforeach.json "knowledge" section) --
  const knowledgeConfig = loadKnowledgeConfig();
  const knowledgeLayer: KnowledgeLayer | undefined = isKnowledgeEnabled()
    ? createKnowledgeLayer(knowledgeConfig)
    : undefined;

  // -- MCP servers (auto-resolved from agentforeach.json "mcp" section) --
  const mcpConfig = loadMcpConfig();
  const mcpManager: McpManager | undefined = mcpConfig.enabled
    ? new McpManager(mcpConfig.servers)
    : undefined;

  // -- HITL store (Cosmos DB persistence for human-in-the-loop requests) --
  // Config-driven gated tools and the LLM-initiated request_user_input tool
  // both use this store so a picker response can resume the provider chain.
  const hitlStore = new HitlStore(storage);

  // -- Abort store (cross-instance stop button) --
  // The in-memory active-request registry only reaches runs on the same
  // function instance; this store lets an abort landing anywhere stop them.
  const abortStore = new AbortStore(storage);

  // -- Per-user message rate limit (shared across instances) --
  const rateLimiter = new RateLimiter(storage);

  // -- Shared embeddings client (reusable by memory + episodes) --
  let sharedEmbeddings: EmbeddingsClient | undefined;
  try {
    const embApiKey = resolveEmbeddingApiKey();
    const embModel = resolveEmbeddingModel();
    const embBaseUrl = resolveEmbeddingBaseUrl();
    if (embApiKey) {
      const memCfg = loadMemoryConfig();
      sharedEmbeddings = new EmbeddingsClient(embApiKey, embModel, memCfg.maxEmbeddingChars, embBaseUrl);
    }
  } catch {
    // Non-fatal — episodes will work without vectors
  }

  // -- Provider (auto-resolved from agentforeach.json "llms" section) --
  const providerId = config.provider?.id ?? resolveDefaultProviderId();

  // Build per-provider API key map: agentforeach.json → explicit overrides
  const providerApiKeys = new Map<string, string>();
  for (const id of getEnabledProviderIds()) {
    const cfg = resolveProviderConfig(id);
    if (cfg?.apiKey) providerApiKeys.set(id, cfg.apiKey);
  }
  // Explicit overrides win
  if (config.provider?.apiKey) {
    providerApiKeys.set(providerId, config.provider.apiKey);
  }
  for (const [id, apiKey] of Object.entries(config.provider?.apiKeys ?? {})) {
    if (typeof apiKey === "string" && apiKey.trim()) {
      providerApiKeys.set(id, apiKey);
    }
  }

  // Validate that the default provider has an API key
  const defaultApiKey = providerApiKeys.get(providerId);
  if (!defaultApiKey) {
    throw new Error(
      `agentforeach: no API key for default provider "${providerId}". ` +
        `Configure it in agentforeach.json "llms.providers" or pass provider.apiKey.`,
    );
  }

  // Build per-provider default model map: agentforeach.json → explicit overrides
  const defaultModelMap = new Map<string, string>();
  const maxToolCallsMap = new Map<string, number>();
  for (const id of getEnabledProviderIds()) {
    const cfg = resolveProviderConfig(id);
    if (cfg?.defaultModel) defaultModelMap.set(id, cfg.defaultModel);
    if (cfg?.maxToolCalls !== undefined) {
      maxToolCallsMap.set(id, cfg.maxToolCalls);
    }
  }
  if (config.provider?.defaultModel) {
    defaultModelMap.set(providerId, config.provider.defaultModel);
  }
  for (const [id, model] of Object.entries(
    config.provider?.defaultModels ?? {},
  )) {
    if (typeof model === "string" && model.trim()) {
      defaultModelMap.set(id, model.trim());
    }
  }

  const fallbackDefaultModel =
    defaultModelMap.get(providerId) ?? "gpt-5.2";

  const resolveDefaultModel = (requestedId?: ProviderId): string => {
    const effectiveId = requestedId ?? providerId;
    return defaultModelMap.get(effectiveId) ?? fallbackDefaultModel;
  };

  const resolveMaxToolCalls = (requestedId?: ProviderId): number | undefined => {
    const effectiveId = requestedId ?? providerId;
    return maxToolCallsMap.get(effectiveId);
  };

  const providers = new Map<string, Provider>();

  const resolveProvider = (requestedId?: ProviderId): Provider => {
    const effectiveId = requestedId ?? providerId;
    const cached = providers.get(effectiveId);
    if (cached) return cached;

    const apiKey = providerApiKeys.get(effectiveId) ?? defaultApiKey;
    if (!apiKey) {
      throw new Error(`agentforeach: missing API key for provider "${effectiveId}"`);
    }
    const resolved = resolveProviderConfig(effectiveId);

    // Route to the correct factory based on apiFormat config.
    // e.g. "minimax" with apiFormat: "completions" → "openai-completions" factory.
    // Built-in providers ("openai", "anthropic") return themselves.
    const factoryId = resolveFactoryId(effectiveId);

    const next = getProvider(factoryId, {
      apiKey,
      defaultModel: resolveDefaultModel(effectiveId),
      baseUrl: config.provider?.baseUrl ?? resolved?.baseUrl,
      ...(resolved?.timeoutMs && { timeoutMs: resolved.timeoutMs }),
      ...(resolved?.organization && { organization: resolved.organization }),
      ...(resolved?.project && { project: resolved.project }),
      ...(resolved?.responses && { responses: resolved.responses }),
      // When routing to a different factory, pass the config provider name
      // so the provider instance reports the correct ID (e.g. "minimax").
      ...(factoryId !== effectiveId && { providerId: effectiveId }),
    });
    providers.set(effectiveId, next);
    return next;
  };

  const provider = resolveProvider(providerId);

  // -- Realtime config (auto-resolved from agentforeach.json "websocket" section) --
  // An explicit connection string decides; otherwise the provider says whether pushes reach clients.
  const realtimeEnabled =
    config.realtime?.connectionString !== undefined ? !!config.realtime.connectionString : realtimeCapabilities().push;
  const streamToClient = config.realtime?.streamToClient ?? true;

  // -- Hook emitter (lifecycle events for the pipeline) --
  const hooks = new HookEmitter();
  registerLangSmithTracing(hooks);

  // -- Credits system (token-proportional coin deduction) --
  const creditsConfig = loadCreditsConfig();
  const creditProvider = creditsConfig.enabled
    ? new HttpCreditProvider(creditsConfig)
    : undefined;
  if (creditProvider) {
    registerCreditsHooks(hooks, creditProvider, creditsConfig, usageStore);
  }

  // -- Runner dependencies --
  const memoryConfig = loadMemoryConfig();
  const failoverConfig = loadFailoverConfig();
  const linkConfig = loadLinkConfig();
  const attachmentConfig = loadAttachmentConfig();
  const webConfig = loadWebConfig();
  const llmConfig = loadLlmConfig();
  const deps: RunnerDeps = {
    provider,
    resolveProvider,
    memory,
    cronStore,
    promptStore,
    sessionStore,
    defaultModel: fallbackDefaultModel,
    resolveDefaultModel,
    resolveMaxToolCalls,
    realtimeEnabled,
    streamToClient,
    autoRecall: memoryConfig.autoRecall,
    autoCapture: memoryConfig.autoCapture,
    usageStore,
    maxToolRounds: llmConfig.maxToolRounds,
    toolBudget: llmConfig.toolBudget,
    failoverConfig,
    linkConfig,
    attachmentConfig,
    episodeStore,
    episodeConfig: episodeStore ? episodeConfig : undefined,
    digestStore,
    digestConfig: digestStore ? digestConfig : undefined,
    embeddings: sharedEmbeddings,
    hooks,
    webConfig: webConfig.enabled ? webConfig : undefined,
    skillsConfig: skillsConfig.enabled ? skillsConfig : undefined,
    skillStore,
    skillBlobStore,
    sandboxClient,
    exportStore,
    knowledgeLayer,
    mcpManager,
    hitlStore,
  };

  // -- Digest lifecycle hooks --
  // Create digests when sessions are compacted or reset so the agent
  // has recency awareness across sessions.
  if (digestStore && digestConfig) {
    hooks.on("after_compaction", async (event) => {
      try {
        const refreshed = await sessionStore.get(
          event.session.userId,
          event.session.sessionId,
        );
        if (refreshed?.compactionSummary) {
          await digestStore.save({
            id: `dg_${event.session.sessionId}`,
            userId: event.session.userId,
            sessionId: event.session.sessionId,
            agentId: event.session.agentId,
            summary: refreshed.compactionSummary.slice(
              0,
              digestConfig.maxSummaryChars,
            ),
            topics: [],
            createdAt: new Date().toISOString(),
            ttl: digestConfig.ttlSeconds,
          });
        }
      } catch {
        // Non-fatal — void hook errors are caught by emitter
      }
    });

    hooks.on("before_reset", async (event) => {
      if (!event.session?.compactionSummary) return;
      try {
        await digestStore.save({
          id: `dg_${event.sessionId}`,
          userId: event.userId,
          sessionId: event.sessionId,
          agentId: event.session.agentId,
          summary: event.session.compactionSummary.slice(
            0,
            digestConfig.maxSummaryChars,
          ),
          topics: [],
          createdAt: new Date().toISOString(),
          ttl: digestConfig.ttlSeconds,
        });
      } catch {
        // Non-fatal
      }
    });
  }

  // -- Track initialization --
  let initialized = false;

  // ========================================================================
  // Client Implementation
  // ========================================================================

  const client: AgentClient = {
    hooks,
    promptStore,
    provider,
    resolveProvider,
    resolveDefaultModel,

    runMetered(run, work) {
      return runMetered({ hooks, usageStore, creditProvider }, run, work);
    },

    async initialize(): Promise<void> {
      if (initialized) return;

      // Initialize all core subsystems in parallel
      await Promise.all([
        storage.initialize(),
        memory.initialize(),
        promptStore.initialize(),
        sessionStore.initialize(),
        cronStore.initialize(),
        usageStore.initialize(),
        ...(hitlStore ? [hitlStore.initialize()] : []),
        abortStore.initialize(),
        ...(episodeStore ? [episodeStore.initialize()] : []),
        ...(digestStore ? [digestStore.initialize()] : []),
        ...(skillStore ? [skillStore.initialize()] : []),
        ...(mcpManager ? [mcpManager.initialize()] : []),
      ]);

      // Initialize identity store separately — non-fatal.
      // Identity is optional; if container creation fails (permissions,
      // throttling, etc.), the client still works with fallback behavior.
      if (identityStore) {
        try {
          await identityStore.initialize();
          setIdentityStore(identityStore);
        } catch (err) {
          console.error(
            "[identity] Identity store initialization failed (non-fatal):",
            err instanceof Error ? err.message : err,
          );
        }
      }

      initialized = true;
    },

    async send(
      request: SendRequest,
      onStream?: StreamCallback,
    ): Promise<SendResponse> {
      ensureInitialized();

      // Check for slash commands before the normal pipeline
      const commandResponse = await tryHandleCommand(request, deps, onStream);
      if (commandResponse) return commandResponse;

      // Resumed runs continue a message already counted; scheduled runs and
      // messages the handler already counted aren't counted (again).
      const exempt =
        request.scheduled ||
        request.rateLimitChecked ||
        request.metadata?._hitlContinuation === "true";
      const limit = exempt
        ? ({ allowed: true } as const)
        : await rateLimiter.check(request.userId, request.channelName);
      if (!limit.allowed) {
        return {
          runId: `noop_${Date.now()}`,
          text: rateLimitMessage(limit),
          sessionId: request.sessionId ?? "",
          identity: { name: "Assistant" },
          providerId: providerId,
          model: fallbackDefaultModel,
          memoriesRecalled: 0,
          memoryCaptured: false,
          durationMs: 0,
          status: "failed",
          error: "RATE_LIMITED",
          retryAfterSeconds: limit.retryAfterSeconds,
        };
      }

      // Reserve the available balance before any billable model work.
      let runId: string | undefined;
      if (creditProvider && creditsConfig.enabled) {
        runId = request.runId ?? randomUUID();
        try {
          await reserveCredits(
            request.userId,
            runId,
            creditProvider,
          );
        } catch (err) {
          const code = (err as any)?.code;
          if (code === "INSUFFICIENT_CREDITS" || code === "CREDITS_UNAVAILABLE") {
            return {
              runId: `noop_${Date.now()}`,
              text:
                code === "INSUFFICIENT_CREDITS"
                  ? (err as Error).message
                  : "Credits are temporarily unavailable. Please try again shortly.",
              sessionId: request.sessionId ?? "",
              identity: { name: "Assistant" },
              providerId: providerId,
              model: fallbackDefaultModel,
              memoriesRecalled: 0,
              memoryCaptured: false,
              durationMs: 0,
              status: "failed",
              error: code,
            };
          }
          throw err;
        }
      }

      const start = async () => {
        // Auto-seed prompt documents on first interaction per user
        const agentId = request.agentId ?? "default";
        await promptStore.seedDefaults(request.userId, agentId);

        return runAgentTurn(
          runId ? { ...request, runId } : request,
          deps,
          onStream,
        );
      };
      return runId && creditProvider
        ? releaseReservationOnThrow(creditProvider, request.userId, runId, start)
        : start();
    },

    async listSessions(
      userId: string,
      agentId?: string,
      opts?: { limit?: number },
    ): Promise<SessionSummary[]> {
      ensureInitialized();
      return sessionStore.list(userId, agentId, opts);
    },

    async findLastChannel(userId: string) {
      ensureInitialized();
      return sessionStore.findLastChannel(userId);
    },

    async getSession(
      userId: string,
      sessionId: string,
    ): Promise<Session | null> {
      ensureInitialized();
      return sessionStore.get(userId, sessionId);
    },

    async deleteSession(userId: string, sessionId: string): Promise<boolean> {
      ensureInitialized();
      return sessionStore.delete(userId, sessionId);
    },

    async getSessionMessages(
      userId: string,
      sessionId: string,
      opts?: { limit?: number },
    ): Promise<MessageDocument[]> {
      ensureInitialized();
      return sessionStore.getMessages(userId, sessionId, opts);
    },

    async seedUser(userId: string, agentId?: string): Promise<void> {
      ensureInitialized();
      await promptStore.seedDefaults(userId, agentId ?? "default");
    },

    async getUsageSummary(
      userId: string,
      opts?: { from?: string; to?: string },
    ): Promise<UsageSummary> {
      ensureInitialized();
      return usageStore.getSummary(userId, opts);
    },

    async getUsageRecords(
      userId: string,
      opts?: { from?: string; to?: string; limit?: number },
    ): Promise<UsageRecord[]> {
      ensureInitialized();
      return usageStore.getRecords(userId, opts);
    },
  };

  function ensureInitialized(): void {
    if (!initialized) {
      throw new Error(
        "AgentClient: not initialized. Call initialize() first.",
      );
    }
  }

  // Expose internal stores for the HITL orchestrator's resume activity.
  // These are NOT part of the public AgentClient interface — the
  // orchestrator accesses them via `(client as any)._hitlStore`.
  (client as any)._hitlStore = hitlStore;
  (client as any)._mcpManager = mcpManager;
  (client as any)._sessionStore = sessionStore;
  (client as any)._abortStore = abortStore;

  return client;
}
