/**
 * Prompt Section — Date & Time
 *
 * Builds the "## Current Date & Time" section.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { TimeTextConfig } from "../prompt-config.js";
import { loadPromptTextConfig } from "../prompt-config.js";

/**
 * Build the "## Current Date & Time" section.
 */
export function buildTimeSection(params: {
  currentDateTime?: string;
  userTimezone?: string;
  cfg?: TimeTextConfig;
}): string[] {
  const tz = params.userTimezone?.trim();
  const now = params.currentDateTime?.trim();

  if (!tz && !now) return [];

  const cfg = params.cfg ?? loadPromptTextConfig().time;
  const lines = [cfg.header];
  if (now) lines.push(`Current time: ${now}`);
  if (tz) lines.push(`Time zone: ${tz}`);
  lines.push(cfg.relativeTimeHint, "");
  return lines;
}
