/**
 * Prompt Section — Response Signals
 *
 * Builds the "## Silent Replies" and "## Heartbeats" sections.
 * All text is driven by PromptTextConfig (loaded from agentforeach.json).
 */

import type {
  SilentRepliesTextConfig,
  HeartbeatsTextConfig,
} from "../prompt-config.js";

/**
 * Build the "## Silent Replies" section.
 */
export function buildSilentRepliesSection(params: {
  show: boolean;
  silentReplyToken: string;
  cfg?: SilentRepliesTextConfig;
}): string[] {
  if (!params.show || !params.cfg) return [];

  const cfg = params.cfg;
  const token = params.silentReplyToken;

  return [
    cfg.header,
    cfg.instruction.replace(/\{token\}/g, token),
    "",
    cfg.rulesHeader,
    ...cfg.rules.map((r) => `- ${r.replace(/\{token\}/g, token)}`),
    "",
  ];
}

/**
 * Build the "## Heartbeats" section.
 */
export function buildHeartbeatsSection(params: {
  show: boolean;
  heartbeatAckToken: string;
  cfg?: HeartbeatsTextConfig;
}): string[] {
  if (!params.show || !params.cfg) return [];

  const cfg = params.cfg;
  const token = params.heartbeatAckToken;

  return [
    cfg.header,
    cfg.instruction,
    token,
    cfg.alertNote.replace(/\{token\}/g, token),
    "",
  ];
}
