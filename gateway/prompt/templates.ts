/**
 * AgentForEach Prompt Layer — Templates & Renderers
 *
 * Loads seed data for prompt configuration documents from agentforeach.json
 * ("templates" section) and provides renderers that convert structured
 * data into prompt text for LLM consumption.
 *
 * Templates are structured objects written to Cosmos DB during onboarding.
 * Renderers produce the text fragments injected into the system prompt.
 */

import { loadConfigSection } from "../utils/index.js";

import type {
  PromptDocumentType,
  PromptDataMap,
  AgentsData,
  SoulData,
  UserData,
  IdentityData,
  ToolsData,
  HeartbeatData,
  BootstrapData,
  MemoryData,
} from "./types.js";

// ============================================================================
// Template loading from agentforeach.json
// ============================================================================

/** Raw shape of the "templates" section in agentforeach.json. */
type TemplatesJsonConfig = {
  [T in PromptDocumentType]: PromptDataMap[T];
};

/** Cached templates loaded from config. */
let _cached: TemplatesJsonConfig | null = null;

function loadTemplates(): TemplatesJsonConfig {
  if (_cached) return _cached;

  const section = loadConfigSection<TemplatesJsonConfig>("templates");
  if (!section) {
    throw new Error(
      'Unable to locate "templates" section in agentforeach.json. ' +
        "Ensure the templates section exists with keys: AGENTS, SOUL, USER, IDENTITY, TOOLS, HEARTBEAT, BOOTSTRAP, MEMORY.",
    );
  }
  _cached = section;
  return _cached;
}

/**
 * Reset cached templates (for testing).
 */
export function resetTemplatesCache(): void {
  _cached = null;
}

// ============================================================================
// Template Registry
// ============================================================================

/**
 * Map of document types to their default structured data,
 * loaded from the "templates" section of agentforeach.json.
 *
 * Typed per-key so `DEFAULT_TEMPLATES.AGENTS` returns `AgentsData` (not a union).
 *
 * NOTE: This is a getter-based object so templates are loaded lazily from config.
 */
export const DEFAULT_TEMPLATES: {
  readonly [T in PromptDocumentType]: PromptDataMap[T];
} = new Proxy({} as { [T in PromptDocumentType]: PromptDataMap[T] }, {
  get(_target, prop: string) {
    return loadTemplates()[prop as PromptDocumentType];
  },
  ownKeys() {
    return Object.keys(loadTemplates());
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const templates = loadTemplates();
    if (prop in templates) {
      return {
        configurable: true,
        enumerable: true,
        value: templates[prop as PromptDocumentType],
      };
    }
    return undefined;
  },
});

/**
 * Get the default template data for a given document type.
 */
export function getDefaultTemplate<T extends PromptDocumentType>(
  documentType: T,
): PromptDataMap[T] {
  return loadTemplates()[documentType] as PromptDataMap[T];
}

// ============================================================================
// Renderers — Structured data → prompt text
// ============================================================================

/**
 * Render structured document data into prompt text for LLM consumption.
 * Each document type has its own rendering logic that produces clean,
 * token-efficient text without markdown cruft.
 *
 * The switch statement dispatches on `documentType` and narrows `data`
 * with a type assertion. This is safe because the store guarantees that
 * `data` matches the type implied by `documentType` (enforced at write time).
 */
export function renderDocumentData(
  documentType: PromptDocumentType,
  data: unknown,
): string {
  const asPlainObject = <T,>(v: unknown): Partial<T> => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return v as Partial<T>;
  };

  // Type assertions below are safe: the store ensures documentType ↔ data consistency.
  // A discriminated union on PromptDocument would eliminate the need for these casts,
  // but breaks Collection<PromptDocument> generics (see types.ts for details).
  switch (documentType) {
    case "AGENTS":
      return renderAgents(asPlainObject<AgentsData>(data));
    case "SOUL":
      return renderSoul(asPlainObject<SoulData>(data));
    case "USER":
      return renderUser(asPlainObject<UserData>(data));
    case "IDENTITY":
      return renderIdentity(asPlainObject<IdentityData>(data));
    case "TOOLS":
      return renderTools(asPlainObject<ToolsData>(data));
    case "HEARTBEAT":
      return renderHeartbeat(asPlainObject<HeartbeatData>(data));
    case "BOOTSTRAP":
      return renderBootstrap(asPlainObject<BootstrapData>(data));
    case "MEMORY":
      return renderMemory(asPlainObject<MemoryData>(data));
    default:
      return "";
  }
}

// -- Individual Renderers ---------------------------------------------------

function renderAgents(data: Partial<AgentsData>): string {
  const lines: string[] = [];

  if (typeof data.contextGuide === "string" && data.contextGuide.trim()) {
    lines.push("## How Your Context Works", data.contextGuide, "");
  }
  if (typeof data.groupBehavior === "string" && data.groupBehavior.trim()) {
    lines.push("## Group Chat Behavior", data.groupBehavior, "");
  }
  if (typeof data.custom === "object" && data.custom !== null) {
    const custom = data.custom as Record<string, unknown>;
    for (const [title, content] of Object.entries(custom)) {
      if (typeof content === "string" && content.trim()) {
        lines.push(`## ${title}`, content, "");
      }
    }
  }

  return lines.join("\n").trim();
}

function renderSoul(data: Partial<SoulData>): string {
  const lines: string[] = [];

  if (Array.isArray(data.coreTruths) && data.coreTruths.length > 0) {
    lines.push("## Core Truths", ...data.coreTruths.map((t) => `- ${t}`), "");
  }
  if (Array.isArray(data.boundaries) && data.boundaries.length > 0) {
    lines.push("## Boundaries", ...data.boundaries.map((b) => `- ${b}`), "");
  }
  if (typeof data.vibe === "string" && data.vibe.trim()) {
    lines.push("## Vibe", data.vibe, "");
  }
  if (typeof data.continuity === "string" && data.continuity.trim()) {
    lines.push("## Continuity", data.continuity, "");
  }
  if (typeof data.custom === "object" && data.custom !== null) {
    const custom = data.custom as Record<string, unknown>;
    for (const [title, content] of Object.entries(custom)) {
      if (typeof content === "string" && content.trim()) {
        lines.push(`## ${title}`, content, "");
      }
    }
  }

  return lines.join("\n").trim();
}

function renderUser(data: Partial<UserData>): string {
  const lines: string[] = [];
  const entries: [string, string | undefined][] = [
    ["Name", typeof data.name === "string" ? data.name : undefined],
    ["Timezone", typeof data.timezone === "string" ? data.timezone : undefined],
    ["Language", typeof data.language === "string" ? data.language : undefined],
    [
      "Communication style",
      typeof data.communicationStyle === "string"
        ? data.communicationStyle
        : undefined,
    ],
    [
      "Work context",
      typeof data.workContext === "string" ? data.workContext : undefined,
    ],
  ];

  for (const [label, value] of entries) {
    if (value?.trim()) {
      lines.push(`- **${label}:** ${value}`);
    }
  }

  if (Array.isArray(data.interests) && data.interests.length > 0) {
    lines.push(`- **Interests:** ${data.interests.join(", ")}`);
  }
  if (typeof data.notes === "string" && data.notes.trim()) {
    lines.push("", "## Notes", data.notes);
  }
  const preferences = Array.isArray(data.preferences)
    ? data.preferences.filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : [];
  if (preferences.length > 0) {
    lines.push("", "## Preferences", "What the user has told you they prefer. Follow these.", ...preferences.map((p) => `- ${p}`));
  }

  return lines.join("\n").trim();
}

function renderIdentity(data: Partial<IdentityData>): string {
  const lines: string[] = [];
  const entries: [string, string | undefined][] = [
    ["Name", typeof data.name === "string" ? data.name : undefined],
    ["Emoji", typeof data.emoji === "string" ? data.emoji : undefined],
    [
      "Creature",
      typeof data.creature === "string" ? data.creature : undefined,
    ],
    ["Vibe", typeof data.vibe === "string" ? data.vibe : undefined],
    ["Role", typeof data.role === "string" ? data.role : undefined],
    ["Soul", typeof data.soul === "string" ? data.soul : undefined],
    ["Theme", typeof data.theme === "string" ? data.theme : undefined],
    ["Avatar", typeof data.avatar === "string" ? data.avatar : undefined],
  ];

  for (const [label, value] of entries) {
    if (value?.trim()) {
      lines.push(`- **${label}:** ${value}`);
    }
  }

  if (Array.isArray(data.quirks) && data.quirks.length > 0) {
    lines.push(`- **Quirks:** ${data.quirks.join(", ")}`);
  }

  return lines.join("\n").trim();
}

function renderTools(data: Partial<ToolsData>): string {
  const lines: string[] = [];

  if (typeof data.notes === "string" && data.notes.trim()) {
    lines.push(data.notes);
  }

  if (typeof data.integrations === "object" && data.integrations !== null) {
    const integrations = data.integrations as Record<string, unknown>;
    const entries = Object.entries(integrations).filter(
      ([, v]) => typeof v === "string" && v.trim(),
    ) as Array<[string, string]>;
    if (entries.length > 0) {
      lines.push("", "## Integrations");
      for (const [name, notes] of entries) {
        lines.push(`### ${name}`, notes, "");
      }
    }
  }

  return lines.join("\n").trim();
}

function renderHeartbeat(data: Partial<HeartbeatData>): string {
  if (!Array.isArray(data.tasks) || data.tasks.length === 0) return "";
  return data.tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

function renderBootstrap(data: Partial<BootstrapData>): string {
  const lines: string[] = ["Welcome! This is your first conversation.", ""];

  if (Array.isArray(data.steps) && data.steps.length > 0) {
    lines.push("## Onboarding Flow");
    lines.push(...data.steps.map((s, i) => `${i + 1}. ${s}`));
    lines.push("");
  }

  if (Array.isArray(data.notes) && data.notes.length > 0) {
    lines.push("## Important");
    lines.push(...data.notes.map((n) => `- ${n}`));
    lines.push("");
  }

  return lines.join("\n").trim();
}

function renderMemory(data: Partial<MemoryData>): string {
  const lines: string[] = [];

  if (Array.isArray(data.userPreferences) && data.userPreferences.length > 0) {
    lines.push(
      "## User Preferences",
      ...data.userPreferences.map((p) => `- ${p}`),
      "",
    );
  }
  if (Array.isArray(data.keyFacts) && data.keyFacts.length > 0) {
    lines.push("## Key Facts", ...data.keyFacts.map((f) => `- ${f}`), "");
  }
  if (Array.isArray(data.patterns) && data.patterns.length > 0) {
    lines.push(
      "## Patterns & Context",
      ...data.patterns.map((p) => `- ${p}`),
      "",
    );
  }

  return lines.join("\n").trim();
}
