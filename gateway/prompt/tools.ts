/**
 * AgentForEach Prompt Layer — LLM Function Tools
 *
 * Defines `prompt_get` and `prompt_update` as function-type tools
 * that allow the LLM to read and modify its own prompt configuration
 * documents in Cosmos DB.
 *
 * Tools:
 *   - prompt_get: Read current fields of a prompt document
 *   - prompt_update: Update specific fields of a prompt document
 *
 * These follow the same ToolDefinition pattern as memory and cron tools.
 */

import type { ToolDefinition } from "../memory/types.js";
import type { PromptDocumentStore } from "./store.js";
import type { PromptDocumentType, PromptDataMap, FieldSchemaType } from "./types.js";
import {
  UPDATABLE_FIELDS,
  PROMPT_DOCUMENT_ORDER,
  FIELD_SCHEMAS,
} from "./types.js";
import { isPromptStatic, STATIC_LOCKED_TYPES } from "./prompt-config.js";
import { redactId } from "../utils/redact.js";

// ============================================================================
// Tool Names
// ============================================================================

export const PROMPT_GET_TOOL_NAME = "prompt_get";
export const PROMPT_UPDATE_TOOL_NAME = "prompt_update";

/**
 * Check if a tool name is a prompt tool.
 */
export function isPromptTool(name: string): boolean {
  return name === PROMPT_GET_TOOL_NAME || name === PROMPT_UPDATE_TOOL_NAME;
}

// ============================================================================
// Tool Definitions
// ============================================================================

const DOCUMENT_TYPES: string[] = [...PROMPT_DOCUMENT_ORDER];

// ============================================================================
// Dynamic description builder (derived from FIELD_SCHEMAS)
// ============================================================================

/** Map FieldSchemaType → human-readable type label for the LLM. */
function typeLabel(t: FieldSchemaType): string {
  switch (t) {
    case "string":
      return "string";
    case "string[]":
      return "string[]";
    case "record":
      return "object (key-value pairs of strings)";
  }
}

/**
 * Build the "Field types per documentType" block for the tool description
 * directly from `FIELD_SCHEMAS` so it can never drift from the types.
 *
 * When `staticMode` is true, only USER fields are included (all others
 * are read-only and the agent cannot update them).
 */
function buildFieldTypesDescription(staticMode: boolean): string {
  const lines: string[] = [];
  for (const dt of PROMPT_DOCUMENT_ORDER) {
    if (staticMode && dt !== "USER") continue;
    const schema = FIELD_SCHEMAS[dt];
    const fields = Object.entries(schema);
    if (fields.length === 0) continue; // skip BOOTSTRAP
    const fieldDescs = fields
      .map(([name, { type, description }]) => `${name} (${typeLabel(type)}): ${description}`)
      .join("; ");
    lines.push(`${dt} — ${fieldDescs}`);
  }
  return lines.join("\n");
}

export const PROMPT_GET_TOOL: ToolDefinition = {
  type: "function",
  name: PROMPT_GET_TOOL_NAME,
  description:
    "Read the current configuration of a prompt document. " +
    "Use this to check your current identity, user profile, soul, tools config, " +
    "or any other prompt configuration before making changes. " +
    "Returns the structured fields of the requested document type.",
  parameters: {
    type: "object",
    properties: {
      documentType: {
        type: "string",
        description:
          "The type of prompt document to read. " +
          "IDENTITY = your name/emoji/persona, " +
          "USER = owner profile, " +
          "SOUL = your personality & values, " +
          "AGENTS = operating guide, " +
          "TOOLS = environment notes, " +
          "HEARTBEAT = periodic tasks, " +
          "MEMORY = curated long-term memories.",
        enum: DOCUMENT_TYPES,
      },
    },
    required: ["documentType"],
    additionalProperties: false,
  },
};

/**
 * Build the `prompt_update` tool definition dynamically based on the
 * current prompt config mode (static vs dynamic).
 *
 * - **static**: Only `USER` is listed as an updatable document type.
 * - **dynamic**: All document types are updatable (current behaviour).
 */
function buildPromptUpdateTool(staticMode: boolean): ToolDefinition {
  const allowedTypes = staticMode
    ? DOCUMENT_TYPES.filter((dt) => !STATIC_LOCKED_TYPES.has(dt))
    : [...DOCUMENT_TYPES];

  const modeNote = staticMode
    ? "\n\nPrompt mode: STATIC — only USER can be updated. " +
      "All other document types (IDENTITY, SOUL, AGENTS, TOOLS, HEARTBEAT, MEMORY) are read-only."
    : "";

  return {
    type: "function",
    name: PROMPT_UPDATE_TOOL_NAME,
    description:
      "Update specific fields in a prompt document. " +
      (staticMode
        ? "Use this to save user preferences and profile information. "
        : "Use this to update your identity, save user preferences, modify your persona, " +
          "add heartbeat tasks, or update any prompt configuration. ") +
      "Only the specified fields are changed; other fields remain untouched. " +
      "Changes take effect on the next request.\n\n" +
      "Where to store what:\n" +
      "- USER = stable profile identity (name, timezone, language). Rarely changes.\n" +
      (staticMode
        ? ""
        : "- MEMORY = evolving knowledge learned over time (preferences discovered in conversation, key facts, observed patterns).\n" +
          "- AGENTS = operational instructions for HOW the agent should behave (not user data or memory content).\n" +
          '- Example: "My name is Alice" → USER.name. "I prefer dark themes" → MEMORY.userPreferences.\n\n') +
      "Field types per documentType:\n" +
      buildFieldTypesDescription(staticMode) +
      "\n\nSet any field to null to clear it." +
      modeNote +
      "\n\nTo finish first-run onboarding and remove BOOTSTRAP from future prompts, set completeOnboarding=true.",
    parameters: {
      type: "object",
      properties: {
        documentType: {
          type: "string",
          description: staticMode
            ? "The type of prompt document to update. Only USER is writable in static mode."
            : "The type of prompt document to update.",
          enum: allowedTypes,
        },
        updates: {
          type: "object",
          description:
            "An object of field-value pairs to update. " +
            "Keys must be valid field names for the chosen documentType (see tool description). " +
            "Values must match the expected type for each field. " +
            'Example for USER: {"timezone": "America/New_York", "name": "Alice"}.' +
            (staticMode
              ? ""
              : ' Example for IDENTITY: {"name": "Aria", "emoji": "✨", "vibe": "Playful and witty"}.' +
                ' Example for HEARTBEAT: {"tasks": ["Check weather forecast", "Review pending reminders"]}.' +
                ' Example for SOUL: {"coreTruths": ["Be helpful", "Be honest"]}.' +
                ' Example for TOOLS: {"integrations": {"calendar": "Use for scheduling"}}.'),
        },
        completeOnboarding: {
          type: "boolean",
          description:
            "When true, marks onboarding complete and removes BOOTSTRAP so onboarding flow is not included in future prompts.",
        },
      },
      required: ["documentType", "updates"],
      additionalProperties: false,
    },
  };
}

// ============================================================================
// Tool Definitions Accessor
// ============================================================================

/**
 * Get all prompt tool definitions for registration with the LLM provider.
 * The `prompt_update` tool is built dynamically based on the current
 * prompt config mode (static → only USER writable, dynamic → all).
 */
export function getPromptToolDefinitions(): ToolDefinition[] {
  return [PROMPT_GET_TOOL, buildPromptUpdateTool(isPromptStatic())];
}

// ============================================================================
// Tool Handler
// ============================================================================

/**
 * Handles prompt tool calls from the LLM.
 * Reads and writes structured prompt documents in Cosmos DB.
 */
export class PromptToolHandler {
  private store: PromptDocumentStore;

  constructor(store: PromptDocumentStore) {
    this.store = store;
  }

  /**
   * Handle a prompt tool call.
   *
   * @param toolName - The tool being called (prompt_get or prompt_update).
   * @param args - Parsed arguments from the LLM.
   * @param userId - The authenticated user ID.
   * @param agentId - The agent ID (defaults to "default").
   * @returns JSON string result to feed back to the LLM.
   */
  async handle(
    toolName: string,
    args: Record<string, unknown>,
    userId: string,
    agentId: string = "default",
  ): Promise<string> {
    try {
      switch (toolName) {
        case PROMPT_GET_TOOL_NAME:
          return await this.handleGet(args, userId, agentId);
        case PROMPT_UPDATE_TOOL_NAME:
          return await this.handleUpdate(args, userId, agentId);
        default:
          return JSON.stringify({ error: `Unknown prompt tool: ${toolName}` });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error in prompt tool";
      console.error(
        `[prompt-tools] Error in ${toolName} for ${redactId(userId)}:${agentId}: ${message}`,
      );
      return JSON.stringify({ error: message });
    }
  }

  // --------------------------------------------------------------------------
  // GET
  // --------------------------------------------------------------------------

  private async handleGet(
    args: Record<string, unknown>,
    userId: string,
    agentId: string,
  ): Promise<string> {
    const documentType = this.resolveDocumentType(args);
    if (!documentType) {
      return JSON.stringify({
        error: `Invalid documentType. Valid types: ${PROMPT_DOCUMENT_ORDER.join(", ")}`,
      });
    }

    const data = await this.store.getData(userId, agentId, documentType);
    if (!data) {
      return JSON.stringify({
        documentType,
        data: null,
        message: `No ${documentType} document found. It will be created when you update it.`,
      });
    }

    return JSON.stringify({
      documentType,
      data,
      updatableFields: UPDATABLE_FIELDS[documentType],
    });
  }

  // --------------------------------------------------------------------------
  // UPDATE
  // --------------------------------------------------------------------------

  private async handleUpdate(
    args: Record<string, unknown>,
    userId: string,
    agentId: string,
  ): Promise<string> {
    const documentType = this.resolveDocumentType(args);
    if (!documentType) {
      return JSON.stringify({
        error: `Invalid documentType. Valid types: ${PROMPT_DOCUMENT_ORDER.join(", ")}`,
      });
    }

    const completeOnboarding = args.completeOnboarding === true;

    // BOOTSTRAP and (in static mode) locked documents can't be edited, but
    // completing onboarding must still work whichever document the model
    // names, or BOOTSTRAP is re-injected on every turn forever.
    const lockedReason =
      documentType === "BOOTSTRAP"
        ? "BOOTSTRAP is managed by the onboarding system and cannot be directly updated."
        : isPromptStatic() && STATIC_LOCKED_TYPES.has(documentType)
          ? `Prompt mode is static — ${documentType} is read-only. Only USER can be updated in static mode.`
          : undefined;
    if (lockedReason) {
      if (!completeOnboarding) return JSON.stringify({ error: lockedReason });
      await this.store.completeOnboarding(userId, agentId);
      return JSON.stringify({
        documentType,
        updated: [],
        onboardingCompleted: true,
        message: `Onboarding completed; BOOTSTRAP will be removed from future prompts. No fields were changed: ${lockedReason}`,
      });
    }

    // Parse updates
    const updates = this.parseUpdates(args);
    if (!updates) {
      return JSON.stringify({
        error:
          'Invalid updates. Provide a JSON string of field-value pairs, e.g.: {"name": "Aria"}',
      });
    }

    // Validate field names
    const allowedFields = UPDATABLE_FIELDS[documentType];
    const invalidFields = Object.keys(updates).filter(
      (f) => !allowedFields.includes(f),
    );
    if (invalidFields.length > 0) {
      return JSON.stringify({
        error: `Invalid fields for ${documentType}: ${invalidFields.join(", ")}. Allowed: ${allowedFields.join(", ")}`,
      });
    }

    // Check for empty updates
    if (Object.keys(updates).length === 0 && !completeOnboarding) {
      return JSON.stringify({
        error:
          "No fields to update. Provide at least one field-value pair, or set completeOnboarding=true.",
      });
    }

    let version: number | undefined;
    let updatedFields: string[] = [];

    if (Object.keys(updates).length > 0) {
      // Apply the update
      const doc = await this.store.patchData(
        userId,
        agentId,
        documentType,
        updates as Partial<PromptDataMap[typeof documentType]>,
      );
      version = doc.version;
      updatedFields = Object.keys(updates);
    }

    if (completeOnboarding) {
      await this.store.completeOnboarding(userId, agentId);
    }

    return JSON.stringify({
      documentType,
      updated: updatedFields,
      version,
      onboardingCompleted: completeOnboarding,
      message: completeOnboarding
        ? `Updated ${updatedFields.length} field(s) in ${documentType} and completed onboarding. BOOTSTRAP will be removed from future prompts.`
        : `Updated ${updatedFields.length} field(s) in ${documentType}. Changes take effect on the next request.`,
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve document type from args with case-insensitive matching.
   * Only accepts the canonical `documentType` parameter name
   * (as declared in the tool schema).
   */
  private resolveDocumentType(
    args: Record<string, unknown>,
  ): PromptDocumentType | null {
    const raw = args.documentType;
    if (!raw || typeof raw !== "string") return null;

    const upper = raw.trim().toUpperCase() as PromptDocumentType;
    if (PROMPT_DOCUMENT_ORDER.includes(upper)) return upper;

    return null;
  }

  /**
   * Parse update fields from args. Handles both pre-parsed objects and JSON strings.
   * Only accepts the canonical `updates` parameter name (as declared in the tool schema).
   */
  private parseUpdates(
    args: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const raw = args.updates;
    if (!raw) return null;

    // Already an object (pre-parsed by the orchestrator)
    if (typeof raw === "object" && !Array.isArray(raw) && raw !== null) {
      return raw as Record<string, unknown>;
    }

    // JSON string
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          parsed !== null
        ) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }

    return null;
  }
}
