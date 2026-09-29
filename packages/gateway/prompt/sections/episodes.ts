/**
 * Prompt Section — Episode Memory Instructions
 *
 * Tells the LLM about the episode tools and when/how to use them.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { EpisodesTextConfig } from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the "## Episode Memory" section with tool usage guidance.
 */
export function buildEpisodesSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  cfg?: EpisodesTextConfig;
}): string[] {
  if (params.isMinimal) return [];

  const hasRecall = params.availableTools.has("episode_recall");
  const hasCreate = params.availableTools.has("episode_create");
  const hasUpdate = params.availableTools.has("episode_update");

  if (!hasRecall) return [];

  const cfg = params.cfg ?? loadPromptTextConfig().episodes;
  const lines: string[] = [
    cfg.header,
    ...cfg.intro,
    "",
    cfg.recallHeader,
    cfg.recallIntro,
    ...cfg.recallRules.map((r) => `- ${r}`),
    cfg.recallCaveat,
    "",
  ];

  if (hasCreate && hasUpdate) {
    lines.push(
      cfg.managingHeader,
      cfg.managingIntro,
      ...cfg.managingSteps.map((s, i) => `${i + 1}. ${s}`),
      "",
      "Guidelines for episode management:",
      ...cfg.managingGuidelines.map((g) => `- ${g}`),
      "",
    );
  }

  return lines;
}

/**
 * This turn's active episode themes (associative priming). Separate from
 * the episode instructions, which are the same every turn: the prompt keeps
 * per-turn content at the end so its static prefix can be cached.
 */
export function buildActiveEpisodesSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  activeEpisodeThemes?: string[];
  cfg?: EpisodesTextConfig;
}): string[] {
  if (params.isMinimal || !params.availableTools.has("episode_recall")) return [];
  if (!params.activeEpisodeThemes || params.activeEpisodeThemes.length === 0) return [];
  const cfg = params.cfg ?? loadPromptTextConfig().episodes;
  return [
    cfg.activeHeader,
    cfg.activeIntro.replace("{themes}", params.activeEpisodeThemes.join(", ")),
    cfg.activeGuidance,
    "",
  ];
}
