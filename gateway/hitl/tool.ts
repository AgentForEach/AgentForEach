/**
 * AgentForEach HITL Module — request_user_input Tool
 *
 * A first-class LLM tool that lets the agent explicitly request structured
 * input from the user. Unlike the config-driven HITL gate (which intercepts
 * MCP tool calls), this tool is called **by the LLM itself** whenever it
 * needs user input — the form type, title, options, and schema are all
 * dynamic and determined by the conversation context.
 *
 * Flow:
 *   1. LLM calls `request_user_input` with { type, title, subtitle, options, … }
 *   2. Runner triggers the HITL suspend → WebSocket pushes the form to the client
 *   3. The client shows a bottom sheet (text input, radio select, form, etc.)
 *   4. User submits → response goes back as the tool result to the LLM
 *   5. LLM continues with the user's data
 *
 * The LLM is fully in control of when and what to ask — no static config
 * needed. Deployments whose client renders extra widgets can offer them as
 * additional types via "hitl.customFormTypes" in agentforeach.json.
 */

import { loadHitlConfig } from "./config.js";

// ============================================================================
// Constants
// ============================================================================

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * The `request_user_input` tool definition exposed to the LLM.
 *
 * Uses the shared ToolDefinition shape (type: "function") so it can be
 * included alongside memory, cron, skill, and MCP tools.
 */
export const REQUEST_USER_INPUT_TOOL = {
  type: "function" as const,
  name: REQUEST_USER_INPUT_TOOL_NAME,
  description:
    "Use this tool when you need STRUCTURED input from the user — choices, confirmations, or several fields at once. " +
    "Do NOT use it for greetings, informational replies, explanations, or general conversation — respond in plain text for those.\n\n" +
    "Pick the right type based on what you need:\n" +
    "• Need the user to choose between options? → single_select\n" +
    "• Need yes/no on proposed data? → confirmation\n" +
    "• Need several choices at once? → multi_select\n" +
    "• Need a custom multi-field form? → form\n" +
    "• Need open-ended text (last resort)? → text_input\n\n" +
    "One call per turn. The user's response is returned as the tool result.",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["text_input", "confirmation", "single_select", "multi_select", "form"] as string[],
        description:
          "single_select / multi_select = choice list (provide options[]). " +
          "confirmation = yes/no review (provide proposedData). " +
          "form = custom fields (provide schema). " +
          "text_input = free text (last resort).",
      },
      title: {
        type: "string",
        description: "Form header title.",
      },
      subtitle: {
        type: "string",
        description: "Description shown below the title explaining what is needed.",
      },
      options: {
        type: "array",
        description: "Choices for single_select / multi_select.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
            description: { type: "string" },
          },
          required: ["label", "value"],
        },
      },
      proposedData: {
        type: "object",
        additionalProperties: true,
        description:
          "Pre-filled/default values. " +
          "For confirmation: key-value pairs the user reviews. " +
          "For form: initial field values.",
      },
      schema: {
        type: "object",
        additionalProperties: true,
        description:
          "JSON Schema for 'form' type. Properties become fields; use 'enum' for dropdowns, " +
          "'type: number' for numeric input. Mark fields in 'required' array.",
      },
      uiHints: {
        type: "object",
        additionalProperties: true,
        description:
          "Layout hints: layout ('single-column'|'two-column'), " +
          "groups ([{label, fields[]}]), hiddenFields, requiredFromHuman.",
      },
    },
    required: ["type", "title"],
    additionalProperties: false,
  },
};

/**
 * The widget-surface tool with any client-rendered form types from
 * agentforeach.json ("hitl.customFormTypes": name → description) appended to the
 * built-in `type` enum. Without custom types this is REQUEST_USER_INPUT_TOOL
 * unchanged. Whatever the model picks is forwarded to the client as the
 * formType string; any extra details it needs go in proposedData.
 */
export function buildRequestUserInputTool(
  customFormTypes: ReadonlyMap<string, string>,
) {
  const typeParam = REQUEST_USER_INPUT_TOOL.parameters.properties.type;
  const custom = [...customFormTypes].filter(([name]) => !typeParam.enum.includes(name));
  if (custom.length === 0) return REQUEST_USER_INPUT_TOOL;

  return {
    ...REQUEST_USER_INPUT_TOOL,
    parameters: {
      ...REQUEST_USER_INPUT_TOOL.parameters,
      properties: {
        ...REQUEST_USER_INPUT_TOOL.parameters.properties,
        type: {
          ...typeParam,
          enum: [...typeParam.enum, ...custom.map(([name]) => name)],
          description:
            typeParam.description +
            custom.map(([name, description]) => ` ${name} = ${description}`).join(""),
        },
      },
    },
  };
}

// ============================================================================
// Channel variant (message-thread surfaces)
// ============================================================================

/**
 * The `request_user_input` variant offered on hitlWidgets=false surfaces
 * (WhatsApp, Telegram). Same tool name — the asking mechanism is ONE — but
 * the schema shrinks to what a message thread can render natively: a single
 * bounded choice. There is no suspend/resume: the runner captures the
 * options onto the turn's response, the channel renders them as reply
 * buttons or a list, and the user's tap arrives as their next message.
 */
export const CHANNEL_REQUEST_USER_INPUT_TOOL = {
  type: "function" as const,
  name: REQUEST_USER_INPUT_TOOL_NAME,
  description:
    "Ask the user a bounded-choice question using this channel's NATIVE selection UI (tappable buttons for 2-3 options, a selectable list for 4-10). " +
    "Use it for EVERY choice between known options — picking between variants, yes/no confirmations, browsing what you can help with. " +
    "NEVER enumerate options as prose text and ask the user to type an answer.\n\n" +
    "After calling this tool, end your turn with ONE short line asking the question — that line becomes the message the options attach to, so do not repeat the options in it. " +
    "The user's selection arrives as their next message (the option's label).",
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["single_select"],
        description: "Only single_select exists on this surface.",
      },
      title: {
        type: "string",
        description:
          "Short label for the choice (used as the list-opening button when there are 4+ options, e.g. 'Choose one').",
      },
      options: {
        type: "array",
        description:
          "2-10 choices. Labels are tapped verbatim, so keep them short (buttons cap at 20 characters, list rows at 24) and in the user's language.",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
            description: {
              type: "string",
              description: "One-line hint under the label (list rendering only, 72 characters).",
            },
          },
          required: ["label", "value"],
        },
      },
    },
    required: ["type", "title", "options"],
    additionalProperties: false,
  },
};

/**
 * Tool definition array for hitlWidgets=false surfaces.
 */
export function getChannelRequestUserInputToolDefinitions() {
  return [CHANNEL_REQUEST_USER_INPUT_TOOL];
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a tool name is the request_user_input tool.
 */
export function isRequestUserInputTool(toolName: string): boolean {
  return toolName === REQUEST_USER_INPUT_TOOL_NAME;
}

/**
 * Get the tool definition array (single element) for inclusion
 * in the runner's tool list. Custom form types come from agentforeach.json.
 */
export function getRequestUserInputToolDefinitions() {
  return [buildRequestUserInputTool(loadHitlConfig().customFormTypes)];
}
