/**
 * Prompt Section — Compaction Summary
 *
 * Injects the LLM-generated summary of compacted (older) conversation
 * history. All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { CompactionTextConfig } from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the "## Conversation History Summary" section.
 */
export function buildCompactionSection(params: {
  compactionSummary?: string;
  cfg?: CompactionTextConfig;
}): string[] {
  if (!params.compactionSummary) return [];
  const cfg = params.cfg ?? loadPromptTextConfig().compaction;
  return [cfg.header, cfg.intro, params.compactionSummary, ""];
}
