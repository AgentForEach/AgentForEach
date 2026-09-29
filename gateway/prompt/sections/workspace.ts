/**
 * Prompt Section — Workspace
 *
 * Builds workspace context sections.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { WorkspaceTextConfig } from "../prompt-config.js";

/**
 * Build the "## Workspace" section.
 */
export function buildWorkspaceSection(cfg?: WorkspaceTextConfig): string[] {
  if (!cfg) return [];
  return [cfg.header, ...cfg.lines, ""];
}
