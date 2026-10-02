/**
 * AgentForEach Prompt Layer — Types
 *
 * Structured type definitions for the system prompt / identity / context
 * management layer. Each prompt document type has a dedicated data interface
 * with individually addressable fields — no markdown blobs.
 *
 * Storage: Azure Cosmos DB (structured JSON documents).
 * Access: LLM updates individual fields via `prompt_get` / `prompt_update` tools.
 *
 * Prompt Assembly Order:
 *   1. Base hardcoded system prompt (safety, tooling, runtime info)
 *   2. AGENTS  — agent operational guide
 *   3. SOUL    — persona & personality definition
 *   4. USER    — owner profile (name, timezone, preferences)
 *   5. IDENTITY — agent identity (name, emoji, creature, vibe)
 *   6. TOOLS   — environment-specific tool notes
 *   7. HEARTBEAT — periodic task checklist
 *   8. BOOTSTRAP — first-run onboarding (deleted after completion)
 *   9. MEMORY  — long-term curated memories
 *  10. Channel/group context & inbound meta
 */

import type { BaseDocument } from "../database/index.js";

// ============================================================================
// Prompt Mode
// ============================================================================

/**
 * Controls how much of the system prompt is assembled.
 *
 * - "full"    — All sections and configuration documents included (normal chat).
 * - "minimal" — Only AGENTS + TOOLS documents (subagent and cron sessions).
 * - "none"    — Minimal system prompt (single identity line).
 */
export type PromptMode = "full" | "minimal" | "none";

// ============================================================================
// Session Type
// ============================================================================

/**
 * The type of session determines which prompt documents are loaded.
 *
 * - "interactive" — Full human conversation session.
 * - "subagent"    — Spawned child agent session (minimal context).
 * - "cron"        — Heartbeat or scheduled task (minimal context).
 */
export type SessionType = "interactive" | "subagent" | "cron";

// ============================================================================
// Prompt Document Types
// ============================================================================

/**
 * The fixed set of prompt configuration document types.
 * Each is stored as a structured Cosmos DB document with typed fields.
 */
export type PromptDocumentType =
  | "AGENTS"
  | "SOUL"
  | "USER"
  | "IDENTITY"
  | "TOOLS"
  | "HEARTBEAT"
  | "BOOTSTRAP"
  | "MEMORY";

/**
 * All document types in assembly order.
 * Controls the sequence in which documents appear in the system prompt.
 */
export const PROMPT_DOCUMENT_ORDER: readonly PromptDocumentType[] = [
  "AGENTS",
  "SOUL",
  "USER",
  "IDENTITY",
  "TOOLS",
  "HEARTBEAT",
  "BOOTSTRAP",
  "MEMORY",
] as const;

/**
 * Document types included in minimal sessions (subagent).
 * See CRON_SESSION_DOCUMENTS for cron-specific document selection.
 */
export const MINIMAL_SESSION_DOCUMENTS: readonly PromptDocumentType[] = [
  "AGENTS",
  "TOOLS",
] as const;

/**
 * Document types included in cron sessions.
 * Includes HEARTBEAT so the agent sees its task list during heartbeats.
 */
export const CRON_SESSION_DOCUMENTS: readonly PromptDocumentType[] = [
  "AGENTS",
  "TOOLS",
  "HEARTBEAT",
] as const;

// ============================================================================
// Structured Data Interfaces — One per Document Type
// ============================================================================

/**
 * IDENTITY — Agent identity configuration.
 * Defines who the agent is (name, emoji, persona tokens).
 */
export interface IdentityData {
  /** Display name for the agent. */
  name?: string;
  /** Single emoji representing the agent. */
  emoji?: string;
  /** Visual theme or color scheme. */
  theme?: string;
  /** Character type / creature archetype. */
  creature?: string;
  /** Personality vibe in a few words. */
  vibe?: string;
  /** URL or identifier for the agent's avatar image. */
  avatar?: string;
  /** Agent's role description. */
  role?: string;
  /** Brief soul / essence description. */
  soul?: string;
  /** Personality quirks. */
  quirks?: string[];
}

/**
 * USER — Owner profile (static identity).
 * Stores stable, structured facts about the user: who they are, where
 * they are, and how they prefer to communicate. Always injected into
 * the system prompt. For dynamic/evolving knowledge discovered during
 * conversation use the memory tools (memory_store) or the MEMORY document.
 */
export interface UserData {
  /** User's display name. */
  name?: string;
  /** IANA timezone string (e.g., "America/New_York"). */
  timezone?: string;
  /** Preferred language for responses. */
  language?: string;
  /** Communication style preference (e.g., "concise", "detailed"). */
  communicationStyle?: string;
  /** Broad topic interests (e.g., ["TypeScript", "cooking"]). */
  interests?: string[];
  /** Stable work context (e.g., "software developer at Acme"). */
  workContext?: string;
  /** Short freeform notes about the user (static context only). */
  notes?: string;
  /**
   * What the user has told the agent they prefer, on any subject, as short
   * statements ("Prefers coffee over tea", "When a website asks for a human
   * check, hand me the browser without asking"). In every prompt, and
   * writable in static mode too, so a stated preference always applies.
   */
  preferences?: string[];
}

/**
 * SOUL — Persona & personality definition.
 * Shapes the agent's tone, values, and behavioral identity.
 */
export interface SoulData {
  /** Core truths / values the agent lives by. */
  coreTruths?: string[];
  /** Hard behavioral boundaries. */
  boundaries?: string[];
  /** Short personality vibe description (prose). */
  vibe?: string;
  /** Memory / continuity guidance (prose). */
  continuity?: string;
  /** User-defined custom persona sections. Key = section title, value = prose. */
  custom?: Record<string, string>;
}

/**
 * AGENTS — Agent operational guide.
 * High-level operating instructions for the agent.
 * These are *behavioral rules*, not user data or memory content.
 */
export interface AgentsData {
  /** How the agent's context loading works (prose). */
  contextGuide?: string;
  /** Group chat behavior guidance (prose). */
  groupBehavior?: string;
  /** User-defined custom sections. Key = section title, value = prose. */
  custom?: Record<string, string>;
}

/**
 * TOOLS — Environment & integration notes.
 * User-authored guidance for using configured tools and integrations.
 */
export interface ToolsData {
  /** General environment notes (prose). */
  notes?: string;
  /** Per-integration notes. Key = integration name, value = usage notes. */
  integrations?: Record<string, string>;
  /** Skill IDs enabled for this agent. Empty/undefined = all user skills. */
  enabledSkills?: string[];
}

/**
 * HEARTBEAT — Periodic task checklist.
 * List of tasks the agent should check during cron/heartbeat sessions.
 */
export interface HeartbeatData {
  /** Active heartbeat tasks. */
  tasks?: string[];
}

/**
 * BOOTSTRAP — First-run onboarding.
 * Deleted automatically after onboarding completes.
 */
export interface BootstrapData {
  /** Ordered onboarding steps. */
  steps?: string[];
  /** Important notes for the first interaction. */
  notes?: string[];
}

/**
 * MEMORY — Curated long-term memory summaries.
 * High-signal, evolving knowledge the agent has learned over time.
 * Always injected into the system prompt as persistent context.
 *
 * Distinction from USER:
 *   USER  = stable profile (name, timezone, language — rarely changes)
 *   MEMORY = evolving observations ("prefers dark mode", "dislikes meetings on Mondays")
 *
 * Distinction from memory tools (memory_store/memory_search):
 *   memory tools = transactional per-interaction recall from a larger store
 *   MEMORY doc   = curated summary of the most important long-term facts
 */
export interface MemoryData {
  /** Evolving user preferences discovered in conversation (not static profile fields). */
  userPreferences?: string[];
  /** Important facts to remember long-term. */
  keyFacts?: string[];
  /** Recurring patterns, workflows, or context the agent has observed. */
  patterns?: string[];
}

// ============================================================================
// Data Type Map (document type → data interface)
// ============================================================================

/**
 * Maps each prompt document type to its typed data interface.
 * Used in generics to provide type-safe access per document type.
 */
export interface PromptDataMap {
  IDENTITY: IdentityData;
  SOUL: SoulData;
  USER: UserData;
  AGENTS: AgentsData;
  TOOLS: ToolsData;
  HEARTBEAT: HeartbeatData;
  BOOTSTRAP: BootstrapData;
  MEMORY: MemoryData;
}

// ============================================================================
// Prompt Document (Cosmos DB)
// ============================================================================

/**
 * A prompt document stored in Cosmos DB with structured typed data.
 *
 * Partition key: userId — each user has their own set of prompt documents.
 * Document ID format: `{userId}:{agentId}:{documentType}` for uniqueness.
 *
 * The `data` field is typed as the union of all data interfaces. At runtime,
 * the actual shape is determined by `documentType`. For type-safe access,
 * use `getTypedData<T>(doc)` which narrows `data` to `PromptDataMap[T]`.
 *
 * TypeScript limitation: Making this a true discriminated union (one variant
 * per documentType) would break `ContainerHandle<PromptDocument>` generics
 * and construction from dynamic `documentType` values. The `getTypedData<T>()`
 * helper provides equivalent safety with better ergonomics.
 */
export interface PromptDocument extends BaseDocument {
  id: string;
  /** User who owns this document. Partition key. */
  userId: string;
  /** Agent this document belongs to (supports multi-agent). */
  agentId: string;
  /** The type of document (SOUL, AGENTS, USER, etc.). */
  documentType: PromptDocumentType;
  /**
   * Structured data fields for this document type.
   * Use `getTypedData<T>(doc)` for type-safe narrowed access.
   */
  data: PromptDataMap[PromptDocumentType];
  /** Monotonically increasing version (informational, not enforced server-side). */
  version: number;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
}

/**
 * Type-safe accessor for prompt document data.
 * Narrows the `data` field to the correct interface for the given document type.
 *
 * @example
 * ```ts
 * const doc = await store.load(userId, agentId, "SOUL");
 * if (doc) {
 *   const soul = getTypedData<"SOUL">(doc as PromptDocument & { documentType: "SOUL" });
 *   // soul is typed as SoulData
 * }
 * ```
 */
export function getTypedData<T extends PromptDocumentType>(
  doc: PromptDocument & { documentType: T },
): PromptDataMap[T] {
  return doc.data as PromptDataMap[T];
}

// ============================================================================
// Agent Identity (resolved from IDENTITY document + config + defaults)
// ============================================================================

/**
 * Resolved agent identity used at runtime.
 * Same shape as IdentityData — produced by merging
 * IDENTITY document + IdentityConfig + defaults.
 */
export type AgentIdentity = IdentityData;

// ============================================================================
// Identity Configuration (from app config, higher priority than document)
// ============================================================================

/**
 * Identity config from application settings.
 * Takes precedence over IDENTITY document values (config > document > default).
 */
export interface IdentityConfig {
  /** Override agent name. */
  name?: string;
  /** Override visual theme. */
  theme?: string;
  /** Override emoji. */
  emoji?: string;
  /** Override avatar URL. */
  avatar?: string;
}

// ============================================================================
// Prompt Context (runtime inputs for prompt assembly)
// ============================================================================

/**
 * Runtime context supplied when building the system prompt.
 * These values come from the request, channel config, and environment.
 */
export interface PromptContext {
  /** The user making the request. */
  userId: string;
  /** The agent handling the request. */
  agentId: string;
  /** Type of session. */
  sessionType: SessionType;
  /** How much of the system prompt to include. */
  promptMode: PromptMode;

  // -- Identity overrides (from config, highest priority) --
  /** Identity config from application settings. */
  identityConfig?: IdentityConfig;

  // -- Channel context --
  /** Per-channel system prompt override. */
  channelSystemPrompt?: string;
  /** Channel name / identifier (e.g., "telegram", "discord", "whatsapp"). */
  channelName?: string;

  // -- Group chat context --
  /** Whether this is a group chat. */
  isGroupChat?: boolean;
  /** Group name. */
  groupName?: string;
  /** Group member names/descriptions. */
  groupMembers?: string[];
  /** Group-specific system prompt. */
  groupSystemPrompt?: string;

  // -- Inbound metadata --
  /** Extra system prompt from inbound message metadata. */
  inboundMetaSystemPrompt?: string;

  // -- Runtime info --
  /** Current date/time in ISO-8601. */
  currentDateTime?: string;
  /** User's timezone (e.g., "America/New_York"). */
  userTimezone?: string;
  /** Model being used for this request. */
  modelId?: string;
  /** Provider being used. */
  providerId?: string;

  // -- Memory context (injected from memory layer) --
  /** Recalled memories relevant to the current conversation. */
  recalledMemories?: string;

  // -- Tools available --
  /** Names of function tools registered for this request. */
  toolNames?: string[];
  /**
   * Tool names the PREVIOUS run in this session called — the phase signal
   * for a phase-scoped gateway (`GatewayTextConfig.phases`). Absent or empty
   * lands on the first declared phase; irrelevant to flat gateways.
   */
  gatewaySeenTools?: string[];
  /**
   * Extra tool summaries to merge with the static toolSummaries from config.
   * Used for dynamically discovered tools (e.g. MCP server tools).
   */
  extraToolSummaries?: Record<string, string>;

  // -- Authorized senders --
  /** List of authorized sender identifiers. */
  authorizedSenders?: string[];

  // -- Compaction context --
  /** LLM-generated summary of compacted (older) conversation history. */
  compactionSummary?: string;

  // -- Episode context --
  /** Active episode theme names for associative priming. */
  activeEpisodeThemes?: string[];

  // -- Skills context --
  /** Skill statuses for the prompt skills section. */
  skillStatuses?: import("../skills/types.js").SkillStatus[];

  // -- Recency context --
  /** Recent session digest summaries for cross-session awareness. */
  recentDigests?: import("../digests/index.js").DigestDocument[];

  // -- Knowledge context --
  /** Auto-recalled knowledge chunks from Azure AI Search. */
  knowledgeContext?: string;

  // -- MCP server context --
  /**
   * Aggregated context from connected MCP servers.
   * Includes server instructions, resource content, and prompt guidance.
   * Injected near the tooling section so the LLM treats it as operational
   * guidance for using MCP tools.
   */
  mcpServerContext?: string;
}

// ============================================================================
// Assembled Prompt
// ============================================================================

/**
 * The fully assembled system prompt, ready to be set as
 * `ProviderRequest.instructions`.
 */
export interface AssembledPrompt {
  /** The full system prompt text. */
  instructions: string;
  /** Resolved agent identity (merged from config + IDENTITY document + defaults). */
  identity: AgentIdentity;
  /** Which prompt documents were included. */
  includedDocuments: PromptDocumentType[];
  /** Whether this is the agent's first run (BOOTSTRAP document exists). */
  isOnboarding: boolean;
  /** Total character count of the assembled prompt. */
  characterCount: number;
}

// ============================================================================
// Prompt Builder Options
// ============================================================================

/** Options controlling prompt assembly behavior. */
export interface PromptBuilderOptions {
  /** Max characters per rendered document section (default: 20_000). */
  maxDocumentChars?: number;
  /** Max total characters for all rendered documents combined (default: 150_000). */
  maxTotalDocumentChars?: number;
  /**
   * Silent reply token.
   * When the model has nothing to say (or has already sent a reply via the
   * message tool), it should respond with this token instead of generating
   * a duplicate conversational reply.
   */
  silentReplyToken?: string;
  /**
   * Heartbeat acknowledgment token.
   * Used when the model receives a heartbeat poll and there is no action
   * required.
   */
  heartbeatAckToken?: string;
  /**
   * Ratio of head content to keep when truncating (default: 0.8).
   * Head + tail = 1.0 (no gap).
   */
  truncationHeadRatio?: number;
  /**
   * Ratio of tail content to keep when truncating (default: 0.2).
   */
  truncationTailRatio?: number;
}

/** Default values for prompt builder options. */
export const DEFAULT_PROMPT_OPTIONS: Required<PromptBuilderOptions> = {
  maxDocumentChars: 20_000,
  maxTotalDocumentChars: 150_000,
  silentReplyToken: "NO_REPLY",
  heartbeatAckToken: "HEARTBEAT_OK",
  truncationHeadRatio: 0.8,
  truncationTailRatio: 0.2,
} as const;

// ============================================================================
// Onboarding State (stored in Cosmos DB)
// ============================================================================

/**
 * Tracks onboarding progress per user + agent.
 */
export interface OnboardingState extends BaseDocument {
  id: string;
  /** User being onboarded. Partition key. */
  userId: string;
  /** Agent being configured. */
  agentId: string;
  /** Whether onboarding has been completed. */
  completed: boolean;
  /** ISO-8601 timestamp when onboarding was completed. */
  completedAt?: string;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
}

// ============================================================================
// Loaded Prompt Document (used during prompt assembly)
// ============================================================================

/**
 * A prompt document loaded and rendered for injection into the system prompt.
 * Content has been rendered from structured data and potentially truncated.
 */
export interface LoadedPromptDoc {
  /** The document type (AGENTS, SOUL, etc.). */
  documentType: PromptDocumentType;
  /** The rendered text content (from structured data, potentially truncated). */
  content: string;
}

// ============================================================================
// Document Display Names (for prompt section headers)
// ============================================================================

/**
 * Human-readable display names for each prompt document type.
 * Used in prompt assembly for section headers.
 */
export const DOC_TYPE_DISPLAY_NAME: Readonly<
  Record<PromptDocumentType, string>
> = {
  AGENTS: "Agent Operating Guide",
  SOUL: "Soul & Persona",
  USER: "User Profile",
  IDENTITY: "Identity",
  TOOLS: "Tools & Environment",
  HEARTBEAT: "Heartbeat Tasks",
  BOOTSTRAP: "Onboarding",
  MEMORY: "Long-term Memory",
} as const;

// ============================================================================
// Field Schema — Single source of truth for field names, types & descriptions
// ============================================================================

/**
 * JSON Schema type identifiers used in field metadata.
 * - "string"  → plain string
 * - "string[]" → array of strings
 * - "record"  → Record<string, string> (object with string values)
 */
export type FieldSchemaType = "string" | "string[]" | "record";

export interface FieldSchema {
  /** JSON-style type for the field. */
  type: FieldSchemaType;
  /** Short human-readable description of the field. */
  description: string;
}

/**
 * Complete field metadata per document type.
 * This is the **single source of truth** for:
 *   - Which fields are updatable (`UPDATABLE_FIELDS` is derived from this)
 *   - Field types exposed in the tool schema description
 *   - Field descriptions for the LLM
 *
 * When you add/remove/change a field in the data interfaces above,
 * update `FIELD_SCHEMAS` and everything else follows automatically.
 *
 * BOOTSTRAP is empty — it's managed by the onboarding system.
 */
export const FIELD_SCHEMAS: Readonly<
  Record<PromptDocumentType, Readonly<Record<string, FieldSchema>>>
> = {
  IDENTITY: {
    name: { type: "string", description: "Display name for the agent" },
    emoji: { type: "string", description: "Single emoji representing the agent" },
    theme: { type: "string", description: "Visual theme or color scheme" },
    creature: { type: "string", description: "Character type / creature archetype" },
    vibe: { type: "string", description: "Personality vibe in a few words" },
    avatar: { type: "string", description: "URL or identifier for the agent's avatar image" },
    role: { type: "string", description: "Agent's role description" },
    soul: { type: "string", description: "Brief soul / essence description" },
    quirks: { type: "string[]", description: "Personality quirks" },
  },
  USER: {
    name: { type: "string", description: "User's display name (stable identity)" },
    timezone: { type: "string", description: "IANA timezone (e.g. 'America/New_York')" },
    language: { type: "string", description: "Preferred language for responses" },
    communicationStyle: { type: "string", description: "Communication style preference (e.g. 'concise', 'detailed')" },
    interests: { type: "string[]", description: "Broad topic interests (stable, not ephemeral preferences)" },
    workContext: { type: "string", description: "Stable work context (e.g. 'software developer at Acme')" },
    notes: { type: "string", description: "Short static notes about the user (preferences go in preferences)" },
    preferences: {
      type: "string[]",
      description:
        "What the user has told you they prefer, on any subject, one short statement each (e.g. 'Prefers coffee " +
        "over tea'). Always followed. The list is replaced as a whole: send every preference, the existing ones too",
    },
  },
  SOUL: {
    coreTruths: { type: "string[]", description: "Core truths / values the agent lives by" },
    boundaries: { type: "string[]", description: "Hard behavioral boundaries" },
    vibe: { type: "string", description: "Short personality vibe description" },
    continuity: { type: "string", description: "Memory / continuity guidance" },
    custom: { type: "record", description: "Custom persona sections (key = section title, value = prose)" },
  },
  AGENTS: {
    contextGuide: { type: "string", description: "How the agent's context loading works (operational instructions)" },
    groupBehavior: { type: "string", description: "Group chat behavior guidance" },
    custom: { type: "record", description: "Custom sections (key = section title, value = prose)" },
  },
  TOOLS: {
    notes: { type: "string", description: "General environment notes" },
    integrations: { type: "record", description: "Per-integration notes (key = integration name, value = usage notes)" },
    enabledSkills: { type: "string[]", description: "Skill IDs to enable for this agent (empty = all user skills)" },
  },
  HEARTBEAT: {
    tasks: { type: "string[]", description: "Active heartbeat tasks" },
  },
  BOOTSTRAP: {}, // Managed by onboarding system; prompt_update rejects BOOTSTRAP
  MEMORY: {
    userPreferences: { type: "string[]", description: "Preferences you've noticed yourself in conversation (ones the user states go in USER.preferences)" },
    keyFacts: { type: "string[]", description: "Important facts to remember long-term" },
    patterns: { type: "string[]", description: "Recurring patterns, workflows, or context the agent has observed over time" },
  },
} as const;

/**
 * Fields that the LLM is allowed to update per document type.
 * **Derived from `FIELD_SCHEMAS`** — do not edit manually.
 *
 * BOOTSTRAP is excluded — it is managed by the onboarding system and
 * cannot be updated via prompt_update (enforced in tools.ts).
 */
export const UPDATABLE_FIELDS: Readonly<
  Record<PromptDocumentType, readonly string[]>
> = Object.fromEntries(
  PROMPT_DOCUMENT_ORDER.map((dt) => [dt, Object.keys(FIELD_SCHEMAS[dt])]),
) as unknown as Record<PromptDocumentType, readonly string[]>;
