/**
 * Prompt Section — Knowledge
 *
 * Builds the "## Recalled Knowledge" section.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { KnowledgeTextConfig } from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the "## Recalled Knowledge" section with injected knowledge context.
 */
export function buildKnowledgeSection(params: {
  isMinimal: boolean;
  knowledgeContext?: string;
  cfg?: KnowledgeTextConfig;
}): string[] {
  if (params.isMinimal) return [];

  const content = params.knowledgeContext?.trim();
  if (!content) return [];

  const cfg = params.cfg ?? loadPromptTextConfig().knowledge;
  return [cfg.header, cfg.intro, cfg.trustWarning, content, ""];
}
