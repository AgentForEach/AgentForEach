/**
 * Prompt Section — Prompt Documents
 *
 * Builds the "# Prompt Documents" section with rendered prompt document data.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { LoadedPromptDoc } from "../types.js";
import { DOC_TYPE_DISPLAY_NAME } from "../types.js";
import type { ProjectContextTextConfig } from "../prompt-config.js";

/**
 * Build the "# Prompt Documents" section with rendered document data.
 */
export function buildProjectContextSection(params: {
  loadedDocs: LoadedPromptDoc[];
  cfg?: ProjectContextTextConfig;
}): string[] {
  if (params.loadedDocs.length === 0) return [];

  const lines: string[] = [];

  if (params.cfg) {
    lines.push(params.cfg.header, "");

    const hasSoul = params.loadedDocs.some((doc) => doc.documentType === "SOUL");

    lines.push(params.cfg.intro);
    if (hasSoul) {
      lines.push(params.cfg.soulInstruction);
    }
    lines.push("");
  }

  for (const doc of params.loadedDocs) {
    const displayName = DOC_TYPE_DISPLAY_NAME[doc.documentType];
    lines.push(`## ${displayName}`, "", doc.content, "");
  }

  return lines;
}
