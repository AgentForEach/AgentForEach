/**
 * Prompt Section — Recent Session Digests
 *
 * Injects short summaries of recent sessions.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { DigestDocument } from "../../digests/index.js";
import type { RecencyTextConfig } from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the recency section for the system prompt.
 */
export function buildRecencySection(params: {
  isMinimal: boolean;
  recentDigests?: DigestDocument[];
  cfg?: RecencyTextConfig;
}): string[] {
  if (params.isMinimal) return [];
  if (!params.recentDigests || params.recentDigests.length === 0) return [];

  const cfg = params.cfg ?? loadPromptTextConfig().recency;
  const lines: string[] = [cfg.header, cfg.intro, "<recent-activity>"];

  for (const digest of params.recentDigests) {
    const date = digest.createdAt.split("T")[0];
    const topics =
      digest.topics.length > 0 ? ` [${digest.topics.join(", ")}]` : "";
    lines.push(`- ${date}${topics}: ${digest.summary}`);
  }

  lines.push("</recent-activity>");
  lines.push("");

  return lines;
}
