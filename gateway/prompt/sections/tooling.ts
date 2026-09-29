/**
 * Prompt Section — Tooling
 *
 * Builds the "## Tooling" and "## Tool Call Style" sections.
 * Lists available function tools with their descriptions.
 *
 * All text and tool summaries are driven by PromptTextConfig (agentforeach.json).
 */

import type {
  ToolingTextConfig,
  ToolCallStyleTextConfig,
} from "../prompt-config.js";

// ============================================================================
// Kept for backward-compat exports (values now live in prompt-config defaults)
// ============================================================================

// Re-export constants that match the config defaults so existing imports
// (e.g. `import { CORE_TOOL_SUMMARIES } from "./tooling.js"`) still work.
// At runtime the builder passes the config-resolved values instead.
import { loadPromptTextConfig } from "../prompt-config.js";
export const CORE_TOOL_SUMMARIES: Readonly<Record<string, string>> =
  loadPromptTextConfig().toolSummaries;
export const TOOL_ORDER: readonly string[] = loadPromptTextConfig().toolOrder;

// ============================================================================
// Tool Line Builder
// ============================================================================

/**
 * Build formatted tool lines and a set of normalized available tool names.
 *
 * @param toolNames - Raw tool names from the request context.
 * @param toolSummaries - Per-tool description map (from config).
 * @param toolOrder - Canonical display order (from config).
 * @returns Tool display lines and a normalized set of available tools.
 */
export function buildToolLines(
  toolNames: string[],
  toolSummaries?: Readonly<Record<string, string>>,
  toolOrder?: readonly string[],
): {
  lines: string[];
  availableTools: Set<string>;
} {
  const summaries = toolSummaries ?? CORE_TOOL_SUMMARIES;
  const order = toolOrder ?? TOOL_ORDER;
  const orderSet = new Set<string>(order);

  const canonicalByNormalized = new Map<string, string>();

  for (const rawName of toolNames) {
    const name = rawName.trim();
    if (!name) continue;
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }

  const availableTools = new Set<string>(canonicalByNormalized.keys());
  const lines: string[] = [];

  // Ordered tools first
  for (const tool of order) {
    if (!availableTools.has(tool)) continue;
    const displayName = canonicalByNormalized.get(tool) ?? tool;
    const summary = summaries[tool];
    lines.push(summary ? `- ${displayName}: ${summary}` : `- ${displayName}`);
  }

  // Extra tools alphabetically
  const extras = Array.from(availableTools)
    .filter((tool) => !orderSet.has(tool))
    .sort((a, b) => a.localeCompare(b));

  for (const tool of extras) {
    const displayName = canonicalByNormalized.get(tool) ?? tool;
    const summary = summaries[tool];
    lines.push(summary ? `- ${displayName}: ${summary}` : `- ${displayName}`);
  }

  return { lines, availableTools };
}

// ============================================================================
// Section Builders
// ============================================================================

/**
 * Build the "## Tooling" section listing available tools.
 */
export function buildToolingSection(
  toolLines: string[],
  cfg?: ToolingTextConfig,
): string[] {
  const c = cfg ?? loadPromptTextConfig().tooling;
  return [
    c.header,
    c.intro,
    c.caseSensitiveNote,
    toolLines.length > 0 ? toolLines.join("\n") : c.emptyMessage,
    c.footer,
    "",
  ];
}

/**
 * Build the "## Tool Call Style" section with narration guidelines.
 */
export function buildToolCallStyleSection(
  cfg?: ToolCallStyleTextConfig,
): string[] {
  const c = cfg ?? loadPromptTextConfig().toolCallStyle;
  return [
    c.header,
    ...c.rules,
    "",
    c.responseFormat.header,
    ...c.responseFormat.rules,
    "",
  ];
}
