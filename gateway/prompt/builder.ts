/**
 * AgentForEach Prompt Layer — System Prompt Builder
 *
 * Orchestrates prompt assembly by composing modular section builders.
 * Sources structured prompt documents from Cosmos DB, renders them to text,
 * and assembles them into a structured system prompt.
 *
 * Fixes applied (vs. original):
 *   - isOnboarding checks ALL documents, not just the filtered set
 *   - Cron sessions include HEARTBEAT + signal sections
 *   - Current time is injected (not just timezone)
 *   - Truncation head+tail = 1.0 (no silent gap)
 *   - No phantom "file" terminology
 *
 * Assembly Order (optimised for LLM U-shaped attention curve):
 *
 *  Layer 1 — Identity & Safety           (primacy — top attention)
 *    topContext, Safety rules
 *  Layer 2 — Conversation Context         (early — ground the model)
 *    Compaction summary, Recent session digests
 *  Layer 3 — Memory & Episodes            (mid-early — recalled context)
 *    Memory Recall guidance, Recalled Memories, Episodes, Knowledge
 *  Layer 4 — Operational Details           (middle — reference material)
 *    Tooling, Tool Call Style, Gateway Reference, MCP Servers, Skills
 *  Layer 5 — Environment                  (mid-late — situational context)
 *    Authorized Senders, Date & Time, Channel, Extra Context
 *  Layer 6 — Prompt Documents             (late — recency attention)
 *    AGENTS, SOUL, USER, IDENTITY, TOOLS, HEARTBEAT, BOOTSTRAP, MEMORY
 *  Layer 7 — Signals & Runtime            (end — strongest recency)
 *    Silent Replies, Heartbeats, Runtime line
 */

import type {
  PromptContext,
  PromptDocumentType,
  AssembledPrompt,
  PromptBuilderOptions,
  LoadedPromptDoc,
  IdentityData,
} from "./types.js";
import {
  PROMPT_DOCUMENT_ORDER,
  MINIMAL_SESSION_DOCUMENTS,
  CRON_SESSION_DOCUMENTS,
  DEFAULT_PROMPT_OPTIONS,
  DOC_TYPE_DISPLAY_NAME,
} from "./types.js";

import { renderDocumentData } from "./templates.js";
import type { PromptDocumentStore } from "./store.js";
import { loadPromptTextConfig } from "./prompt-config.js";
import type { PromptTextConfig } from "./prompt-config.js";
import { isOnboardingEnabled } from "./prompt-config.js";

// Section builders
import {
  buildToolLines,
  buildToolingSection,
  buildToolCallStyleSection,
  buildSafetySection,
  buildGatewayReferenceSection,
  buildMemoryRecallSection,
  buildRecalledMemoriesSection,
  buildAuthorizedSendersSection,
  buildTimeSection,
  buildChannelContextSection,
  buildExtraContextSection,
  buildProjectContextSection,
  buildSilentRepliesSection,
  buildHeartbeatsSection,
  buildActiveEpisodesSection,
  buildEpisodesSection,
  buildSkillsSection,
  buildCompactionSection,
  buildRecencySection,
  buildRuntimeSection,
  buildKnowledgeSection,
  buildMcpServerContextSection,
  resolveIdentity,
} from "./sections/index.js";

import { truncateHeadTail } from "../utils/prompt.js";
import { redactId } from "../utils/redact.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceToRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Document Loading & Rendering
// ============================================================================

/**
 * Load, render, and truncate prompt documents from the store.
 * Renders structured data into text using per-type renderers.
 */
async function loadAndRenderDocuments(
  store: PromptDocumentStore,
  context: PromptContext,
  docTypes: readonly PromptDocumentType[],
  opts: Required<PromptBuilderOptions>,
): Promise<{
  loadedDocs: LoadedPromptDoc[];
  includedDocuments: PromptDocumentType[];
  availableDocuments: PromptDocumentType[];
  allDocs: Map<PromptDocumentType, { data: Record<string, unknown> }>;
}> {
  const docs = await store.loadFiltered(
    context.userId,
    context.agentId,
    docTypes,
  );
  const includedDocuments: PromptDocumentType[] = [];
  const availableDocuments: PromptDocumentType[] = [];
  const loadedDocs: LoadedPromptDoc[] = [];
  let totalDocChars = 0;
  const legacyStringDocTypes: PromptDocumentType[] = [];
  const invalidShapeDocTypes: PromptDocumentType[] = [];

  // Build allDocs map (for identity resolution, etc.)
  const allDocs = new Map<
    PromptDocumentType,
    { data: Record<string, unknown> }
  >();
  for (const [docType, doc] of docs) {
    availableDocuments.push(docType);
    const recordData = coerceToRecord(doc.data);
    if (recordData) {
      allDocs.set(docType, { data: recordData });
    }
  }

  for (const docType of docTypes) {
    const doc = docs.get(docType);
    if (!doc) continue;

    const recordData = coerceToRecord(doc.data);
    let content = "";

    if (recordData) {
      content = renderDocumentData(docType, recordData);
    } else if (typeof doc.data === "string") {
      content = doc.data;
      legacyStringDocTypes.push(docType);
    } else {
      invalidShapeDocTypes.push(docType);
      continue;
    }

    if (!content.trim()) continue;

    // Truncate if needed
    const displayName = DOC_TYPE_DISPLAY_NAME[docType];
    if (content.length > opts.maxDocumentChars) {
      content = truncateHeadTail(
        content,
        displayName,
        opts.maxDocumentChars,
        opts.truncationHeadRatio,
        opts.truncationTailRatio,
      );
    }

    // Check total budget — truncate the document to fit rather than
    // silently dropping it. This ensures small later documents (like
    // HEARTBEAT) aren't lost when a large one fills the budget.
    const remaining = opts.maxTotalDocumentChars - totalDocChars;
    if (remaining <= 0) {
      console.warn(
        `[prompt-builder] Total document budget exhausted (${opts.maxTotalDocumentChars} chars), skipping ${displayName} and remaining documents`,
      );
      break;
    }
    if (content.length > remaining) {
      content = truncateHeadTail(
        content,
        displayName,
        remaining,
        opts.truncationHeadRatio,
        opts.truncationTailRatio,
      );
    }

    totalDocChars += content.length;
    includedDocuments.push(docType);
    loadedDocs.push({
      documentType: docType,
      content,
    });
  }

  if (legacyStringDocTypes.length > 0) {
    console.warn(
      `[prompt-builder] Using legacy string prompt docs user=${redactId(context.userId)} agent=${context.agentId} types=${legacyStringDocTypes.join(",")}`,
    );
  }
  if (invalidShapeDocTypes.length > 0) {
    console.warn(
      `[prompt-builder] Invalid prompt doc data shape user=${redactId(context.userId)} agent=${context.agentId} types=${invalidShapeDocTypes.join(",")}`,
    );
  }

  return { loadedDocs, includedDocuments, availableDocuments, allDocs };
}

// ============================================================================
// Main Builder
// ============================================================================

/**
 * Build a complete system prompt by composing modular sections.
 *
 * Each section is built by a dedicated function in `./sections/`.
 * Sections return `string[]` (lines) and empty arrays when omitted,
 * making the composition declarative and each section independently testable.
 *
 * @param store - Cosmos DB prompt document store.
 * @param context - Runtime context for this request.
 * @param options - Optional builder configuration overrides.
 * @returns Assembled prompt ready for the LLM provider.
 */
export async function buildSystemPrompt(
  store: PromptDocumentStore,
  context: PromptContext,
  options?: PromptBuilderOptions,
): Promise<AssembledPrompt> {
  const opts = { ...DEFAULT_PROMPT_OPTIONS, ...options };

  // Load all prompt text from agentforeach.json (with built-in defaults)
  const txt: PromptTextConfig = loadPromptTextConfig();

  // Resolve dynamic identity/timezone from Cosmos when not provided.
  // This keeps prompt behavior correct even in minimal/none modes where
  // we intentionally do not render all prompt documents.
  let resolvedUserTimezone = context.userTimezone?.trim() || undefined;
  let resolvedCurrentDateTime = context.currentDateTime?.trim() || undefined;

  // -- "none" mode: minimal identity line only --
  if (context.promptMode === "none") {
    const docIdentity =
      (await store.getData(context.userId, context.agentId, "IDENTITY")) ?? {};
    const identity = resolveIdentity(docIdentity, context.identityConfig);
    const instructions = txt.topContext;
    return {
      instructions,
      identity,
      includedDocuments: [],
      isOnboarding: false,
      characterCount: instructions.length,
    };
  }

  const isCron = context.sessionType === "cron";
  const isMinimal =
    context.promptMode === "minimal" ||
    context.sessionType === "subagent" ||
    isCron;

  // -- Select document types based on session type --
  // Cron sessions get AGENTS + TOOLS + HEARTBEAT (need heartbeat tasks).
  // Subagent sessions get AGENTS + TOOLS only.
  // When onboarding is disabled in config, strip BOOTSTRAP from all sets
  // so it is never rendered into the prompt.
  const onboardingOn = isOnboardingEnabled();
  const filterBootstrap = (types: readonly PromptDocumentType[]) =>
    onboardingOn ? types : types.filter((t) => t !== "BOOTSTRAP");

  const docTypes = filterBootstrap(
    isCron
      ? CRON_SESSION_DOCUMENTS
      : isMinimal
        ? MINIMAL_SESSION_DOCUMENTS
        : PROMPT_DOCUMENT_ORDER,
  );

  if (onboardingOn == false && docTypes.includes("BOOTSTRAP")) {
      docTypes.filter((t) => t !== "BOOTSTRAP");
  }

  const { loadedDocs, includedDocuments, availableDocuments, allDocs } =
    await loadAndRenderDocuments(store, context, docTypes, opts);

  // -- Check onboarding status against the FULL document set --
  // When onboarding is disabled in config, skip detection entirely.
  // Even in minimal sessions, check if BOOTSTRAP exists to correctly
  // report isOnboarding status. Use store.load() for a single-doc check
  // instead of re-querying the filtered set.
  let isOnboarding = false;
  if (isOnboardingEnabled()) {
    isOnboarding = availableDocuments.includes("BOOTSTRAP");
    if (!isOnboarding) {
      // Fallback for minimal sessions (BOOTSTRAP not in filtered set) and
      // legacy/malformed full-session docs where BOOTSTRAP exists but cannot
      // be parsed into an object.
      isOnboarding = await store.isOnboardingPending(
        context.userId,
        context.agentId,
      );
    }
  }

  // -- Resolve identity from Cosmos, even if IDENTITY isn't in the filtered doc set --
  const identityDoc = allDocs.get("IDENTITY");
  const identityFromStore = identityDoc
    ? identityDoc.data
    : coerceToRecord(
        await store.getData(context.userId, context.agentId, "IDENTITY"),
      );
  const docIdentity: IdentityData = (identityFromStore ?? {}) as IdentityData;

  // Resolve timezone (prefer runtime override; fallback to USER doc)
  if (!resolvedUserTimezone) {
    const userDoc = allDocs.get("USER");
    const tzFromDocs = userDoc?.data?.timezone;
    const userFromStore = coerceToRecord(
      await store.getData(context.userId, context.agentId, "USER"),
    );
    const tzFromStore = userFromStore?.timezone;
    resolvedUserTimezone =
      typeof tzFromDocs === "string" && tzFromDocs.trim()
        ? tzFromDocs.trim()
        : typeof tzFromStore === "string" && tzFromStore.trim()
          ? tzFromStore.trim()
          : undefined;
  }
  if (!resolvedCurrentDateTime) {
    resolvedCurrentDateTime = new Date().toISOString();
  }

  const resolvedContext: PromptContext = {
    ...context,
    userTimezone: resolvedUserTimezone,
    currentDateTime: resolvedCurrentDateTime,
  };

  const identity = resolveIdentity(docIdentity, context.identityConfig);

  // -- Build tool info --
  // Merge static toolSummaries with dynamic extra summaries (e.g. from MCP servers)
  const mergedSummaries = context.extraToolSummaries
    ? { ...txt.toolSummaries, ...context.extraToolSummaries }
    : txt.toolSummaries;
  const { lines: toolLines, availableTools } = buildToolLines(
    context.toolNames ?? [],
    mergedSummaries,
    txt.toolOrder,
  );

  // -- Compose sections --
  // Ordered from most to least stable, because model providers cache the
  // longest prompt prefix that repeats exactly (OpenAI: automatically, from
  // 1,024 tokens). Anything that changes early in the prompt makes the rest
  // uncacheable, and the tool and gateway instructions alone are thousands
  // of tokens:
  //   1. The same for every user: identity, safety, how to use memory,
  //      episodes and tools, response style, signals.
  //   2. Stable per user or session: their prompt documents, skills, MCP
  //      servers, senders, channel, gateway phase.
  //   3. This turn: conversation summary, recent sessions, recalled
  //      memories, active episodes, knowledge, time, runtime. Last, and so
  //      also closest to the user's message.
  //
  // Signal sections (silent replies, heartbeats) are shown for BOTH full
  // and cron sessions — the agent needs these instructions during heartbeats.
  const showSignals = !isMinimal || isCron;

  const lines: string[] = [
    // --- 1. Static: identical across users and turns ---
    txt.topContext,
    "",
    ...buildSafetySection(txt.safety),
    ...buildMemoryRecallSection({ isMinimal, availableTools, cfg: txt.memoryRecall }),
    ...buildEpisodesSection({
      isMinimal,
      availableTools,
      cfg: txt.episodes,
    }),
    ...buildToolingSection(toolLines, txt.tooling),
    ...buildToolCallStyleSection(txt.toolCallStyle),
    ...buildSilentRepliesSection({
      show: showSignals,
      silentReplyToken: opts.silentReplyToken,
      cfg: txt.silentReplies,
    }),
    ...buildHeartbeatsSection({
      show: showSignals,
      heartbeatAckToken: opts.heartbeatAckToken,
      cfg: txt.heartbeats,
    }),

    // --- 2. Per user / session: changes rarely ---
    ...buildProjectContextSection({ loadedDocs, cfg: txt.projectContext }),
    ...buildSkillsSection({
      isMinimal,
      skillStatuses: context.skillStatuses,
      cfg: txt.skills,
    }),
    ...buildMcpServerContextSection({
      isMinimal,
      mcpServerContext: context.mcpServerContext,
    }),
    ...buildAuthorizedSendersSection({
      isMinimal,
      authorizedSenders: resolvedContext.authorizedSenders,
      cfg: txt.authorizedSenders,
    }),
    ...buildChannelContextSection({
      isMinimal,
      channelName: context.channelName,
      cfg: txt.channel,
    }),
    ...buildExtraContextSection({
      isMinimal,
      isCron,
      isGroupChat: context.isGroupChat,
      groupSystemPrompt: context.groupSystemPrompt,
      channelSystemPrompt: context.channelSystemPrompt,
      inboundMetaSystemPrompt: context.inboundMetaSystemPrompt,
      cfg: txt.extraContext,
    }),
    ...buildGatewayReferenceSection(txt.gateway, {
      seenTools: context.gatewaySeenTools,
      channel: context.channelName,
    }),

    // --- 3. This turn ---
    ...buildCompactionSection({
      compactionSummary: context.compactionSummary,
      cfg: txt.compaction,
    }),
    ...buildRecencySection({
      isMinimal,
      recentDigests: context.recentDigests,
      cfg: txt.recency,
    }),
    ...buildRecalledMemoriesSection({
      isMinimal,
      recalledMemories: context.recalledMemories,
      cfg: txt.recalledMemories,
    }),
    ...buildActiveEpisodesSection({
      isMinimal,
      availableTools,
      activeEpisodeThemes: context.activeEpisodeThemes,
      cfg: txt.episodes,
    }),
    ...buildKnowledgeSection({
      isMinimal,
      knowledgeContext: context.knowledgeContext,
      cfg: txt.knowledge,
    }),
    ...buildTimeSection({
      currentDateTime: resolvedContext.currentDateTime,
      userTimezone: resolvedContext.userTimezone,
      cfg: txt.time,
    }),
    ...buildRuntimeSection(resolvedContext, txt.runtime),
  ];

  // Join lines preserving blank-line spacers ("") that section builders
  // intentionally add for visual separation between sections.
  // Only filter out null/undefined, not empty strings.
  const instructions = lines.filter((l) => l != null).join("\n");

  return {
    instructions,
    identity,
    includedDocuments,
    isOnboarding,
    characterCount: instructions.length,
  };
}
