/**
 * Prompt Section — Runtime
 *
 * Builds the "## Runtime" section with environment information.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type { PromptContext } from "../types.js";
import type { RuntimeTextConfig } from "../prompt-config.js";

/**
 * Build the "## Runtime" section with environment information.
 */
export function buildRuntimeSection(
  context: PromptContext,
  cfg?: RuntimeTextConfig,
): string[] {
  if (!cfg) return [];
  return [cfg.header, buildRuntimeLine(context, cfg)];
}

/**
 * Build the runtime summary line from prompt context.
 *
 * Example output:
 * `Runtime: model=gpt-5.2 | provider=openai | channel=telegram | tz=America/New_York`
 */
export function buildRuntimeLine(
  context: PromptContext,
  cfg?: RuntimeTextConfig,
): string {
  const prefix = cfg?.prefix ?? "Runtime:";
  const parts: string[] = [];

  if (context.agentId && context.agentId !== "default") {
    parts.push(`agent=${context.agentId}`);
  }
  if (context.modelId) {
    parts.push(`model=${context.modelId}`);
  }
  if (context.providerId) {
    parts.push(`provider=${context.providerId}`);
  }
  if (context.channelName) {
    parts.push(`channel=${context.channelName}`);
  }
  if (context.sessionType !== "interactive") {
    parts.push(`session=${context.sessionType}`);
  }
  if (context.userTimezone) {
    parts.push(`tz=${context.userTimezone}`);
  }

  return parts.length === 0
    ? `${prefix} default`
    : `${prefix} ${parts.join(" | ")}`;
}
