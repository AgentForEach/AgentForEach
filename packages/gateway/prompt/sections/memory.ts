/**
 * Prompt Section — Memory
 *
 * Builds the "## Memory Recall" and "## Recalled Memories" sections.
 * Controls how the agent interacts with stored user memories.
 *
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type {
  MemoryRecallTextConfig,
  RecalledMemoriesTextConfig,
} from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the "## Memory Recall" section with tool usage guidance.
 */
export function buildMemoryRecallSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  cfg?: MemoryRecallTextConfig;
}): string[] {
  if (params.isMinimal) return [];

  const hasMemoryTool =
    params.availableTools.has("memory_search") ||
    params.availableTools.has("memory_get") ||
    params.availableTools.has("memory_store") ||
    params.availableTools.has("memory_forget");

  if (!hasMemoryTool) return [];

  const cfg = params.cfg ?? loadPromptTextConfig().memoryRecall;
  const lines = [cfg.header, cfg.intro, "", cfg.toolGuideHeader, `- ${cfg.memorySearchDesc}`];

  if (params.availableTools.has("memory_get")) {
    lines.push(`- ${cfg.memoryGetDesc}`);
  }
  if (params.availableTools.has("episode_recall")) {
    lines.push(`- ${cfg.episodeRecallDesc}`);
  }
  if (params.availableTools.has("session_search")) {
    lines.push(`- ${cfg.sessionSearchDesc}`);
  }

  lines.push("", cfg.lowConfidenceNote, "");
  return lines;
}

/**
 * Build the "## Recalled Memories" section with injected memory context.
 */
export function buildRecalledMemoriesSection(params: {
  isMinimal: boolean;
  recalledMemories?: string;
  cfg?: RecalledMemoriesTextConfig;
}): string[] {
  if (params.isMinimal) return [];

  const content = params.recalledMemories?.trim();
  if (!content) return [];

  const cfg = params.cfg ?? loadPromptTextConfig().recalledMemories;
  return [cfg.header, cfg.intro, cfg.trustWarning, "<recalled-memories>", content, "</recalled-memories>", ""];
}
